const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { checkBlockers } = require('../../../lib/fit/blockerCheck')
const { computeFitScore } = require('../../../lib/fit/fitScore')
const { loadJudgments } = require('../../../lib/fit/judgmentStore')
const {
  loadCompanyProfile,
  loadWorkRequirements,
} = require('../../../lib/fit/loadFitInputs')
const {
  loadChanges,
  loadStaleJudgments,
  loadAmendmentLinks,
} = require('../../../lib/amendments/amendmentStore')

// §7.4 — the amendment impact view.
//
//   POST application/json  {"rfp_id": "..."}   (either side of the link)
//
// ZERO TOKEN COST. Everything here is a table read plus the existing
// deterministic blocker check. No AI call, and none can be triggered from it.
//
// The question it answers is not "what changed" — requirement_changes already
// says that — but "does what changed alter the decision". So it scores both
// sides with the SAME machinery the Company Fit card uses (checkBlockers +
// computeFitScore over persisted judgments) and reports whether the verdict
// itself moved.

/**
 * Scores one RFP exactly as the Company Fit card would.
 *
 * @param {string} rfpId
 * @param {object|null} profile
 * @returns {Promise<object|null>} null when the RFP has no work requirements.
 */
async function scoreRfp(rfpId, profile) {
  const { requirements } = await loadWorkRequirements(rfpId)

  if (requirements.length === 0) {
    return null
  }

  const { blockers, clear, stats } = checkBlockers(requirements, profile)

  const { judgments: restored } = await loadJudgments(clear, profile?.updated_at)

  const judgments = {}

  clear.forEach((requirement, offset) => {
    const judgment = restored.get(requirement.id)

    if (judgment) {
      judgments[String(offset + 1)] = { ...judgment, index: offset + 1 }
    }
  })

  const fit = computeFitScore({ blockers, blockerStats: stats, judgments })

  return {
    rfp_id: rfpId,
    score: fit.score,
    verdict: fit.verdict,
    provisional: fit.provisional,
    capabilityScore: fit.capabilityScore,
    counts: fit.counts,
    work_requirements: requirements.length,
    judged: Object.keys(judgments).length,
    unjudged: clear.length - Object.keys(judgments).length,
  }
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

  try {
    const { asAmendment, asOriginal, error: linkError } =
      await loadAmendmentLinks(rfpId)

    if (linkError) {
      return res.status(500).json({ error: linkError })
    }

    // Accept either side of the relationship, so the caller does not have to
    // know which one it is holding.
    const amendment = asAmendment || asOriginal[0] || null

    if (!amendment) {
      return res.status(200).json({
        rfp_id: rfpId,
        linked: false,
        message:
          'This RFP is not linked to an amendment. Link one from the ' +
          'amendment view to compare them.',
      })
    }

    const [rfpRows, changesResult, staleResult, profileResult] =
      await Promise.all([
        supabaseAdmin
          .from('rfps')
          .select('id, title, created_at')
          .in('id', [amendment.original_rfp_id, amendment.amended_rfp_id]),
        loadChanges(amendment.id),
        loadStaleJudgments(amendment.id),
        loadCompanyProfile(),
      ])

    if (changesResult.error) {
      return res.status(500).json({ error: changesResult.error })
    }

    const titles = new Map((rfpRows.data || []).map((row) => [row.id, row]))
    const rows = changesResult.rows

    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 }

    for (const row of rows) {
      counts[row.change_type] = (counts[row.change_type] || 0) + 1
    }

    const profile = profileResult.profile

    const [originalFit, amendedFit] = await Promise.all([
      scoreRfp(amendment.original_rfp_id, profile),
      scoreRfp(amendment.amended_rfp_id, profile),
    ])

    // Does the amendment change the ANSWER, not just the text? Only stated
    // when both sides are actually comparable — a provisional score on either
    // side means the capability half is missing and any "flip" would be an
    // artifact of incomplete data, not a real change of position.
    let recommendation = {
      changed: false,
      comparable: false,
      note: 'Not enough judged requirements on both sides to compare the recommendation.',
    }

    if (originalFit && amendedFit) {
      const comparable = !originalFit.provisional && !amendedFit.provisional
      const flipped = originalFit.verdict.key !== amendedFit.verdict.key

      recommendation = {
        comparable,
        changed: comparable && flipped,
        from: originalFit.verdict,
        to: amendedFit.verdict,
        scoreDelta:
          typeof originalFit.score === 'number' && typeof amendedFit.score === 'number'
            ? amendedFit.score - originalFit.score
            : null,
        note: !comparable
          ? 'One or both sides have not been fully judged, so the scores are provisional and the recommendation cannot be compared yet.'
          : flipped
            ? `The bid recommendation CHANGES because of this amendment: ${originalFit.verdict.label} becomes ${amendedFit.verdict.label}.`
            : `The recommendation is unchanged (${amendedFit.verdict.label}), though the score moved.`,
      }
    }

    // Only the interesting rows travel to the client. Unchanged pairs are the
    // bulk of the diff and carry no information a reader needs to see.
    const material = rows
      .filter((row) => row.change_type !== 'unchanged')
      .map((row) => ({
        id: row.id,
        changeType: row.change_type,
        similarity: row.similarity,
        matchMethod: row.match_method,
        original: row.original
          ? {
              reqNumber: row.original.req_number,
              text: row.original.requirement_text,
              page: row.original.page,
              section: row.original.section,
              department: row.original.department,
              role: row.original.role,
            }
          : null,
        amended: row.amended
          ? {
              reqNumber: row.amended.req_number,
              text: row.amended.requirement_text,
              page: row.amended.page,
              section: row.amended.section,
              department: row.amended.department,
              role: row.amended.role,
            }
          : null,
      }))
      // Removals first, then changes, then additions: a requirement that
      // vanished is the one most likely to invalidate work already done.
      .sort((a, b) => {
        const rank = { removed: 0, changed: 1, added: 2 }

        return (
          rank[a.changeType] - rank[b.changeType] ||
          String(a.original?.reqNumber || a.amended?.reqNumber).localeCompare(
            String(b.original?.reqNumber || b.amended?.reqNumber)
          )
        )
      })

    return res.status(200).json({
      linked: true,
      amendment_id: amendment.id,
      original: {
        rfp_id: amendment.original_rfp_id,
        title: titles.get(amendment.original_rfp_id)?.title || null,
        fit: originalFit,
      },
      amended: {
        rfp_id: amendment.amended_rfp_id,
        title: titles.get(amendment.amended_rfp_id)?.title || null,
        fit: amendedFit,
      },
      counts,
      total_compared: rows.length,
      changes: material,
      // §7.4 — judgments the amendment invalidated, derived from the diff
      // rather than stored, so re-running a diff corrects them automatically.
      stale_judgments: staleResult.stale,
      stale_error: staleResult.error,
      recommendation,
      diff_summary: amendment.diff || {},
      has_profile: Boolean(profile),
    })
  } catch (err) {
    console.error('[amendments/compare] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected comparison error',
    })
  }
}
