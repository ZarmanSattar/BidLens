const { checkBlockers } = require('../../../lib/fit/blockerCheck')
const { judgeFit } = require('../../../lib/fit/judgeFit')
const { computeFitScore } = require('../../../lib/fit/fitScore')
const { loadJudgments, saveJudgments } = require('../../../lib/fit/judgmentStore')
const {
  loadCompanyProfile,
  loadWorkRequirements,
} = require('../../../lib/fit/loadFitInputs')

// §6.3 — AI soft-fit judgment for one RFP's unblocked work requirements.
//
//   POST application/json  {"rfp_id": "..."}
//
// Separate from /api/fit/blockers on purpose, mirroring how /api/risk/explain
// is kept apart from /api/risk/scan: that route stays free and automatic, this
// one costs tokens and only ever runs when someone presses a button. Nothing
// on a page load can reach it.
//
// RESUMABLE. ~20,000 tokens of work does not fit in a 12,000-token rolling
// window, so a run reliably stops part-way. Every batch is written to
// fit_judgments as it completes, and every call starts by loading what is
// already there and judging ONLY the remainder. Pressing the button again
// therefore walks forward through the document instead of re-spending the
// window on answers we already have.
//
// Stored judgments are trusted only when they were made against the CURRENT
// company profile — see fit_judgments.judged_against_profile_updated_at. Edit
// the profile and every verdict is stale by definition, because "can do" is a
// claim about the company, not about the RFP.
//
// The blocker pass is RE-RUN here rather than accepted from the request body.
// It is deterministic and takes no measurable time, so re-deriving it is
// cheaper than trusting the client — and it guarantees the requirements the
// model judges are exactly the ones this server decided were not blocked.

export const maxDuration = 60

/**
 * Re-keys judgments against the full unblocked list.
 *
 * judgeFit keys by position in the list IT was given, which is only the
 * not-yet-judged remainder. Consumers (fitScore, the card) need positions in
 * the full `clear` list, so the join goes through requirementId.
 *
 * @param {Array<object>} clear Every unblocked requirement, in order.
 * @param {Map<string, object>} byRequirementId
 * @returns {Object<string, object>}
 */
function keyByPosition(clear, byRequirementId) {
  const judgments = {}

  clear.forEach((requirement, offset) => {
    const judgment = byRequirementId.get(requirement.id)

    if (judgment) {
      judgments[String(offset + 1)] = { ...judgment, index: offset + 1 }
    }
  })

  return judgments
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const rfpId = body.rfp_id || body.rfpId || ''

  if (!rfpId) {
    return res.status(400).json({ error: 'rfp_id is required' })
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' })
  }

  try {
    const { profile, error: profileError } = await loadCompanyProfile()

    if (profileError) {
      return res
        .status(500)
        .json({ error: `Could not read the company profile: ${profileError}` })
    }

    // Judging against an empty profile would spend tokens to be told, 84
    // times, that nothing is on file. Refused before the call, not after.
    if (!profile) {
      return res.status(400).json({
        error:
          'No company profile exists yet, so there is nothing to judge fit ' +
          'against. Fill in the company profile first.',
        rfp_id: rfpId,
      })
    }

    const profileStamp = profile.updated_at

    const { requirements, error: requirementsError } =
      await loadWorkRequirements(rfpId)

    if (requirementsError) {
      return res
        .status(400)
        .json({ error: `Invalid rfp_id: ${requirementsError}` })
    }

    if (requirements.length === 0) {
      return res.status(400).json({
        error:
          'This RFP has no work requirements to judge. Shred it first, so ' +
          'there are classified requirements to assess.',
        rfp_id: rfpId,
      })
    }

    const { blockers, clear, stats } = checkBlockers(requirements, profile)

    if (clear.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        judgments: {},
        fit: computeFitScore({ blockers, blockerStats: stats }),
        progress: { total: 0, judged: 0, remaining: 0, restored: 0, judged_this_call: 0, complete: true },
        stats: { requirements: 0, judged: 0, aiUsed: false },
        degraded: false,
        message:
          'Every work requirement is already blocked by a hard check, so ' +
          'there was nothing left to judge and no AI call was made.',
      })
    }

    // ---- what do we already have, for THIS profile? ----
    const { judgments: restored, error: restoreError } = await loadJudgments(
      clear,
      profileStamp
    )

    if (restoreError) {
      // A read failure means we cannot tell what is already judged. Judging
      // everything again would be correct but expensive, and silently doing so
      // is exactly the surprise this route exists to remove.
      return res.status(500).json({
        error: `Could not read saved fit judgments: ${restoreError}`,
        rfp_id: rfpId,
      })
    }

    const pending = clear.filter((requirement) => !restored.has(requirement.id))

    const byRequirementId = new Map(restored)

    // Everything already judged against the current profile — nothing to spend.
    if (pending.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        judgments: keyByPosition(clear, byRequirementId),
        fit: computeFitScore({
          blockers,
          blockerStats: stats,
          judgments: keyByPosition(clear, byRequirementId),
        }),
        blockers,
        progress: {
          total: clear.length,
          judged: restored.size,
          remaining: 0,
          restored: restored.size,
          judged_this_call: 0,
          complete: true,
        },
        stats: { requirements: clear.length, judged: 0, aiUsed: false },
        degraded: false,
        message:
          'Every unblocked requirement already has a saved judgment for the ' +
          'current company profile. No AI call was made.',
      })
    }

    let saved = 0
    let saveError = null

    const {
      judgments: freshByIndex,
      stats: judgeStats,
      error: judgeError,
    } = await judgeFit(pending, profile, {
      // Written as each batch lands, not at the end — a run that dies at batch
      // 3 must keep batches 1 and 2. Same principle as the shredder's
      // per-batch insert.
      onBatch: async (batchJudgments) => {
        const result = await saveJudgments(batchJudgments, profileStamp)

        saved += result.saved

        if (result.error) {
          saveError = result.error
        }
      },
    })

    for (const judgment of Object.values(freshByIndex)) {
      byRequirementId.set(judgment.requirementId, judgment)
    }

    const judgments = keyByPosition(clear, byRequirementId)
    const judgedTotal = Object.keys(judgments).length

    // A failed judgment pass is NOT a failed request. The card renders the
    // blockers, the restored judgments, and the blocker-only score either way.
    // The one exception is a rate limit reached before ANYTHING new landed,
    // which the caller should be able to distinguish so it can say to wait.
    if (judgeError && judgeError.status === 429 && judgeStats.judged === 0) {
      return res.status(429).json({
        error:
          'Groq rate limit reached before any new requirement could be judged. ' +
          'Anything already saved is unaffected — wait for the limit to reset ' +
          'and press the button again to continue.',
        rfp_id: rfpId,
        judgments,
        fit: computeFitScore({ blockers, blockerStats: stats, judgments }),
        progress: {
          total: clear.length,
          judged: judgedTotal,
          remaining: clear.length - judgedTotal,
          restored: restored.size,
          judged_this_call: 0,
          complete: false,
        },
        stats: judgeStats,
      })
    }

    return res.status(200).json({
      rfp_id: rfpId,
      judgments,
      fit: computeFitScore({ blockers, blockerStats: stats, judgments }),
      blockers,
      // Real progress across every click, not just this one. `remaining` is
      // what the button should offer to continue with.
      progress: {
        total: clear.length,
        judged: judgedTotal,
        remaining: clear.length - judgedTotal,
        restored: restored.size,
        judged_this_call: judgeStats.judged,
        saved,
        complete: judgedTotal >= clear.length,
      },
      stats: judgeStats,
      // True when this call did not produce everything it was asked for. The
      // blockers and any restored judgments are still complete.
      degraded: Boolean(judgeError) || judgedTotal < clear.length,
      message:
        judgeError?.message ||
        (saveError
          ? `Judgments were generated but could not all be saved (${saveError}). ` +
            'They are shown below, but a reload may lose them.'
          : null),
    })
  } catch (err) {
    console.error('[fit/judge] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected fit judgment error',
    })
  }
}
