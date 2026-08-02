const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { classifyRequirements } = require('../../../lib/shredder/classifyRequirements')

// Retry the rows a previous shred could not classify.
//
//   POST application/json  {"rfp_id": "..."}
//
// COSTS TOKENS, and only on an explicit click.
//
// THIS IS NOT A RE-SHRED. /api/shredder/run extracts candidates and INSERTS a
// fresh set of REQ numbers, which is why the UI only ever offers it on an
// empty RFP — running it twice produces a duplicate requirement set. This
// route never inserts, never deletes, and never touches req_number. It reads
// the rows that already exist and carry a classification_error, asks the
// classifier about those rows only, and UPDATES them in place.
//
// Consequences worth stating plainly:
//   - A row that classified successfully is never re-read, re-priced, or
//     re-decided. Its verdict is left exactly as it was.
//   - REQ numbering is untouched, so links, notes, and anything else keyed on
//     REQ-nnn stay valid across a retry.
//   - An RFP with no failed rows is a no-op that costs nothing.

const MAX_RETRY_ROWS = 400

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
    // ONLY the failed rows. The filter is the safety property: a fully
    // successful RFP selects nothing here and this route can do nothing to it.
    const { data: failed, error: readError } = await supabaseAdmin
      .from('requirements')
      .select('id, req_number, requirement_text, page, section')
      .eq('rfp_id', rfpId)
      .not('classification_error', 'is', null)
      .order('req_number', { ascending: true })
      .limit(MAX_RETRY_ROWS)

    if (readError) {
      return res.status(400).json({
        error: `Could not read the failed requirements: ${readError.message}`,
      })
    }

    if (!failed || failed.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        retried: 0,
        recovered: 0,
        still_failing: 0,
        message: 'Nothing to retry — every requirement on this RFP is classified.',
      })
    }

    // The classifier takes candidates in the shape the filter produces, which
    // is exactly what these columns hold. The row id is carried alongside so
    // each result can be written back to the row it came from.
    const candidates = failed.map((row) => ({
      text: row.requirement_text,
      page: row.page,
      section: row.section,
    }))

    const { results, stats } = await classifyRequirements(candidates, {
      model: body.model || undefined,
    })

    let recovered = 0
    let stillFailing = 0
    let writeError = null

    for (let index = 0; index < failed.length; index += 1) {
      const row = failed[index]
      const result = results[index]

      if (!result) {
        stillFailing += 1

        continue
      }

      // requirement_text is deliberately NOT in this update. The extracted
      // text was correct all along; only the classification of it failed, and
      // rewriting the text on a retry is how a good row would get corrupted.
      const { error: updateError } = await supabaseAdmin
        .from('requirements')
        .update({
          role: result.role ?? null,
          department: result.department ?? null,
          confidence: result.confidence ?? null,
          needs_review: result.needsReview === true,
          classification_error: result.classificationError ?? null,
        })
        .eq('id', row.id)

      if (updateError) {
        writeError = updateError.message
        stillFailing += 1

        continue
      }

      if (result.classificationError) stillFailing += 1
      else recovered += 1
    }

    console.log(
      '[shredder/reclassify]',
      failed.length,
      'retried,',
      recovered,
      'recovered,',
      stillFailing,
      'still failing'
    )

    return res.status(200).json({
      rfp_id: rfpId,
      retried: failed.length,
      recovered,
      still_failing: stillFailing,
      truncated: failed.length === MAX_RETRY_ROWS,
      write_error: writeError,
      stats,
      message:
        recovered === failed.length
          ? `All ${recovered} previously failed requirement(s) are now classified.`
          : recovered === 0
            ? `None of the ${failed.length} row(s) could be classified this time. ` +
              'Nothing was changed for the worse — they remain exactly as they were.'
            : `${recovered} of ${failed.length} recovered. ${stillFailing} still need a retry.`,
    })
  } catch (err) {
    console.error('[shredder/reclassify] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected retry error',
    })
  }
}
