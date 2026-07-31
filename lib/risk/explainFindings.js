const { callGroqWithValidation } = require('../ai/groqHelper');
const { estimateExplainTokens } = require('./explainCost');

// §5.3 — plain-language explanations for findings §5.1/§5.2 already detected.
//
// Strictly a layer ON TOP of detection. It never decides whether something is
// a risk, never adds or removes a finding, and never re-reads the document.
// scanContractRisk stays provably zero-token: this module is not imported by
// it, and nothing here can run unless a caller asks for it explicitly.
//
// ONE batched call for the whole scan. The alternative — a call per finding —
// re-sends the system prompt N times to answer N questions that all share the
// same framing, and gives the model no view of the other findings. Batching
// costs roughly a third as much and produces explanations that read as one
// assessment rather than N disconnected ones.
//
// Everything degrades. The helper already turns unusable content into the
// fallback rather than throwing, and the transport failures it DOES throw are
// caught here. A caller that gets nothing back still has every finding and
// every static description — the explanation is an enhancement, never a
// dependency.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Prose, not classification, so slightly above the 0.1 the extraction modules
// use — but still low enough to stay anchored to the evidence.
const DEFAULT_TEMPERATURE = 0.2;

// Evidence budget per finding. Two snippets is enough to ground an
// explanation; more mostly repeats the same clause in different words.
const SNIPPETS_PER_FINDING = 2;
const SNIPPET_CHARS = 220;
const DESCRIPTION_CHARS = 260;

// Hard ceiling on one call. No realistic document approaches it (the ODU RFP
// produces 3), but an unbounded batch would silently become an unbounded
// prompt. Beyond this the most severe findings are explained and the rest are
// reported as unexplained rather than quietly dropped.
const MAX_FINDINGS_PER_CALL = 30;

const MAX_EXPLANATION_CHARS = 400;

// Mirrors classifyRequirements: the helper's own uncertainty flagging only
// reaches TOP-LEVEL keys, and batching puts confidence one level down inside
// `explanations`, so the same rule is applied per item here.
const CONFIDENCE_THRESHOLD = 0.7;

const BATCH_SCHEMA = {
  explanations: 'array',
};

const SYSTEM_PROMPT = `You are helping a contractor understand risks that have ALREADY been found in a solicitation by a separate, deterministic scanner. You are NOT the detector.

For each numbered finding you are given, write ONE short plain-language explanation of what it means for this bidder in practice.

WHAT TO WRITE:
- 1-2 sentences. Under 45 words. Plain business English, no legalese.
- Say what the practical consequence is for the bidder, and where useful the single most important thing to check or do about it.
- Ground it in the EVIDENCE text you are shown. Refer to what the document actually says.

WHAT NOT TO WRITE:
- Do NOT restate or paraphrase the "Reference note" you are given. The reader can already see it. Add what it does not say.
- Do NOT give legal advice, quote statutes, or state legal conclusions. Say "have counsel confirm" rather than asserting what the law requires.
- Do NOT question whether the finding is real, or argue it is not a risk. Detection is not your job.
- Do NOT invent contract values, dates, page numbers, party names, or dollar amounts that are not in the evidence.
- Do NOT use markdown, bullets, headings, or bold.

If the evidence is too thin to say anything specific, write one sentence saying what the reviewer should look for in the document instead. Never leave an explanation blank.

Also give "confidence": 0 to 1, how well the evidence supported what you wrote. Use a LOW value when you had to stay generic.

Return one object per finding, with "index" matching the finding's number, for EVERY finding, in order.

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "explanations": [
    {
      "index": 1,
      "explanation": "The University can end the contract at any time without you being at fault, so recovery is limited to work already done. Do not hire or reserve capacity against the full five-year value.",
      "confidence": 0.9
    }
  ]
}`;

/**
 * Collapses whitespace and trims to a budget.
 *
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
function clip(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Renders one finding for the prompt.
 *
 * Sends the finding's identity, its static reference note, and a little
 * evidence — not the whole document, and not the finding's internal id, which
 * the model has no use for and would only be tempted to echo back mangled.
 *
 * @param {object} finding
 * @param {number} number 1-based position in the batch.
 * @returns {string}
 */
function renderFinding(finding, number) {
  const lines = [`Finding ${number}:`];

  lines.push(`Risk: ${finding.label} — ${finding.title}`);
  lines.push(`Severity: ${finding.severity}`);

  if (finding.clause) {
    lines.push(`Clause: ${finding.system || ''} ${finding.clause}`.trim());
  }

  if (Array.isArray(finding.clauses) && finding.clauses.length > 0) {
    lines.push(`Clauses: ${finding.clauses.join(', ')}`);
  }

  lines.push(`Reference note (do not repeat): ${clip(finding.description, DESCRIPTION_CHARS)}`);

  const matches = Array.isArray(finding.matches)
    ? finding.matches.slice(0, SNIPPETS_PER_FINDING)
    : [];

  if (matches.length === 0) {
    lines.push('Evidence: none captured.');
  } else {
    matches.forEach((match, offset) => {
      const page = match.page ? ` (page ${match.page})` : '';
      const detail = match.detail ? ` [detected value: ${match.detail}]` : '';

      lines.push(
        `Evidence ${offset + 1}${page}${detail}: ${clip(match.snippet, SNIPPET_CHARS)}`
      );
    });
  }

  return lines.join('\n');
}

/**
 * @param {Array<object>} batch
 * @returns {string}
 */
function buildUserPrompt(batch) {
  const body = batch
    .map((finding, offset) => renderFinding(finding, offset + 1))
    .join('\n\n');

  return (
    `Explain the following ${batch.length} finding(s) from one solicitation. ` +
    `Return exactly ${batch.length} explanation object(s).\n\n${body}`
  );
}

/**
 * Validates one entry from the model's response.
 *
 * @param {unknown} entry
 * @returns {{explanation: string, confidence: number, needsReview: boolean}|null}
 *   null when the entry is unusable, which leaves that finding unexplained
 *   rather than showing an empty bubble.
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const explanation = clip(entry.explanation, MAX_EXPLANATION_CHARS);

  if (!explanation) {
    return null;
  }

  const raw = Number(entry.confidence);
  const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

  return {
    explanation,
    confidence,
    // Usable, but worth a second look — same rule the classifier applies.
    needsReview: confidence < CONFIDENCE_THRESHOLD,
  };
}

/**
 * Generates plain-language explanations for a scan's findings (§5.3).
 *
 * Never throws. Every failure mode resolves to "some or all findings have no
 * explanation", which the UI is required to render normally.
 *
 * @param {Array<object>} findings Findings from scanContractRisk.
 * @param {object} [options]
 * @param {string} [options.model='llama-3.3-70b-versatile']
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{explanations: Object<string, object>, stats: object,
 *   error: object|null}>}
 *   `explanations` is keyed by finding id, so the caller merges by id and any
 *   id absent from it simply has no explanation.
 *
 * @example
 * const { explanations } = await explainFindings(scan.findings);
 * explanations['wording:unlimited_liability']?.explanation;
 */
async function explainFindings(findings, options = {}) {
  const list = Array.isArray(findings) ? findings : [];

  const empty = (error, extra = {}) => ({
    explanations: {},
    error,
    stats: {
      findings: list.length,
      requested: 0,
      explained: 0,
      skippedOverCap: 0,
      lowConfidence: 0,
      aiUsed: false,
      ...extra,
    },
  });

  if (list.length === 0) {
    return empty(null);
  }

  // Severity order is already the scan's sort order, so the cap keeps the most
  // serious findings when it bites.
  const batch = list.slice(0, MAX_FINDINGS_PER_CALL);
  const skippedOverCap = list.length - batch.length;

  const estimate = estimateExplainTokens(batch.length);

  let response;

  try {
    response = await callGroqWithValidation({
      model: options.model || DEFAULT_MODEL,

      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(batch) },
      ],

      schema: BATCH_SCHEMA,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: Math.max(1000, batch.length * 120),
      maxRetries: Number.isFinite(Number(options.maxRetries))
        ? Number(options.maxRetries)
        : 1,

      fallback: () => ({ explanations: [] }),
      client: options.client || null,
    });
  } catch (error) {
    // Transport failure — rate limit, 5xx, exhausted retries. groqHelper
    // re-throws these so callers can map their own status codes.
    console.error('[risk/explain] call failed:', error?.message);

    return empty(
      {
        reason: 'api-error',
        message: error?.message || 'The explanation call failed.',
        status: Number(error?.status || error?.statusCode || 0),
      },
      { requested: batch.length, skippedOverCap }
    );
  }

  if (response.usedFallback) {
    console.error(
      '[risk/explain] unusable response, reason=' + response.reason + ':',
      JSON.stringify(response.errors)
    );

    return empty(
      {
        reason: response.reason,
        message:
          'The model returned an unusable response, so no explanations were ' +
          'generated. The findings themselves are unaffected.',
        status: 0,
      },
      { requested: batch.length, skippedOverCap, aiUsed: true }
    );
  }

  const entries = Array.isArray(response.data?.explanations)
    ? response.data.explanations
    : [];

  const explanations = {};

  let lowConfidence = 0;

  batch.forEach((finding, offset) => {
    // Prefer the model's own index, so a reordered response cannot attach one
    // finding's explanation to a different finding — the same failure mode
    // classifyRequirements guards against.
    const entry =
      entries.find((item) => Number(item?.index) === offset + 1) ||
      entries[offset];

    const normalized = normalizeEntry(entry);

    if (!normalized) {
      return;
    }

    if (normalized.needsReview) {
      lowConfidence += 1;
    }

    explanations[finding.id] = normalized;
  });

  const explained = Object.keys(explanations).length;

  console.log(
    '[risk/explain]',
    explained,
    'of',
    batch.length,
    'findings explained in 1 call, est.',
    estimate.label
  );

  return {
    explanations,
    error: null,
    stats: {
      findings: list.length,
      requested: batch.length,
      explained,
      // A finding the model skipped or answered unusably. It renders with its
      // detection info and no explanation.
      unexplained: batch.length - explained,
      skippedOverCap,
      lowConfidence,
      attempts: response.attempts,
      estimatedTokens: estimate.total,
      aiUsed: true,
    },
  };
}

module.exports = {
  explainFindings,
  buildUserPrompt,
  renderFinding,
  normalizeEntry,
  MAX_FINDINGS_PER_CALL,
  CONFIDENCE_THRESHOLD,
};
