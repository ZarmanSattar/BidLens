const { supabaseAdmin } = require('../../../lib/supabase/admin')
const { callGroqWithValidation } = require('../../../lib/ai/groqHelper')

// B2 — a second model re-decides the compliance checklist, and disagreements
// are reported.
//
//   POST application/json  {"rfp_id": "..."}
//
// COSTS TOKENS, and only on an explicit click. Nothing on a page load reaches
// this route — the same contract /api/fit/judge, /api/response/build and
// /api/chat/ask keep.
//
// SECOND OPINION, NOT A REPLACEMENT. The stored verdicts are never modified.
// This route reads them, asks a DIFFERENT model the same questions about the
// same document, and returns where the two disagree. Nothing is written back:
// a disagreement is information for a human, not a new answer to trust.
//
// The item set comes from the STORED ANALYSIS, not from a list kept here.
// analyze.js applies a fixed 27-item rubric to every RFP, so reading the task
// names back off the saved result guarantees both models are judging exactly
// the same items in the same order. A list duplicated here could drift out of
// step with that rubric and would make the disagreement count meaningless.

// A different family from analyze.js's llama-3.3-70b-versatile, reachable on
// the SAME GROQ_API_KEY — so a genuine second opinion costs no new provider,
// no new key, and no new infrastructure.
const CROSSCHECK_MODEL = 'openai/gpt-oss-120b'
const PRIMARY_MODEL = 'llama-3.3-70b-versatile'

/** Same ceiling analyze.js applies to the text it reasons over. */
const MAX_RFP_TEXT_LENGTH = 18000

const DEPARTMENTS = ['financial', 'legal', 'operations', 'technical']

const VALID = new Set(['GO', 'ESCALATE', 'NO-GO'])

const SYSTEM_PROMPT = `You are a second reviewer auditing a bid/no-bid compliance checklist that another analyst already completed for a government solicitation.

You are given the solicitation text and a numbered list of compliance items. For EACH item, decide independently:

  "GO"       - the solicitation clearly satisfies this item on terms a bidder can accept.
  "ESCALATE" - the solicitation is silent, ambiguous, unusual, or onerous on this item, so a human must look.
  "NO-GO"    - the solicitation contains something on this item that disqualifies a bid outright.

Rules:

1. Decide from the SOLICITATION TEXT ONLY. You are not told the other analyst's verdicts, and you must not try to guess them. Judge the document.
2. "Not stated in the document" is ESCALATE, never GO. Silence is not compliance.
3. NO-GO is rare. Reserve it for something genuinely disqualifying, not merely unfavourable.
4. Give a one-sentence "reason" quoting or closely paraphrasing the document. Where the document is silent, say so plainly.
5. Return exactly one result per item, in the order given, using the same "index".

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "results": [
    { "index": 1, "status": "GO", "reason": "Payment terms are NET 30 from receipt of a proper invoice." },
    { "index": 2, "status": "ESCALATE", "reason": "The document does not mention financial statements." }
  ]
}`

/**
 * Flattens the stored checklist into an ordered, indexed item list.
 *
 * @param {object} checklist analyses.result.complianceChecklist
 * @returns {Array<{index: number, department: string, task: string,
 *   primaryStatus: string, primaryReason: string}>}
 */
function flattenChecklist(checklist) {
  const items = []

  for (const department of DEPARTMENTS) {
    for (const item of checklist?.[department] || []) {
      items.push({
        index: items.length + 1,
        department,
        task: String(item?.task || '').trim(),
        primaryStatus: String(item?.status || '').trim().toUpperCase(),
        primaryReason: String(item?.reason || '').trim(),
      })
    }
  }

  return items
}

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
    const [{ data: rfp, error: rfpError }, { data: analysisRows, error: analysisError }] =
      await Promise.all([
        supabaseAdmin.from('rfps').select('id, title, raw_text').eq('id', rfpId).maybeSingle(),
        supabaseAdmin
          .from('analyses')
          .select('id, result, created_at')
          .eq('rfp_id', rfpId)
          .order('created_at', { ascending: false })
          .limit(1),
      ])

    if (rfpError || analysisError) {
      return res.status(400).json({
        error: `Could not load this RFP: ${(rfpError || analysisError).message}`,
      })
    }

    if (!rfp) {
      return res.status(404).json({ error: 'No RFP found for that rfp_id' })
    }

    const analysis = (analysisRows || [])[0]

    if (!analysis) {
      return res.status(400).json({
        error:
          'This RFP has no saved analysis to cross-check. Run the analysis first.',
        rfp_id: rfpId,
      })
    }

    const items = flattenChecklist(analysis.result?.complianceChecklist)

    if (items.length === 0) {
      return res.status(400).json({
        error: 'The saved analysis has no compliance checklist to cross-check.',
        rfp_id: rfpId,
      })
    }

    const sourceText = String(rfp.raw_text || '').trim()

    if (!sourceText) {
      return res.status(400).json({
        error:
          'This RFP has no stored text, so a second opinion would have nothing ' +
          'to read. It was uploaded before the document text was captured.',
        rfp_id: rfpId,
      })
    }

    const userPrompt =
      `SOLICITATION: ${rfp.title || 'Untitled'}\n\n` +
      `--- DOCUMENT TEXT ---\n${sourceText.slice(0, MAX_RFP_TEXT_LENGTH)}\n\n` +
      `--- COMPLIANCE ITEMS (${items.length}) ---\n` +
      items
        .map((item) => `${item.index}. [${item.department}] ${item.task}`)
        .join('\n') +
      `\n\nReturn exactly ${items.length} results, one per item, in order.`

    const response = await callGroqWithValidation({
      model: body.model || CROSSCHECK_MODEL,

      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],

      schema: { results: 'array' },
      temperature: 0.1,
      maxTokens: Math.max(2000, items.length * 90),

      fallback: () => ({ results: [] }),
    })

    if (response.usedFallback) {
      return res.status(502).json({
        error:
          'The second model did not return a usable response, so no ' +
          'cross-check was produced. Nothing was changed.',
        rfp_id: rfpId,
      })
    }

    const returned = Array.isArray(response.data?.results) ? response.data.results : []
    const byIndex = new Map(
      returned
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => [Number(entry.index), entry])
    )

    let agreed = 0
    let notReviewed = 0

    const comparisons = items.map((item) => {
      const entry = byIndex.get(item.index)
      const secondStatus = String(entry?.status || '').trim().toUpperCase()

      // A status the second model did not return, or returned in a shape that
      // is not one of the three verdicts, is NOT counted as a disagreement.
      // Silence from the auditor is not evidence against the original.
      if (!entry || !VALID.has(secondStatus)) {
        notReviewed += 1

        return {
          ...item,
          secondStatus: null,
          secondReason: null,
          agrees: null,
        }
      }

      const agrees = secondStatus === item.primaryStatus

      if (agrees) agreed += 1

      return {
        ...item,
        secondStatus,
        secondReason: String(entry.reason || '').trim(),
        agrees,
      }
    })

    const disagreements = comparisons.filter((row) => row.agrees === false)

    // Disagreements where the second model is HARSHER are the ones worth
    // reading first — an item the original passed that a second reader would
    // stop on is the expensive kind of miss.
    const severity = { 'NO-GO': 0, ESCALATE: 1, GO: 2 }

    disagreements.sort(
      (a, b) =>
        severity[a.secondStatus] - severity[b.secondStatus] ||
        a.index - b.index
    )

    const reviewed = comparisons.length - notReviewed

    return res.status(200).json({
      rfp_id: rfpId,
      title: rfp.title || '',
      models: { primary: PRIMARY_MODEL, crosscheck: body.model || CROSSCHECK_MODEL },
      counts: {
        items: items.length,
        reviewed,
        agreed,
        disagreed: disagreements.length,
        not_reviewed: notReviewed,
        agreement_rate: reviewed > 0 ? Math.round((agreed / reviewed) * 100) : null,
      },
      disagreements,
      comparisons,
      // Nothing was written. Said explicitly because a reader seeing a
      // disagreement list will reasonably wonder whether it changed anything.
      stored: false,
    })
  } catch (err) {
    console.error('[crosscheck/checklist] request failed:', err?.message)

    return res.status(500).json({
      error: err?.message || 'Unexpected cross-check error',
    })
  }
}
