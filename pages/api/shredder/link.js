const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { linkRequirements } = require('../../../lib/shredder/linkRequirements')

// §4.4 — runs the linking pass for one RFP and persists requirement_links.
//
//   POST application/json  {"rfp_id": "...", "skip_ai": false}
//
// A separate route from /api/shredder/run rather than an extension of it, for
// two reasons:
//
//   1. Linking has to be re-runnable on its own. Re-running run.js re-classifies
//      and APPENDS a second set of REQ numbers — the numbering is deliberately
//      never reassigned — so folding linking into it would make "relink this
//      RFP" cost a duplicate requirement set.
//   2. The two passes fail differently. A failed classification loses rows;
//      a failed link pass loses only links, and the requirements it read are
//      already durable.
//
// The write is idempotent: every existing link whose SOURCE is one of this
// RFP's requirements is deleted first, then the fresh set is inserted. It
// never touches the requirements rows themselves.
//
// skip_ai runs Pass A (structural sub-items) only. That costs no Groq tokens
// and is the safe way to exercise the route.

export const maxDuration = 300

const INSERT_CHUNK_SIZE = 200

export default async function handler(req, res) {
  const requestStart = Date.now()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const rfpId = body.rfp_id || body.rfpId || ''
  const skipAi = body.skip_ai === true || body.skipAi === true

  if (!rfpId) {
    return res.status(400).json({ error: 'rfp_id is required' })
  }

  if (!skipAi && !process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' })
  }

  try {
    // service_role bypasses RLS, so the RFP's existence is confirmed here
    // rather than relying on a policy to do it.
    const { data: rfp, error: rfpError } = await supabaseAdmin
      .from('rfps')
      .select('id')
      .eq('id', rfpId)
      .maybeSingle()

    if (rfpError) {
      return res
        .status(400)
        .json({ error: `Invalid rfp_id: ${rfpError.message}` })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    const { data: requirements, error: readError } = await supabaseAdmin
      .from('requirements')
      .select('id, req_number, requirement_text, page, section, role, confidence')
      .eq('rfp_id', rfpId)

    if (readError) {
      return res
        .status(500)
        .json({ error: `Could not read requirements: ${readError.message}` })
    }

    const rows = requirements || []

    if (rows.length === 0) {
      return res.status(400).json({
        error:
          'This RFP has no classified requirements to link. Run ' +
          'POST /api/shredder/run first.',
        rfp_id: rfpId,
      })
    }

    const { links, stats, aborted } = await linkRequirements(rows, { skipAi })

    console.log(
      '[link]',
      stats.requirements,
      'requirements ->',
      stats.structuralLinks,
      'structural +',
      stats.semanticLinks,
      'semantic =',
      stats.totalLinks,
      'links in',
      Date.now() - requestStart,
      'ms'
    )

    // Idempotent replace. Scoped by requirement_id so it can only ever reach
    // links this RFP owns as the source — a link written by another RFP is
    // not this route's to delete.
    const requirementIds = rows.map((row) => row.id)

    const { error: deleteError } = await supabaseAdmin
      .from('requirement_links')
      .delete()
      .in('requirement_id', requirementIds)

    if (deleteError) {
      return res.status(500).json({
        error: `Could not clear existing links: ${deleteError.message}`,
        rfp_id: rfpId,
      })
    }

    const inserted = []

    for (let index = 0; index < links.length; index += INSERT_CHUNK_SIZE) {
      const slice = links.slice(index, index + INSERT_CHUNK_SIZE)

      const { data, error } = await supabaseAdmin
        .from('requirement_links')
        .insert(slice)
        .select('id, requirement_id, linked_requirement_id, relationship_note')

      if (error) {
        console.error('[link] insert failed:', error.message)

        return res.status(500).json({
          error: `Insert failed after ${inserted.length} links: ${error.message}`,
          rfp_id: rfpId,
          inserted: inserted.length,
        })
      }

      inserted.push(...(data || []))
    }

    return res.status(200).json({
      rfp_id: rfpId,
      inserted: inserted.length,
      // False when the run stopped early — the remaining work requirements
      // were never sent, so "no links" for them means "not asked", not
      // "asked and found nothing".
      complete: !aborted,
      quota: aborted
        ? {
            reason: aborted.reason,
            message: aborted.message,
            retry_after_seconds: Math.ceil(aborted.retryAfterMs / 1000),
            batches_completed: stats.batchesSent,
            batches_planned: stats.plannedBatches,
            batches_not_attempted: aborted.batchesNotAttempted,
            sources_not_attempted: aborted.sourcesNotAttempted,
          }
        : null,
      linking: stats,
    })
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 0)

    console.error('[link] request failed:', {
      status,
      message: error?.message,
    })

    if (status === 429) {
      return res.status(429).json({
        error:
          'Groq rate limit reached. Please wait for the limit to reset and try again.',
      })
    }

    return res.status(500).json({
      error: error?.message || 'Unexpected linking error',
    })
  }
}
