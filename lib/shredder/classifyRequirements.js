const { callGroqWithValidation } = require('../ai/groqHelper');

// §4.2 — AI classification of §4.1's candidates, in small batches.
//
// Candidates go out 8 at a time. That keeps each prompt well inside the token
// budget analyze.js disciplines itself to (MAX_RFP_TEXT_LENGTH = 18000 chars),
// and it bounds the blast radius of a bad response: one unusable batch costs
// 8 rows their classification, not the whole run.
//
// Nothing is ever dropped. A candidate whose batch fails validation, or whose
// own entry comes back malformed, is returned with role/department null,
// confidence 0, and needsReview true — Gate 2 has to be able to see what the
// classifier could not handle.

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const MAX_TEXT_PER_CANDIDATE = 1200;

const VALID_ROLES = [
  'work_requirement',
  'submission_instruction',
  'evaluation_factor',
];

// groqHelper validates and uncertainty-flags TOP-LEVEL keys only, by design.
// Batching puts each candidate's confidence one level down inside `results`,
// so the helper's own flagging cannot reach it and this module applies the
// same rule per item. The schema still declares the shape the helper CAN
// enforce: a top-level `results` array.
const BATCH_SCHEMA = {
  results: 'array',
};

const SYSTEM_PROMPT = `You are classifying extracted requirement candidates from a government RFP.

For EACH numbered candidate you are given, decide:

1. "role" - exactly one of:
   - "work_requirement": something the contractor must actually do, deliver, build, staff, or maintain if awarded.
   - "submission_instruction": something the bidder must do to submit a compliant proposal (forms, formatting, copies, deadlines, signatures, packaging).
   - "evaluation_factor": something the issuer will use to score, weight, rank, or select proposals.

2. "department" - the internal team that owns it. Use one of: Financial, Legal, Operations, Technical, Sales. Pick the single best fit.

3. "confidence" - a number from 0 to 1 for how certain you are about "role".

RULES:
- Classify only what the candidate text actually says. Do not infer beyond it.
- Return one result object per candidate, with "index" matching the candidate's number.
- Return a result for EVERY candidate, in the same order, even if you are unsure - use a low confidence instead of omitting it.
- Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "results": [
    {
      "index": 1,
      "role": "work_requirement",
      "department": "Technical",
      "confidence": 0.9
    }
  ]
}`;

/**
 * Splits an array into fixed-size chunks.
 *
 * @param {Array} items
 * @param {number} size
 * @returns {Array[]}
 */
function chunk(items, size) {
  const batches = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

/**
 * Renders one batch of candidates as the user message.
 *
 * @param {Array<{text: string, page: number|null, section: string|null}>} batch
 * @returns {string}
 */
function buildUserPrompt(batch) {
  const body = batch
    .map((candidate, offset) => {
      const text = String(candidate.text || '').slice(
        0,
        MAX_TEXT_PER_CANDIDATE
      );

      const section = candidate.section
        ? `\nSection: ${candidate.section}`
        : '';

      const page = candidate.page ? `\nPage: ${candidate.page}` : '';

      return `Candidate ${offset + 1}:${section}${page}\nText: ${text}`;
    })
    .join('\n\n');

  return (
    `Classify the following ${batch.length} candidate(s). ` +
    `Return exactly ${batch.length} result object(s).\n\n${body}`
  );
}

/**
 * The shape returned for anything the classifier could not handle.
 *
 * @param {object} candidate
 * @param {string} reason
 * @returns {object}
 */
function degradedResult(candidate, reason) {
  return {
    ...candidate,
    role: null,
    department: null,
    confidence: 0,
    needsReview: true,
    classificationError: reason,
  };
}

/**
 * Validates one entry from a batch response.
 *
 * Low confidence is not an error — it is valid data that gets flagged. A bad
 * role or a non-numeric confidence IS an error, and degrades that one
 * candidate without touching the rest of the batch.
 *
 * @param {object} candidate The original candidate.
 * @param {unknown} entry The model's result for it.
 * @param {number} threshold Confidence below this sets needsReview.
 * @returns {object}
 */
function applyEntry(candidate, entry, threshold) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return degradedResult(candidate, 'missing-result');
  }

  const role = typeof entry.role === 'string' ? entry.role.trim() : '';

  if (!VALID_ROLES.includes(role)) {
    return degradedResult(candidate, `invalid-role:${role || 'empty'}`);
  }

  const confidence = Number(entry.confidence);

  if (!Number.isFinite(confidence)) {
    return degradedResult(candidate, 'invalid-confidence');
  }

  const clamped = Math.max(0, Math.min(1, confidence));

  const department =
    typeof entry.department === 'string' && entry.department.trim()
      ? entry.department.trim()
      : null;

  return {
    ...candidate,
    role,
    department,
    confidence: clamped,
    // Mirrors groqHelper's uncertainty rule at the item level: usable, but
    // marked for a human to look at.
    needsReview: clamped < threshold || department === null,
    classificationError: null,
  };
}

/**
 * Classifies §4.1 candidates into role / department / confidence.
 *
 * @param {Array<{text: string, page: number|null, section: string|null,
 *   matchedSignal: string[]}>} candidates
 * @param {object} [options]
 * @param {number} [options.batchSize=8] Candidates per Groq call.
 * @param {string} [options.model='llama-3.3-70b-versatile']
 * @param {number} [options.confidenceThreshold=0.7] Below this, needsReview.
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{results: Array<object>, stats: {total: number,
 *   batches: number, failedBatches: number, needsReview: number,
 *   byRole: Object<string, number>}}>}
 *   Every input candidate comes back, in input order, with the original
 *   fields plus role, department, confidence, needsReview,
 *   classificationError.
 *
 * @example
 * const { results, stats } = await classifyRequirements(candidates);
 */
async function classifyRequirements(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];

  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const model = options.model || DEFAULT_MODEL;

  const threshold = Number.isFinite(Number(options.confidenceThreshold))
    ? Number(options.confidenceThreshold)
    : DEFAULT_CONFIDENCE_THRESHOLD;

  const batches = chunk(list, batchSize);
  const results = [];

  let failedBatches = 0;

  for (const batch of batches) {
    let response;

    try {
      response = await callGroqWithValidation({
        model,

        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(batch) },
        ],

        schema: BATCH_SCHEMA,
        temperature: 0.1,
        maxTokens: 1500,
        maxRetries: Number.isFinite(Number(options.maxRetries))
          ? Number(options.maxRetries)
          : 1,

        // Built only when needed; the degraded rows are constructed below so
        // each candidate keeps its own text, page, and section.
        fallback: () => ({ results: [] }),

        client: options.client || null,
      });
    } catch (error) {
      // A transport/API failure (rate limit, 5xx, exhausted retries) is
      // re-thrown by groqHelper. Degrade this batch and keep going rather
      // than losing the whole run.
      failedBatches += 1;

      for (const candidate of batch) {
        results.push(
          degradedResult(candidate, `api-error:${error?.message || 'unknown'}`)
        );
      }

      continue;
    }

    if (response.usedFallback) {
      failedBatches += 1;

      for (const candidate of batch) {
        results.push(degradedResult(candidate, `batch:${response.reason}`));
      }

      continue;
    }

    const entries = Array.isArray(response.data?.results)
      ? response.data.results
      : [];

    batch.forEach((candidate, offset) => {
      // Prefer the model's own index when it is usable, since a model that
      // reorders results would otherwise corrupt every row in the batch.
      const byIndex = entries.find(
        (entry) => Number(entry?.index) === offset + 1
      );

      results.push(
        applyEntry(candidate, byIndex || entries[offset], threshold)
      );
    });
  }

  const byRole = {};
  let needsReview = 0;

  for (const result of results) {
    const key = result.role || 'unclassified';

    byRole[key] = (byRole[key] || 0) + 1;

    if (result.needsReview) {
      needsReview += 1;
    }
  }

  return {
    results,
    stats: {
      total: results.length,
      batches: batches.length,
      failedBatches,
      needsReview,
      byRole,
    },
  };
}

module.exports = {
  classifyRequirements,
  VALID_ROLES,
  DEFAULT_BATCH_SIZE,
};
