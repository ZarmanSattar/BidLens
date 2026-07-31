const {
  loadCoverableRequirements,
  computeCoverage,
  SKELETON_ROLES,
} = require('../../../lib/response/coverage')
const {
  loadLibrary,
  loadSkeletons,
  loadRequirementChanges,
  evaluateStaleness,
} = require('../../../lib/response/skeletonStore')

// §8.4 — response coverage for one RFP.
//
//   POST application/json  {"rfp_id": "..."}
//
// ZERO TOKEN COST. Table reads and arithmetic. No AI here and none reachable
// from it — generation lives behind /api/response/build and a button.
//
// "Covered" means CURRENT, not merely present. A draft whose library entry was
// edited, whose cited entry was deleted, or whose requirement an amendment
// reworded is counted as work still to do, because that is what it is. The
// three rules come from §8.2 and are evaluated live; nothing is stored.

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

    const [
      { skeletons, error: skeletonError },
      { entries: library, error: libraryError },
      { changed },
    ] = await Promise.all([
      loadSkeletons(requirements),
      loadLibrary(),
      loadRequirementChanges(requirements),
    ])

    if (skeletonError) {
      return res.status(500).json({
        error: `Could not read response skeletons: ${skeletonError}`,
      })
    }

    const libraryById = new Map(library.map((entry) => [entry.id, entry]))

    // Split what exists into current and stale. Only current counts as covered.
    const current = new Map()
    const stale = []

    const byRequirement = new Map(requirements.map((row) => [row.id, row]))

    for (const [requirementId, skeleton] of skeletons) {
      const verdict = evaluateStaleness(skeleton, libraryById, changed)

      if (!verdict.stale) {
        current.set(requirementId, skeleton)

        continue
      }

      const requirement = byRequirement.get(requirementId)

      stale.push({
        requirementId,
        reqNumber: skeleton.req_number || requirement?.req_number || null,
        department: requirement?.department || null,
        reasons: verdict.reasons,
        detail: verdict.detail,
        updatedAt: skeleton.updated_at,
      })
    }

    const coverage = computeCoverage(requirements, current)

    return res.status(200).json({
      rfp_id: rfpId,
      ...coverage,
      // Present but no longer trustworthy. Counted in `missing`, because
      // that is the work the build button will actually redo.
      stale: stale.length,
      staleItems: stale,
      library_entries: library.length,
      library_error: libraryError,
      // Generation exists now. The card uses this to decide whether to offer
      // the button at all.
      generation_available: library.length > 0,
      progress: {
        total: coverage.total,
        drafted: coverage.covered,
        remaining: coverage.missing,
        restored: coverage.covered,
        complete: coverage.total > 0 && coverage.missing === 0,
      },
      note:
        coverage.total === 0
          ? 'This RFP has no work requirements or evaluation factors to respond to. Shred it first.'
          : library.length === 0
            ? 'The content library is empty, so a draft would have nothing of yours to build from. Add library entries before generating.'
            : null,
      roles_counted: SKELETON_ROLES,
    })
  } catch (err) {
    console.error('[skeletons/coverage] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected coverage error',
    })
  }
}
