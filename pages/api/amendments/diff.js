const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { diffRequirements } = require('../../../lib/amendments/diffRequirements')
const {
  ensureAmendment,
  saveChanges,
  carryForwardJudgments,
} = require('../../../lib/amendments/amendmentStore')

// §7.3 — link an amended RFP to its original and diff their requirements.
//
//   POST application/json  {"original_rfp_id": "...", "amended_rfp_id": "..."}
//
// ZERO TOKEN COST. The matcher is pure string comparison and measured at 99%+
// classification accuracy against the real 222-requirement dataset, so no AI
// pass exists here at all — not even an opt-in one. Spending ~20,000 tokens to
// be told that 200 sentences are byte-identical would be a poor trade.
//
// Both RFPs must already be shredded. This route deliberately does NOT shred:
// /api/shredder/run costs real quota and has its own confirmation flow, and
// silently triggering it from a "compare these two" action would spend the
// user's allowance without asking.

export const maxDuration = 60

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const originalRfpId = body.original_rfp_id || body.originalRfpId || ''
  const amendedRfpId = body.amended_rfp_id || body.amendedRfpId || ''

  if (!originalRfpId || !amendedRfpId) {
    return res
      .status(400)
      .json({ error: 'original_rfp_id and amended_rfp_id are both required' })
  }

  if (originalRfpId === amendedRfpId) {
    return res
      .status(400)
      .json({ error: 'An RFP cannot be an amendment of itself.' })
  }

  try {
    const { data: rfps, error: rfpError } = await supabaseAdmin
      .from('rfps')
      .select('id, title')
      .in('id', [originalRfpId, amendedRfpId])

    if (rfpError) {
      return res.status(400).json({ error: `Invalid rfp ids: ${rfpError.message}` })
    }

    const found = new Map((rfps || []).map((row) => [row.id, row]))

    if (!found.has(originalRfpId) || !found.has(amendedRfpId)) {
      return res.status(404).json({
        error: 'One or both of those RFPs do not exist.',
      })
    }

    // Requirements are compared across ALL roles, not just work_requirement:
    // an amendment that changes a submission deadline or an evaluation weight
    // matters just as much as one that changes scope.
    const [originalRows, amendedRows] = await Promise.all([
      supabaseAdmin
        .from('requirements')
        .select('id, req_number, requirement_text, page, section, role, department')
        .eq('rfp_id', originalRfpId),
      supabaseAdmin
        .from('requirements')
        .select('id, req_number, requirement_text, page, section, role, department')
        .eq('rfp_id', amendedRfpId),
    ])

    if (originalRows.error || amendedRows.error) {
      return res.status(400).json({
        error: (originalRows.error || amendedRows.error).message,
      })
    }

    const originals = originalRows.data || []
    const amended = amendedRows.data || []

    if (originals.length === 0 || amended.length === 0) {
      return res.status(400).json({
        error:
          'Both RFPs must be shredded before they can be compared. ' +
          `The original has ${originals.length} requirement(s) and the ` +
          `amendment has ${amended.length}. Run the shredder on whichever is empty.`,
        original_requirements: originals.length,
        amended_requirements: amended.length,
      })
    }

    const { amendment, error: linkError } = await ensureAmendment(
      originalRfpId,
      amendedRfpId
    )

    if (linkError) {
      return res.status(409).json({ error: linkError })
    }

    const { changes, stats } = diffRequirements(originals, amended, {
      forceFullRestatement: body.force_full_restatement === true,
    })

    const { saved, error: saveError } = await saveChanges(amendment.id, changes, {
      ...stats,
      original_title: found.get(originalRfpId).title,
      amended_title: found.get(amendedRfpId).title,
      generated_at: new Date().toISOString(),
    })

    if (saveError) {
      return res.status(500).json({
        error: `The diff was computed but could not be saved: ${saveError}`,
        stats,
      })
    }

    // §7.4 — unchanged requirements inherit the original's fit verdict, so an
    // amendment only costs tokens for what actually changed.
    const carry = await carryForwardJudgments(amendment.id)

    return res.status(200).json({
      amendment_id: amendment.id,
      original_rfp_id: originalRfpId,
      amended_rfp_id: amendedRfpId,
      original_title: found.get(originalRfpId).title,
      amended_title: found.get(amendedRfpId).title,
      changes_saved: saved,
      stats,
      carry_forward: {
        carried: carry.carried,
        // Unchanged requirements whose original was never judged — nothing to
        // inherit, so they stay unjudged rather than being invented.
        skipped: carry.skipped,
        error: carry.error,
      },
      message: stats.partialAmendment
        ? `This looks like a partial addendum (${amended.length} requirements ` +
          `against the original's ${originals.length}), so requirements it ` +
          `simply does not mention were NOT treated as deletions. ` +
          `${stats.suppressedRemovals} were left alone.`
        : null,
    })
  } catch (err) {
    console.error('[amendments/diff] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected diff error',
    })
  }
}
