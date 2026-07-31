const { checkBlockers } = require('../../../lib/fit/blockerCheck')
const { computeFitScore } = require('../../../lib/fit/fitScore')
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

    const fit = computeFitScore({ blockers, blockerStats: stats })

    return res.status(200).json({
      rfp_id: rfpId,
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
