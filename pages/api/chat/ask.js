const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { callGroqWithValidation } = require('../../../lib/ai/groqHelper')

// A1 — "Chat with this RFP". One question, one answer, grounded in the stored
// text of ONE rfp.
//
//   POST application/json  {"rfp_id": "...", "question": "..."}
//
// COSTS TOKENS, and only ever on an explicit send. Nothing on a page load
// reaches this route — same rule /api/fit/judge and /api/response/build follow.
//
// The whole document is NOT sent. rfps.pages is one string per page, so the
// question is matched against pages by plain word overlap first (zero tokens,
// no embeddings, no extra table) and only the best few pages travel. A 44-page
// solicitation would otherwise be ~60,000 tokens per question, which is not a
// sane price for "when is this due?".
//
// Page numbers are the point. The model is handed pages already labelled, and
// is told to cite the labels — so an answer can always be checked against the
// document rather than trusted.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile'

/** How many pages of context travel with one question. */
const MAX_CONTEXT_PAGES = 6

/** Per-page cap, so one enormous page cannot crowd out the others. */
const PAGE_CHARS = 2200

/** Words too common to tell one page from another. */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'but', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have', 'how', 'i',
  'if', 'in', 'is', 'it', 'its', 'me', 'must', 'my', 'no', 'not', 'of', 'on',
  'or', 'our', 's', 'shall', 'she', 'should', 'so', 'that', 'the', 'their',
  'them', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

const SYSTEM_PROMPT = `You answer questions about ONE government solicitation, using ONLY the pages of that document supplied to you.

Rules, in order of importance:

1. Use ONLY the supplied pages. Do not use general knowledge about RFPs, procurement, or what documents like this usually say. If the pages do not contain the answer, say so.
2. When the pages do not answer the question, set "found" to false and put a short, plain explanation in "answer" — for example "The supplied pages do not state a page limit." Do NOT guess, do NOT infer what is "typical", and do NOT pad the answer with general advice.
3. Cite every page you used in "pages", as numbers, exactly as labelled in the context (the "PAGE n" markers). Cite only pages you actually drew on. Never cite a page number that was not supplied to you.
4. Quote or closely paraphrase the document's own wording. Where the document is conditional or ambiguous, say that rather than resolving it.
5. Be brief. Two or three sentences is usually right. This is a bid team reading fast, not an essay.

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "found": true,
  "answer": "Proposals are due 2:00 PM EST on 16 June 2026, and late proposals are returned unopened.",
  "pages": [12, 13]
}`

/**
 * Significant words in a question, lowercased and de-duplicated.
 *
 * @param {string} question
 * @returns {string[]}
 */
function keywordsOf(question) {
  const words = String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))

  return [...new Set(words)]
}

/**
 * Ranks pages by how many of the question's words they contain.
 *
 * Deliberately crude. It is a filter, not a search engine: the model still
 * reads what it is given, and sending the six best pages instead of all
 * forty-four is where the cost saving lives.
 *
 * @param {string[]} pages One string per page, index 0 = page 1.
 * @param {string[]} keywords
 * @returns {Array<{page: number, text: string, score: number}>}
 */
function rankPages(pages, keywords) {
  const scored = pages.map((text, index) => {
    const haystack = String(text || '').toLowerCase()

    let score = 0

    for (const word of keywords) {
      if (haystack.includes(word)) {
        // Repeated mentions matter, but sub-linearly — one page saying
        // "insurance" nine times should not bury the page that defines it.
        score += 1 + Math.min(3, haystack.split(word).length - 2) * 0.25
      }
    }

    return { page: index + 1, text: String(text || ''), score }
  })

  const hits = scored.filter((entry) => entry.score > 0 && entry.text.trim())

  // No word matched anything — fall back to the opening pages, which is where
  // dates, contacts and scope usually sit.
  const chosen =
    hits.length > 0
      ? [...hits].sort((a, b) => b.score - a.score).slice(0, MAX_CONTEXT_PAGES)
      : scored.filter((entry) => entry.text.trim()).slice(0, MAX_CONTEXT_PAGES)

  // Back into document order, so the model reads them the way they were written.
  return chosen.sort((a, b) => a.page - b.page)
}

/**
 * Renders the selected pages with the labels the model must cite.
 *
 * @param {Array<{page: number, text: string}>} selected
 * @returns {string}
 */
function buildContext(selected) {
  return selected
    .map(
      (entry) =>
        `--- PAGE ${entry.page} ---\n` +
        String(entry.text).replace(/\s+/g, ' ').trim().slice(0, PAGE_CHARS)
    )
    .join('\n\n')
}

export const maxDuration = 60

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const rfpId = body.rfp_id || body.rfpId || ''
  const question = String(body.question || '').trim()

  if (!rfpId) {
    return res.status(400).json({ error: 'rfp_id is required' })
  }

  if (!question) {
    return res.status(400).json({ error: 'A question is required' })
  }

  if (question.length > 500) {
    return res.status(400).json({
      error: 'That question is too long. Keep it under 500 characters.',
    })
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' })
  }

  try {
    const { data: rfp, error } = await supabaseAdmin
      .from('rfps')
      .select('id, title, raw_text, pages')
      .eq('id', rfpId)
      .maybeSingle()

    if (error) {
      return res.status(400).json({ error: `Invalid rfp_id: ${error.message}` })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    // Same fidelity ordering the shredder and the risk scan use: the pages
    // column carries real page numbers, flat raw_text cannot.
    let pages
    let textSource

    if (Array.isArray(rfp.pages) && rfp.pages.length > 0) {
      pages = rfp.pages
      textSource = 'pages_column'
    } else if (typeof rfp.raw_text === 'string' && rfp.raw_text.trim()) {
      // One "page" covering the whole document. Citations will all say page 1,
      // which is honest — the boundaries genuinely were not preserved.
      pages = [rfp.raw_text]
      textSource = 'raw_text_flat'
    } else {
      return res.status(400).json({
        error:
          'This RFP has no stored text to search. It was uploaded before the ' +
          'document text was captured.',
        rfp_id: rfpId,
      })
    }

    const keywords = keywordsOf(question)
    const selected = rankPages(pages, keywords)
    const context = buildContext(selected)

    const response = await callGroqWithValidation({
      model: body.model || DEFAULT_MODEL,

      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Document: ${rfp.title || 'Untitled solicitation'}\n` +
            `You have been given ${selected.length} of ${pages.length} pages, ` +
            `selected by keyword match against the question.\n\n` +
            `${context}\n\n` +
            `QUESTION: ${question}`,
        },
      ],

      schema: { found: 'boolean', answer: 'string', pages: 'array' },
      temperature: 0.1,
      maxTokens: 700,

      // A failed call answers nothing rather than inventing something.
      fallback: () => ({
        found: false,
        answer:
          'The answer could not be generated just now. Nothing was read from ' +
          'the document, so please ask again rather than treating this as a ' +
          '"not in the document" result.',
        pages: [],
      }),
    })

    const data = response.data || {}
    const suppliedPages = new Set(selected.map((entry) => entry.page))

    // A cited page that was never supplied is the model inventing a source.
    // Dropped rather than shown, because the whole value of the citation is
    // that the reader can turn to it.
    const cited = (Array.isArray(data.pages) ? data.pages : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && suppliedPages.has(value))
      .sort((a, b) => a - b)

    return res.status(200).json({
      rfp_id: rfpId,
      question,
      found: data.found !== false,
      answer: String(data.answer || '').trim(),
      pages: cited,
      // What the reader needs to judge the answer's reach: which pages were
      // actually searched, out of how many.
      context: {
        pages_supplied: selected.map((entry) => entry.page),
        pages_total: pages.length,
        text_source: textSource,
        keywords,
      },
      degraded: Boolean(response.usedFallback),
    })
  } catch (err) {
    console.error('[chat/ask] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected error answering that question',
    })
  }
}
