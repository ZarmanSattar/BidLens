const { checkBlockers } = require('../../../lib/fit/blockerCheck')
const { judgeFit } = require('../../../lib/fit/judgeFit')
const { computeFitScore } = require('../../../lib/fit/fitScore')
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
// The blocker pass is RE-RUN here rather than accepted from the request body.
// It is deterministic and takes no measurable time, so re-deriving it is
// cheaper than trusting the client — and it guarantees the requirements the
// model judges are exactly the ones this server decided were not already
// blocked. A client could otherwise ask for judgments on requirements that
// were disqualified, and pay tokens for the privilege.

export const maxDuration = 60

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
        stats: { requirements: 0, judged: 0, aiUsed: false },
        degraded: false,
        message:
          'Every work requirement is already blocked by a hard check, so ' +
          'there was nothing left to judge and no AI call was made.',
      })
    }

    const {
      judgments,
      stats: judgeStats,
      error: judgeError,
    } = await judgeFit(clear, profile)

    // A failed judgment pass is NOT a failed request. The card renders the
    // blockers and the blocker-only score either way, so this returns 200 with
    // an empty map and says what went wrong, rather than an error status the
    // UI would have to treat as fatal. The one exception is a rate limit,
    // which the caller should be able to distinguish so it can tell the user
    // to wait.
    if (judgeError && judgeError.status === 429) {
      return res.status(429).json({
        error:
          'Groq rate limit reached. The blocker checks above are unaffected — ' +
          'wait for the limit to reset and try the fit judgment again.',
        rfp_id: rfpId,
        judgments: {},
        stats: judgeStats,
      })
    }

    return res.status(200).json({
      rfp_id: rfpId,
      // Keyed by 1-based position in the unblocked set, not by row id — see
      // judgeFit's contract. Each entry carries its own req_number, so the
      // client never has to reconstruct that ordering.
      judgments,
      fit: computeFitScore({ blockers, blockerStats: stats, judgments }),
      blockers,
      stats: judgeStats,
      // True when the call did not produce judgments. The blockers are still
      // complete; only the soft half is missing.
      degraded: Boolean(judgeError),
      message: judgeError ? judgeError.message : null,
    })
  } catch (err) {
    console.error('[fit/judge] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected fit judgment error',
    })
  }
}
