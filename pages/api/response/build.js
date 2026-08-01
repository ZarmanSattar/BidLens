const { buildSkeletons } = require('../../../lib/response/buildSkeletons')
const {
  loadCoverableRequirements,
} = require('../../../lib/response/coverage')
const {
  loadLibrary,
  loadSkeletons,
  loadRequirementChanges,
  evaluateStaleness,
  saveSkeletons,
} = require('../../../lib/response/skeletonStore')

// §8.3 — draft response skeletons for one RFP's requirements.
//
//   POST application/json  {"rfp_id": "..."}
//
// Opt-in and token-costing, mirroring /api/fit/judge exactly. Nothing on a
// page load reaches it; /api/skeletons/coverage stays free and automatic.
//
// RESUMABLE FROM THE START. Every batch is written before the next call, and
// every request begins by loading what already exists and drafting only what
// is missing OR stale. A run stopped by the rate limit costs nothing already
// earned, and pressing the button again continues rather than restarting —
// the property Module 2 had to learn the hard way.
//
// A STALE skeleton is re-drafted, not skipped. That is the difference between
// resume and "already done": a draft whose library entry was edited, or whose
// requirement an amendment reworded, is exactly the one worth spending tokens
// on again.

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
    const { entries: library, latestUpdatedAt, error: libraryError } =
      await loadLibrary()

    if (libraryError) {
      return res
        .status(500)
        .json({ error: `Could not read the content library: ${libraryError}` })
    }

    // Drafting against an empty library would spend tokens to produce 109
    // placeholders saying "supply this". Refused before the call, not after —
    // the same guard /api/fit/judge applies to a missing company profile.
    if (library.length === 0) {
      return res.status(400).json({
        error:
          'The content library is empty, so there is nothing for a draft to ' +
          'be built from. Add entries to the content library first.',
        rfp_id: rfpId,
      })
    }

    const { requirements, error: requirementsError } =
      await loadCoverableRequirements(rfpId)

    if (requirementsError) {
      return res
        .status(400)
        .json({ error: `Invalid rfp_id: ${requirementsError}` })
    }

    if (requirements.length === 0) {
      return res.status(400).json({
        error:
          'This RFP has no work requirements or evaluation factors to respond ' +
          'to. Shred it first.',
        rfp_id: rfpId,
      })
    }

    const [{ skeletons: existing, error: existingError }, { changed }] =
      await Promise.all([
        loadSkeletons(requirements),
        loadRequirementChanges(requirements),
      ])

    if (existingError) {
      return res.status(500).json({
        error: `Could not read existing skeletons: ${existingError}`,
      })
    }

    const libraryById = new Map(library.map((entry) => [entry.id, entry]))

    // Missing OR stale is what needs work. A current draft is left alone.
    const pending = requirements.filter((requirement) => {
      const skeleton = existing.get(requirement.id)

      if (!skeleton) {
        return true
      }

      return evaluateStaleness(skeleton, libraryById, changed).stale
    })

    const alreadyCurrent = requirements.length - pending.length

    if (pending.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        skeletons: {},
        progress: {
          total: requirements.length,
          drafted: requirements.length,
          remaining: 0,
          restored: alreadyCurrent,
          drafted_this_call: 0,
          complete: true,
        },
        stats: { requirements: 0, drafted: 0, aiUsed: false },
        degraded: false,
        message:
          'Every requirement already has a current draft. Nothing was stale, ' +
          'so no AI call was made.',
      })
    }

    let saved = 0
    let saveError = null

    const {
      skeletons,
      stats,
      error: buildError,
    } = await buildSkeletons(pending, library, {
      // Written as each batch lands. The library stamp is captured ONCE for
      // the whole run, so a library edited mid-run correctly leaves the
      // earlier batches marked stale rather than silently blessed.
      // `meta.model`, NOT `stats.model`: this hook runs DURING the call below,
      // so the `stats` binding this statement declares is still in its temporal
      // dead zone and reading it throws — silently, because the hook's errors
      // are caught and logged by buildSkeletons. That is what made every batch
      // fail to save while the run still reported 109/109 drafted.
      onBatch: async (batch, meta) => {
        const result = await saveSkeletons(batch, latestUpdatedAt, meta?.model)

        saved += result.saved

        if (result.error) {
          saveError = result.error
        }
      },
    })

    // What the model produced in memory. NOT the same thing as what exists in
    // the database, which is the entire point of everything below.
    const generated = Object.keys(skeletons).length

    // THE SOURCE OF TRUTH. Re-read what is actually stored and re-apply the
    // same currency test `pending` used above, so "drafted" means "this
    // requirement has a current draft ON DISK" — the same number
    // /api/skeletons/coverage will report on the next page load. Deriving it
    // from the in-memory `skeletons` object is what let a run where every
    // single write failed still report 109 of 109 drafted.
    const { skeletons: persisted, error: verifyError } =
      await loadSkeletons(requirements)

    if (verifyError) {
      return res.status(500).json({
        error:
          'Drafts were generated but the saved count could not be verified: ' +
          verifyError,
        rfp_id: rfpId,
        stats,
      })
    }

    const draftedTotal = requirements.filter((requirement) => {
      const skeleton = persisted.get(requirement.id)

      return skeleton && !evaluateStaleness(skeleton, libraryById, changed).stale
    }).length

    const remaining = requirements.length - draftedTotal

    // A draft that was produced but never reached the table. saveSkeletons
    // reports its own failures through `saveError`, but a hook that THROWS is
    // caught and logged inside buildSkeletons and never sets it — which is
    // exactly how the temporal-dead-zone bug stayed silent through eleven
    // batches. Comparing produced against written catches that whole class of
    // failure without depending on the error channel working.
    const unsavedDrafts = Math.max(0, generated - saved)

    const progress = {
      total: requirements.length,
      drafted: draftedTotal,
      remaining,
      restored: alreadyCurrent,
      // What this call actually WROTE, and what it produced. When the two
      // disagree, something between the model and the table went wrong.
      drafted_this_call: saved,
      generated_this_call: generated,
      saved,
      unsaved: unsavedDrafts,
      complete: remaining <= 0,
    }

    // A rate limit reached before anything new landed is the one case the
    // caller should be able to distinguish, so it can say to wait.
    if (buildError && buildError.status === 429 && stats.drafted === 0) {
      return res.status(429).json({
        error:
          'Groq rate limit reached before any new draft could be written. ' +
          'Anything already saved is unaffected — wait for the limit to reset ' +
          'and press the button again to continue.',
        rfp_id: rfpId,
        progress,
        stats,
      })
    }

    // Generation succeeding while persistence fails is a FAILED run, not a
    // degraded one. It used to return 200 with the error tucked into a message
    // field the caller could ignore; now it cannot be mistaken for success.
    if (saveError || unsavedDrafts > 0) {
      const detail = saveError
        ? `The write was rejected: ${saveError}`
        : `${unsavedDrafts} generated draft(s) never reached the database. ` +
          'Check the server log for "[response/build] onBatch hook failed" or ' +
          '"[response/store] batch write".'

      console.error('[response/build] PERSISTENCE FAILURE —', detail)

      return res.status(500).json({
        error: `Drafts were generated but not saved. ${detail}`,
        save_error: saveError || null,
        unsaved_drafts: unsavedDrafts,
        rfp_id: rfpId,
        skeletons,
        progress,
        stats,
        degraded: true,
      })
    }

    return res.status(200).json({
      rfp_id: rfpId,
      skeletons,
      progress,
      stats,
      degraded: Boolean(buildError) || remaining > 0,
      message: buildError?.message || null,
    })
  } catch (err) {
    console.error('[response/build] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected generation error',
    })
  }
}
