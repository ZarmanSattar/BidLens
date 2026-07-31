const {
  getRawBody,
  getBoundary,
  parseMultipart,
} = require('../../../lib/shredder/multipart')
const { extractPages } = require('../../../lib/shredder/extractPages')

// §7.1 — text extraction for an ATTACHMENT in a multi-file package.
//
//   POST multipart/form-data  (one PDF)
//   -> {filename, raw_text, pages, page_count}
//
// ZERO TOKEN COST, AND THAT IS THE ENTIRE POINT.
//
// /api/analyze calls Groq for every file it is given. Routing a five-file
// package through it would quintuple the analysis cost of an upload, which is
// not what "attach the exhibits" should mean. So the base solicitation still
// goes to /api/analyze exactly as it does today — one Groq call, unchanged —
// and attachments come here, where they are parsed for text and nothing else.
//
// The attachments still reach the AI eventually: their text is concatenated
// into rfps.pages, which is what the shredder and the risk scan read. They
// simply do not each get their own executive summary.
//
// analyze.js is untouched. The multipart and page-extraction helpers are
// imported from lib/shredder, not copied and not modified.

export const config = {
  api: {
    bodyParser: false,
  },
}

export const maxDuration = 60

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const contentLength = Number(req.headers['content-length'])

  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: 'File is too large. Please upload a PDF under 15MB.',
    })
  }

  try {
    const rawBody = await getRawBody(req)
    const boundary = getBoundary(req.headers['content-type'])

    if (!boundary) {
      return res.status(400).json({ error: 'Invalid multipart form data' })
    }

    const { file, filename } = parseMultipart(rawBody, boundary)

    if (!file || file.length === 0) {
      return res.status(400).json({ error: 'Could not extract the uploaded file' })
    }

    if (file.slice(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
      return res.status(400).json({ error: 'Only valid PDF files are supported' })
    }

    const extracted = await extractPages(file)

    const pages = (extracted.pages || []).map((entry) => entry.text)

    if (pages.length === 0) {
      return res.status(400).json({
        error:
          'No text could be extracted from that PDF. It may be a scan with no ' +
          'text layer.',
      })
    }

    // Mirrors how rfps.raw_text relates to rfps.pages: the same document
    // flattened, pages joined by a blank line.
    const rawText = pages.join('\n\n')

    return res.status(200).json({
      filename: filename || 'attachment.pdf',
      raw_text: rawText,
      pages,
      page_count: pages.length,
      // Stated explicitly so no caller has to infer it.
      ai_used: false,
    })
  } catch (err) {
    console.error('[package/extract] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected extraction error',
    })
  }
}
