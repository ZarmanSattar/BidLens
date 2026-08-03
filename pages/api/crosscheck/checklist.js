const { supabaseAdmin } = require('../../../lib/supabase/admin')
const {
  callGroqWithValidation,
  getGroqClient,
} = require('../../../lib/ai/groqHelper')

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
//
// SCOPED TO THE JUDGED FINANCIAL ITEMS. Of the 27 stored items, 22
// (legal/operations/technical) are returned by analyze.js's
// applyVerificationDecision, which ends in an unconditional
// `status: 'ESCALATE'` — no model decides them and no evidence can change
// them. Auditing those was auditing a constant: a second model that read the
// document and answered GO produced a "disagreement" that meant nothing.
//
// Of the 5 financial items, applyFinancialDecision genuinely derives 4 from
// the document (see SCOPED_TASKS). The 5th, Profitability Analysis, is the
// same unconditional-ESCALATE shape as the 22 — it does not even look at the
// source text — so it is excluded here for the same reason and reported by
// name rather than quietly dropped.

// A different family from analyze.js's llama-3.3-70b-versatile, reachable on
// the SAME GROQ_API_KEY — so a genuine second opinion costs no new provider,
// no new key, and no new infrastructure.
const CROSSCHECK_MODEL = 'openai/gpt-oss-120b'
const PRIMARY_MODEL = 'llama-3.3-70b-versatile'

/**
 * How much document text this route may send, and why it is not the whole
 * thing.
 *
 * The old 18000-char cap was analyze.js's, inherited when this route judged
 * all 27 items. It silently truncated from the front: the ODU solicitation
 * states its payment period at character 59,951, so the second model was asked
 * to rule on Payment Terms while holding a copy of the document that did not
 * contain the clause. It could only ever answer "not stated" and disagree.
 *
 * Sending the whole document is not available. The model's context window is
 * not the binding constraint — Groq reports context_window 131,072 for
 * openai/gpt-oss-120b — but this account's rate limit is, and it is far
 * tighter: x-ratelimit-limit-tokens is 8,000 TPM for this model (12,000 for
 * llama-3.3-70b-versatile). The full 117,761-char ODU text measures 32,886
 * tokens, so a whole-document request is rejected 413 before it is ever
 * evaluated. Verified: it was, twice.
 *
 * A flat prefix inside 8,000 TPM is about 20,000 chars, which still stops
 * 40,000 characters short of the payment clause — so no prefix of any legal
 * size fixes the bug this change exists to fix. What fits the budget AND
 * contains the clauses is a set of excerpts chosen by relevance rather than by
 * position, which is what buildExcerpts below does.
 *
 * CHARS_PER_TOKEN is the measured ratio for this document (117,761 chars /
 * 32,886 tokens = 3.58), rounded down for headroom.
 */
const MODEL_TPM_LIMIT = 8000
const COMPLETION_TOKEN_BUDGET = 2200
const CHARS_PER_TOKEN = 3.5

/** Total document characters sent, across all excerpts. */
const EXCERPT_CHAR_BUDGET = 14000

/** Characters kept either side of a keyword hit. */
const WINDOW_BEFORE = 700
const WINDOW_AFTER = 1100

/** Most windows any single item may contribute, before budget trimming. */
const MAX_WINDOWS_PER_ITEM = 4

/**
 * Groq accepts `seed` for this model (verified: POST with seed returns 200).
 * It is best-effort determinism, not a guarantee — the same seed on a
 * different backend build returns a different system_fingerprint and may
 * differ. Paired with temperature 0 it is still the strongest repeatability
 * available here.
 */
const CROSSCHECK_SEED = 7

const CROSSCHECK_DEPARTMENT = 'financial'

/**
 * The financial items analyze.js actually decides from the document, in
 * checklist order, each with the rule applyFinancialDecision applies.
 *
 * Task strings are matched against the STORED item text, so they must stay in
 * step with CHECKLIST_DEFINITIONS.financial in analyze.js. A rename there
 * drops the item out of scope here — which is why an unmatched scoped task is
 * reported in `counts.scope_tasks_not_found` rather than passing silently.
 */
const SCOPED_TASKS = [
  'Payment Terms',
  'Financial Stability',
  'Insurance',
  'Bid Bond',
]

/**
 * Where in the document each scoped item's evidence is likely to be.
 *
 * Deliberately mirrors the aliases and regexes analyze.js matches on for the
 * same items, so both readers are pointed at the same passages and a
 * disagreement is about reading them, not about which ones were found. Broad
 * on purpose — a missed window costs an item its evidence, whereas an extra
 * one only costs budget.
 */
const ITEM_PATTERNS = {
  'payment terms': [
    /\bnet\s*[- ]?\s*\d{1,3}\b/gi,
    /\bprompt\s+pay(?:ment)?\b/gi,
    /\b(?:pay|paid|payment|invoice)[^.\n]{0,80}\bwithin\s+[a-z-]*\s*\(?\d{1,3}\)?\s+(?:calendar\s+|business\s+)?days?\b/gi,
    /\bpayment\s+(?:terms|discounts?|schedule)\b/gi,
    /\binvoic(?:e|ing)\b/gi,
  ],
  'financial stability': [
    /\bfinancial\s+(?:statements?|stability|condition|records?|standing)\b/gi,
    /\baudited\b/gi,
    /\bbalance\s+sheets?\b/gi,
    /\bproof\s+of\s+financial\b/gi,
    /\bdun\s*&?\s*bradstreet\b/gi,
  ],
  insurance: [
    /\binsurance\b/gi,
    /\bliability\s+(?:insurance|coverage|limits?)\b/gi,
    /\bcoverage\s+limits?\b/gi,
    /\baggregate\b/gi,
    /\bcertificate\s+of\s+insurance\b/gi,
  ],
  'bid bond': [
    /\b(?:bid|proposal|performance|payment)\s+bonds?\b/gi,
    /\bsurety\b/gi,
    /\bbonding\b/gi,
  ],
}

/**
 * Financial items the primary does NOT decide from evidence. Sent to no model
 * and counted in no rate; surfaced in the response so the omission is visible.
 */
const UNJUDGED_TASKS = ['Profitability Analysis']

const DEPARTMENTS = ['financial', 'legal', 'operations', 'technical']

const VALID = new Set(['GO', 'ESCALATE', 'NO-GO'])

function normalizeTask(value) {
  return String(value || '').trim().toLowerCase()
}

const SCOPED_TASK_KEYS = SCOPED_TASKS.map(normalizeTask)
const UNJUDGED_TASK_KEYS = new Set(UNJUDGED_TASKS.map(normalizeTask))

// Encodes the SAME rules applyFinancialDecision applies, so a disagreement
// means the two readers found different facts in the document — not that they
// were working to different standards. Generic GO/ESCALATE/NO-GO guidance made
// every difference in house policy look like a factual dispute.
//
// If a threshold changes in analyze.js (NET30, the $5M insurance limit, the 5%
// bond cap), it has to change here too or this route starts reporting noise.
const SYSTEM_PROMPT = `You are a second reviewer auditing the FINANCIAL section of a bid/no-bid compliance checklist that another analyst already completed for a government solicitation, on behalf of a bidder referred to as SPS.

You are given the solicitation text and a numbered list of financial compliance items. Decide each item independently, from the document, applying the EXACT rules below. These are SPS's standing rules — do not substitute your own judgement about what is reasonable.

RULES PER ITEM

"Payment Terms" — find the payment period the solicitation grants (NET terms, or "payment within N days" of an invoice).
  GO       : a payment period of 30 days or fewer is stated.
  ESCALATE : a payment period longer than 30 days is stated, OR payment language exists but no clear number of days can be confirmed, OR the document is silent.
  Note: periods written in words with a numeral, e.g. "within thirty (30) days", count as stated.

"Financial Stability" — decide whether the solicitation REQUIRES financial statements, audited accounts, or other proof of financial standing from the bidder.
  GO       : the document imposes no such requirement. Absence of a requirement is a pass here, not a silence.
  ESCALATE : the document requires financial statements or other proof of financial stability.
  This item is inverted relative to the others: silence is GO.

"Insurance" — find the required coverage limit.
  GO       : a single applicable limit is stated and it is 5,000,000 dollars or less.
  NO-GO    : a single applicable limit is stated and it EXCEEDS 5,000,000 dollars.
  ESCALATE : the limits are tiered, variable, or several different limits apply depending on coverage type or risk tier, OR insurance is required but no limit can be determined, OR the document is silent.

"Bid Bond" — find any proposal, bid, or performance bond requirement.
  GO       : the requirement is defined and manageable — a bond percentage of 5% or less, or a clearly defined dollar threshold or cap — and the language is not ambiguous.
  ESCALATE : a bond percentage above 5%, OR the terms are vague ("to be determined", "at the discretion of", "may require"), OR the document is silent.

GENERAL RULES

1. Decide from the SOLICITATION TEXT ONLY. You are not told the other analyst's verdicts and must not try to guess them.
2. Apply the thresholds above literally. 30 days is GO; 31 days is ESCALATE. 5,000,000 dollars is GO; 5,000,001 is NO-GO.
3. Use NO-GO only where the "Insurance" rule above calls for it. No other item can be NO-GO.
4. Give a one-sentence "reason" quoting or closely paraphrasing the document, and state the number you found. Where the document is silent, say so plainly.
5. You are given EXCERPTS of the solicitation, not the whole document. Each is labelled with its character range and the items it was selected for. The excerpts were chosen by searching the full document for the terms relevant to these four items, so if a term does not appear here it very likely does not appear in the document — but say "not stated in the excerpts provided" rather than asserting the document is silent.
6. Read every excerpt before deciding. A clause may sit in an excerpt selected for a different item.
7. Return exactly one result per item, in the order given, using the same "index".

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "results": [
    { "index": 1, "status": "GO", "reason": "The University will pay within 30 days of receipt of a proper invoice, within the NET30 threshold." },
    { "index": 2, "status": "ESCALATE", "reason": "Cyber liability limits are tiered from $1M to $50M depending on data access level." }
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

/**
 * Splits the flattened checklist into what this route audits and what it does
 * not, preserving checklist order and re-indexing the audited set from 1 so
 * the model's "index" maps to a compact list.
 *
 * `originalIndex` is kept so a caller can still line a row up against the full
 * 27-item checklist.
 */
function scopeItems(items) {
  const inScope = []
  const unjudged = []
  const outOfScope = []

  for (const item of items) {
    if (item.department !== CROSSCHECK_DEPARTMENT) {
      outOfScope.push(item)

      continue
    }

    const key = normalizeTask(item.task)

    if (UNJUDGED_TASK_KEYS.has(key)) {
      unjudged.push(item)

      continue
    }

    if (SCOPED_TASK_KEYS.includes(key)) {
      inScope.push({ ...item, originalIndex: item.index })

      continue
    }

    // A financial item matching neither list: analyze.js grew an item this
    // route has not been taught to audit. Excluded rather than judged under
    // rules that were not written for it.
    unjudged.push(item)
  }

  // Re-index the audited set 1..n.
  inScope.forEach((item, position) => {
    item.index = position + 1
  })

  const scopedFound = new Set(inScope.map((item) => normalizeTask(item.task)))
  const notFound = SCOPED_TASKS.filter(
    (task) => !scopedFound.has(normalizeTask(task))
  )

  return { inScope, unjudged, outOfScope, notFound }
}

/**
 * Selects the passages of the document relevant to the scoped items, within a
 * character budget the account's TPM limit can actually carry.
 *
 * Budget is split evenly across the items rather than first-come, so one
 * chatty topic (insurance, in most solicitations) cannot consume the whole
 * allowance and starve the others of any evidence at all. Windows are merged
 * after selection, so overlapping hits cost their union, not their sum.
 *
 * @returns {{text: string, windows: Array, charsUsed: number,
 *   itemsWithEvidence: string[], itemsWithoutEvidence: string[]}}
 */
function buildExcerpts(sourceText, scopedItems) {
  const perItemBudget = Math.floor(EXCERPT_CHAR_BUDGET / Math.max(1, scopedItems.length))
  const selected = []
  const itemsWithEvidence = []
  const itemsWithoutEvidence = []

  for (const item of scopedItems) {
    const patterns = ITEM_PATTERNS[normalizeTask(item.task)] || []
    const hits = []

    for (const pattern of patterns) {
      // Each regex carries /g and is shared across requests, so lastIndex has
      // to be reset or the second call starts mid-document.
      pattern.lastIndex = 0

      let match

      while ((match = pattern.exec(sourceText)) !== null) {
        hits.push(match.index)

        if (hits.length > 200) break
      }
    }

    if (hits.length === 0) {
      itemsWithoutEvidence.push(item.task)

      continue
    }

    itemsWithEvidence.push(item.task)

    hits.sort((a, b) => a - b)

    let spent = 0

    for (const at of hits) {
      if (spent >= perItemBudget) break

      const start = Math.max(0, at - WINDOW_BEFORE)
      const end = Math.min(sourceText.length, at + WINDOW_AFTER)

      // Skip a hit already covered by a window this item took.
      const covered = selected.some(
        (w) => w.task === item.task && at >= w.start && at <= w.end
      )

      if (covered) continue

      selected.push({ task: item.task, start, end })
      spent += end - start

      if (selected.filter((w) => w.task === item.task).length >= MAX_WINDOWS_PER_ITEM) {
        break
      }
    }
  }

  // Merge across items: two items pointing at the same paragraph should pay
  // for it once.
  selected.sort((a, b) => a.start - b.start)

  const merged = []

  for (const window of selected) {
    const last = merged[merged.length - 1]

    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end)
      if (!last.tasks.includes(window.task)) last.tasks.push(window.task)

      continue
    }

    merged.push({ start: window.start, end: window.end, tasks: [window.task] })
  }

  const text = merged
    .map(
      (w) =>
        `[excerpt @ characters ${w.start}-${w.end} of ${sourceText.length}` +
        ` — relevant to: ${w.tasks.join(', ')}]\n` +
        sourceText.slice(w.start, w.end)
    )
    .join('\n\n...\n\n')

  return {
    text,
    windows: merged,
    charsUsed: merged.reduce((total, w) => total + (w.end - w.start), 0),
    itemsWithEvidence,
    itemsWithoutEvidence,
  }
}

/**
 * Wraps the shared Groq client so this call carries a `seed`.
 *
 * callGroqWithValidation forwards only model/messages/temperature/max_tokens,
 * and it is shared by every AI route in the app — widening its signature for
 * one caller is a bigger change than this route earns. It does expose a
 * `client` override, which is the supported injection point, so the seed is
 * added here and nothing else's behaviour moves.
 */
function seededGroqClient(seed) {
  const base = getGroqClient()

  return {
    chat: {
      completions: {
        create: (params) => base.chat.completions.create({ ...params, seed }),
      },
    },
  }
}

/**
 * Indexes the model's results, reporting duplicates instead of letting a later
 * entry silently replace an earlier one.
 *
 * A model that returns index 3 twice has misunderstood the task; taking the
 * last copy hid that and scored the run as if it were clean.
 */
function indexResults(returned) {
  const byIndex = new Map()
  const duplicateIndexes = []

  for (const entry of returned) {
    if (!entry || typeof entry !== 'object') continue

    const index = Number(entry.index)

    if (!Number.isFinite(index)) continue

    if (byIndex.has(index)) {
      // First answer wins: it is the one produced before the model lost track.
      duplicateIndexes.push(index)

      continue
    }

    byIndex.set(index, entry)
  }

  return { byIndex, duplicateIndexes }
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

    const { inScope, unjudged, outOfScope, notFound } = scopeItems(items)

    if (inScope.length === 0) {
      return res.status(400).json({
        error:
          'This analysis has no evidence-based financial items to cross-check. ' +
          'Only the financial checklist items are decided from the document; ' +
          'the rest are fixed escalations with nothing for a second model to ' +
          'disagree with.',
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

    const excerpts = buildExcerpts(sourceText, inScope)

    if (!excerpts.text) {
      return res.status(400).json({
        error:
          'None of the financial terms this cross-check looks for appear ' +
          'anywhere in the stored document text, so there is nothing for a ' +
          'second model to read.',
        rfp_id: rfpId,
      })
    }

    const userPrompt =
      `SOLICITATION: ${rfp.title || 'Untitled'}\n\n` +
      `--- DOCUMENT EXCERPTS (${excerpts.windows.length} passages, ` +
      `${excerpts.charsUsed} of ${sourceText.length} characters) ---\n` +
      `${excerpts.text}\n\n` +
      `--- FINANCIAL COMPLIANCE ITEMS (${inScope.length}) ---\n` +
      inScope.map((item) => `${item.index}. ${item.task}`).join('\n') +
      `\n\nReturn exactly ${inScope.length} results, one per item, in order.`

    const response = await callGroqWithValidation({
      model: body.model || CROSSCHECK_MODEL,

      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],

      schema: { results: 'array' },
      // Deterministic as far as the provider allows: an audit that returns a
      // different agreement rate on each press is not an audit.
      temperature: 0,
      maxTokens: COMPLETION_TOKEN_BUDGET,
      client: seededGroqClient(CROSSCHECK_SEED),

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
    const { byIndex, duplicateIndexes } = indexResults(returned)

    if (duplicateIndexes.length > 0) {
      console.warn(
        '[crosscheck/checklist] second model returned duplicate indexes:',
        duplicateIndexes.join(', '),
        '- kept the first answer for each'
      )
    }

    let agreed = 0
    let notReviewed = 0

    const comparisons = inScope.map((item) => {
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

    // Denominator is the number of items SENT, fixed before the call, not the
    // number the model happened to answer. Dividing by `reviewed` meant a run
    // where the model skipped its two hardest items scored higher than one
    // where it attempted them and got one wrong — the rate rose as coverage
    // fell. Unanswered items are reported in not_reviewed instead.
    const scoredOutOf = inScope.length

    return res.status(200).json({
      rfp_id: rfpId,
      title: rfp.title || '',
      models: { primary: PRIMARY_MODEL, crosscheck: body.model || CROSSCHECK_MODEL },
      scope: {
        department: CROSSCHECK_DEPARTMENT,
        // Said plainly so a reader does not take this for a whole-checklist
        // audit. The excluded items are not unchecked by oversight; there is
        // nothing in them to check.
        note:
          'Only the financial items analyze.js decides from the document are ' +
          'cross-checked. The other checklist items are fixed escalations ' +
          'that no model produced, so a second opinion on them is meaningless.',
        excluded_unjudged: unjudged.map((item) => ({
          index: item.index,
          department: item.department,
          task: item.task,
          primaryStatus: item.primaryStatus,
        })),
        excluded_out_of_scope: outOfScope.length,
      },
      counts: {
        items_in_checklist: items.length,
        items_in_scope: scoredOutOf,
        scored_out_of: scoredOutOf,
        reviewed,
        agreed,
        disagreed: disagreements.length,
        not_reviewed: notReviewed,
        agreement_rate:
          scoredOutOf > 0 ? Math.round((agreed / scoredOutOf) * 100) : null,
        // Non-empty means SCOPED_TASKS has drifted from analyze.js's
        // CHECKLIST_DEFINITIONS.financial and the scope is quietly narrower
        // than intended.
        scope_tasks_not_found: notFound,
        duplicate_indexes: duplicateIndexes,
      },
      text: {
        chars_total: sourceText.length,
        chars_sent: excerpts.charsUsed,
        strategy: 'relevance-excerpts',
        passages: excerpts.windows.length,
        // The account's 8,000 TPM ceiling for this model makes whole-document
        // review impossible; these two lists say exactly which items got
        // evidence and which did not, so a "not stated" verdict can be read
        // for what it is.
        tpm_limit: MODEL_TPM_LIMIT,
        items_with_evidence: excerpts.itemsWithEvidence,
        items_without_evidence: excerpts.itemsWithoutEvidence,
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
