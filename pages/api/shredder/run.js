const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { extractPages } = require('../../../lib/shredder/extractPages')
const { findCandidates } = require('../../../lib/shredder/candidateFilter')
const {
  classifyRequirements,
} = require('../../../lib/shredder/classifyRequirements')
const {
  getRawBody,
  getBoundary,
  parseMultipart,
} = require('../../../lib/shredder/multipart')

// §4.3 — runs §4.1 -> §4.2 for one RFP and persists the result.
//
// Accepts either:
//   POST application/json      {"rfp_id": "..."}   - text from the rfps row
//   POST multipart/form-data   rfp_id + PDF part   - text re-parsed from PDF
//
// The JSON form reads rfps.pages, which stores the document one string per
// page and therefore carries real page numbers and intact table-column gaps.
// It falls back to rfps.raw_text only for RFPs uploaded before that column
// existed: raw_text is cleanText(pdfParse().text), which joins pages with the
// same "\n\n" that separates paragraphs and collapses runs of spaces, so
// neither page boundaries nor column gaps survive it. Measured on the 44-page
// ODU fixture: 213 "\n\n" breaks for 43 real page joins, and 4,836 column
// gaps reduced to zero. Rows extracted that way carry page: null and never
// match on table structure.
//
// The response's text_source says which of the three was used.
//
// REQ numbers are assigned at insert time and never reassigned. A re-run
// appends, continuing from the highest existing number for that RFP, so
// numbers already handed out stay pinned to their requirement.

export const config = {
  api: {
    bodyParser: false,
  },
}

export const maxDuration = 300

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // 15MB, matching analyze.js
const INSERT_CHUNK_SIZE = 200
const REQ_PREFIX = 'REQ-'
const REQ_PAD = 3

/**
 * Formats a sequential REQ number: 1 -> "REQ-001".
 *
 * @param {number} sequence
 * @returns {string}
 */
function formatReqNumber(sequence) {
  return `${REQ_PREFIX}${String(sequence).padStart(REQ_PAD, '0')}`
}

/**
 * Finds the highest REQ number already issued for an RFP.
 *
 * Existing numbers are never reused or renumbered, so a re-run continues the
 * sequence instead of colliding with the unique (rfp_id, req_number) index.
 *
 * @param {string} rfpId
 * @returns {Promise<number>} 0 when the RFP has no requirements yet.
 */
async function getHighestSequence(rfpId) {
  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select('req_number')
    .eq('rfp_id', rfpId)

  if (error) {
    throw new Error(`Could not read existing requirements: ${error.message}`)
  }

  let highest = 0

  for (const row of data || []) {
    const match = /(\d+)\s*$/.exec(String(row?.req_number || ''))

    if (match) {
      highest = Math.max(highest, Number(match[1]))
    }
  }

  return highest
}

/**
 * Rounds a confidence to the numeric(3,2) the requirements table declares.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toStoredConfidence(value) {
  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    return null
  }

  return Math.round(Math.max(0, Math.min(1, numeric)) * 100) / 100
}

export default async function handler(req, res) {
  const requestStart = Date.now()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' })
  }

  const contentLength = Number(req.headers['content-length'])

  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: 'File is too large. Please upload a PDF under 15MB.',
    })
  }

  try {
    const boundary = getBoundary(req.headers['content-type'])
    const rawBody = await getRawBody(req)

    let rfpId = ''
    let file = null

    if (boundary) {
      const parsed = parseMultipart(rawBody, boundary)

      file = parsed.file
      rfpId = parsed.fields.rfp_id || parsed.fields.rfpId || ''

      if (!file || file.length === 0) {
        return res.status(400).json({
          error: 'Could not extract the uploaded file',
        })
      }

      if (file.slice(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
        return res.status(400).json({
          error: 'Only valid PDF files are supported',
        })
      }
    } else {
      let body

      try {
        body = JSON.parse(rawBody.toString('utf8') || '{}')
      } catch {
        return res.status(400).json({
          error:
            'Send JSON {"rfp_id":"..."}, or multipart/form-data with a PDF ' +
            'file part for page-accurate results',
        })
      }

      rfpId = body?.rfp_id || body?.rfpId || ''
    }

    if (!rfpId) {
      return res.status(400).json({ error: 'rfp_id is required' })
    }

    // The insert uses service_role, which bypasses RLS, so the RFP's
    // existence is confirmed here rather than relying on a policy to do it.
    // raw_text comes back in the same round trip for the JSON path.
    const { data: rfp, error: rfpError } = await supabaseAdmin
      .from('rfps')
      .select('id, raw_text, pages')
      .eq('id', rfpId)
      .maybeSingle()

    if (rfpError) {
      return res.status(400).json({ error: `Invalid rfp_id: ${rfpError.message}` })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    // §4.1 - plain code, no AI.
    //
    // Three input sources, in descending fidelity:
    //
    //   pdf          re-parsed from an uploaded file  - full fidelity
    //   pages_column rfps.pages, one string per page  - full fidelity
    //   raw_text_flat rfps.raw_text                   - no page numbers, no
    //                                                   table-row signal
    //
    // raw_text is cleanText(pdfParse().text): pages are joined with the same
    // "\n\n" that separates paragraphs and runs of spaces are collapsed, so
    // neither page boundaries nor table-column gaps survive it. rfps.pages
    // preserves both and is the reason the JSON path no longer has to give
    // up page numbers. Flat raw_text remains only for RFPs uploaded before
    // that column existed.
    let filterInput
    let numPages = null
    let textSource

    if (file) {
      const extracted = await extractPages(file)

      filterInput = extracted.pages
      numPages = extracted.numPages
      textSource = 'pdf'
    } else if (Array.isArray(rfp.pages) && rfp.pages.length > 0) {
      // The page number is the 1-based array index — that is the whole reason
      // the column stores bare strings rather than {page, text} objects.
      filterInput = rfp.pages.map((text, index) => ({
        page: index + 1,
        text: String(text || ''),
      }))

      numPages = rfp.pages.length
      textSource = 'pages_column'
    } else {
      const rawText =
        typeof rfp.raw_text === 'string' ? rfp.raw_text.trim() : ''

      if (!rawText) {
        return res.status(400).json({
          error:
            'This RFP has no stored text. It was uploaded before the text ' +
            'was captured — re-send this request as multipart/form-data ' +
            'with the PDF file part.',
          rfp_id: rfpId,
        })
      }

      filterInput = rawText
      textSource = 'raw_text_flat'
    }

    const candidates = findCandidates(filterInput)

    console.log('[shredder] source', textSource + ',', numPages ?? '?', 'pages,',
      candidates.length, 'candidates in', Date.now() - requestStart, 'ms')

    if (candidates.length === 0) {
      return res.status(200).json({
        rfp_id: rfpId,
        text_source: textSource,
        pages: numPages,
        candidates: 0,
        inserted: 0,
        requirements: [],
        message: 'No requirement candidates were found in this document',
      })
    }

    // §4.2 - AI classification in batches.
    const { results, stats, aborted } = await classifyRequirements(candidates)

    // A rate-limit abort with nothing classified means there is no work to
    // keep — say so plainly instead of writing a run that contains nothing.
    if (aborted && results.length === 0) {
      return res.status(429).json({
        error:
          'Groq quota exhausted before any requirements could be classified. ' +
          `Retry in about ${Math.ceil(aborted.retryAfterMs / 60000)} minute(s).`,
        rfp_id: rfpId,
        retry_after_seconds: Math.ceil(aborted.retryAfterMs / 1000),
        candidates: candidates.length,
        inserted: 0,
      })
    }

    console.log('[shredder] classified', stats.total, 'candidates in',
      stats.batches, 'batches (', stats.failedBatches, 'failed ) at',
      Date.now() - requestStart, 'ms')

    // §4.3 - permanent numbering, then persist.
    const startSequence = await getHighestSequence(rfpId)

    const rows = results.map((result, offset) => ({
      rfp_id: rfpId,
      req_number: formatReqNumber(startSequence + offset + 1),
      requirement_text: result.text,
      page: result.page ?? null,
      section: result.section ?? null,
      role: result.role ?? null,
      department: result.department ?? null,
      confidence: toStoredConfidence(result.confidence),
      // A degraded row carries confidence 0, which means "never classified",
      // not "classified with low certainty" — classification_error is what
      // tells those apart after the fact.
      needs_review: result.needsReview === true,
      classification_error: result.classificationError ?? null,
    }))

    const inserted = []

    for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
      const slice = rows.slice(index, index + INSERT_CHUNK_SIZE)

      const { data, error } = await supabaseAdmin
        .from('requirements')
        .insert(slice)
        .select(
        'id, req_number, page, section, role, department, confidence, ' +
          'needs_review, classification_error'
      )

      if (error) {
        // Report what did land rather than pretending the run was atomic —
        // the numbers already issued stay issued.
        console.error('[shredder] insert failed:', error.message)

        return res.status(500).json({
          error: `Insert failed after ${inserted.length} rows: ${error.message}`,
          rfp_id: rfpId,
          inserted: inserted.length,
        })
      }

      inserted.push(...(data || []))
    }

    console.log('[shredder] inserted', inserted.length, 'requirements in',
      Date.now() - requestStart, 'ms')

    return res.status(200).json({
      rfp_id: rfpId,
      // 'pdf' and 'pages_column' are full fidelity. 'raw_text_flat' means
      // page numbers are null on every row and the table-row signal was
      // unavailable.
      text_source: textSource,
      pages: numPages,
      candidates: candidates.length,
      inserted: inserted.length,
      first_req_number: rows[0]?.req_number || null,
      last_req_number: rows[rows.length - 1]?.req_number || null,
      // False when the run stopped early — the requirement set is partial and
      // the remaining candidates were never sent, not classified and failed.
      complete: !aborted,
      quota: aborted
        ? {
            reason: aborted.reason,
            message: aborted.message,
            retry_after_seconds: Math.ceil(aborted.retryAfterMs / 1000),
            batches_completed: stats.batches,
            batches_planned: stats.plannedBatches,
            batches_not_attempted: aborted.batchesNotAttempted,
            candidates_not_attempted: aborted.candidatesNotAttempted,
          }
        : null,
      classification: stats,
      needs_review: results.filter((result) => result.needsReview).length,
      requirements: inserted,
    })
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 0)

    console.error('[shredder] request failed:', {
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
      error: error?.message || 'Unexpected shredder error',
    })
  }
}
