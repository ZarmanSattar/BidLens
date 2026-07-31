const { checkBlockers } = require('../../../lib/fit/blockerCheck')
const { computeFitScore } = require('../../../lib/fit/fitScore')
const { loadJudgments } = require('../../../lib/fit/judgmentStore')
const {
  loadCompanyProfile,
  loadWorkRequirements,
} = require('../../../lib/fit/loadFitInputs')

// §6.2/§6.4 — hard blocker checks and the blocker-only fit score.
//
//   POST application/json  {"rfp_id": "..."}
//
// ZERO TOKEN COST. This route makes no AI call of any kind, which is why the
// card is allowed to hit it on page load the same way ContractRiskCard hits
// /api/risk/scan. The AI half lives at /api/fit/judge and only ever runs from
// a button.
//
// Nothing is persisted. The check is pure over (requirements, profile), so
// re-deriving it on view is cheap and a stored copy would go stale the moment
// someone edits the company profile.

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

  try {
    const { profile, error: profileError } = await loadCompanyProfile()

    if (profileError) {
      return res
        .status(500)
        .json({ error: `Could not read the company profile: ${profileError}` })
    }

    const { requirements, error: requirementsError } =
      await loadWorkRequirements(rfpId)

    if (requirementsError) {
      return res
        .status(400)
        .json({ error: `Invalid rfp_id: ${requirementsError}` })
    }

    const { blockers, clear, stats } = checkBlockers(requirements, profile)

    // Saved §6.3 judgments for the CURRENT profile. Reading them here is what
    // makes persistence visible: without it a reload would show "not assessed"
    // while the database held 83 verdicts, and the user would have to re-spend
    // tokens to see a score they had already paid for. Still zero tokens — this
    // is a table read, and a stale-profile judgment is simply not returned.
    const { judgments: restored, error: restoreError } = await loadJudgments(
      clear,
      profile?.updated_at
    )

    const judgments = {}

    clear.forEach((requirement, offset) => {
      const judgment = restored.get(requirement.id)

      if (judgment) {
        judgments[String(offset + 1)] = { ...judgment, index: offset + 1 }
      }
    })

    const fit = computeFitScore({ blockers, blockerStats: stats, judgments })

    return res.status(200).json({
      rfp_id: rfpId,
      judgments,
      progress: {
        total: clear.length,
        judged: restored.size,
        remaining: clear.length - restored.size,
        restored: restored.size,
        complete: clear.length > 0 && restored.size >= clear.length,
      },
      // Surfaced rather than thrown: the blocker half is still completely
      // valid, and a card that renders it with a note beats an error page.
      judgments_error: restoreError,
      // A profile that has not been filled in is reported plainly rather than
      // as an error: the honest answer is "nothing could be checked", and the
      // UI needs to say that instead of showing a reassuring zero.
      has_profile: Boolean(profile),
      blockers,
      // Count only — the requirement rows themselves are not returned. The
      // client has no use for them, and /api/fit/judge re-derives its own
      // population server-side rather than trusting a client to send one back.
      clear_count: clear.length,
      fit,
      stats,
      requirements_total: requirements.length,
    })
  } catch (err) {
    console.error('[fit/blockers] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected blocker-check error',
    })
  }
}
