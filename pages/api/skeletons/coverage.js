const {
  loadCoverableRequirements,
  loadSkeletons,
  computeCoverage,
  SKELETON_ROLES,
} = require('../../../lib/response/coverage')

// §8.4 — response coverage for one RFP.
//
//   POST application/json  {"rfp_id": "..."}
//
// ZERO TOKEN COST. Two table reads and some arithmetic. There is no AI in this
// route and none can be reached from it — §8.3's generation pass is Part 2.
//
// Until then this correctly reports 0 covered of N. That is the honest answer,
// not a placeholder: the table is real, the query is real, and the number will
// move on its own the moment Part 2 writes its first skeleton.

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
    const { requirements, error: requirementsError } =
      await loadCoverableRequirements(rfpId)

    if (requirementsError) {
      return res
        .status(400)
        .json({ error: `Invalid rfp_id: ${requirementsError}` })
    }

    const { skeletons, error: skeletonError } = await loadSkeletons(requirements)

    if (skeletonError) {
      return res.status(500).json({
        error: `Could not read response skeletons: ${skeletonError}`,
      })
    }

    const coverage = computeCoverage(requirements, skeletons)

    return res.status(200).json({
      rfp_id: rfpId,
      ...coverage,
      // Stated so the UI never has to guess why everything is uncovered.
      generation_available: false,
      note:
        coverage.total === 0
          ? 'This RFP has no work requirements or evaluation factors to respond to. Shred it first.'
          : 'Response generation (§8.3) is not built yet, so nothing has been drafted. This counter reads the real table and will update itself once generation lands.',
      roles_counted: SKELETON_ROLES,
    })
  } catch (err) {
    console.error('[skeletons/coverage] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected coverage error',
    })
  }
}
