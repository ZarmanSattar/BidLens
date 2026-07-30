const {
  callGroqWithValidation,
  getErrorStatus,
  getRetryAfterMs,
} = require('../ai/groqHelper');

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

// 20 rather than 8: the ~500-token system prompt is re-sent on every call, so
// a 222-candidate RFP costs 28 copies of it at batch size 8 and 12 at 20 —
// roughly 8k tokens saved per document against a 100k daily allowance. The
// tradeoff is that one failed batch now costs 20 rows instead of 8, which is
// why failures are logged and flagged rather than silently absorbed.
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const MAX_TEXT_PER_CANDIDATE = 1200;

// Output budget scales with batch size — roughly 40 tokens per result object
// plus wrapper. A truncated response is unparseable and degrades the whole
// batch, which is exactly the failure mode a larger batch size would amplify.
const TOKENS_PER_RESULT = 100;
const MIN_COMPLETION_TOKENS = 1500;

// A 429 asking us to wait longer than this is a quota wall, not a blip: every
// remaining batch will fail the same way, so the run aborts instead of firing
// doomed calls and writing rows nobody can trust.
const QUOTA_ABORT_THRESHOLD_MS = 60000;

// not_applicable exists because the candidate filter matches on obligation
// wording, which fires on any "shall" sentence — including ones whose subject
// is the issuing agency ("the University shall issue purchase orders") or the
// contract itself ("this contract shall not be assignable"). Those obligate
// nobody to bid or perform, and forcing them into one of the three real roles
// was the single largest source of Gate 2 errors.
const VALID_ROLES = [
  'work_requirement',
  'submission_instruction',
  'evaluation_factor',
  'not_applicable',
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

1. "role" - work through these two steps in order.

STEP 1 - WHO DOES THIS SENTENCE OBLIGATE? Ask this before anything else.
The word "shall" does NOT by itself make something a requirement. Look at the subject of the sentence.
Only text that obligates the Contractor, Offeror, Vendor, Bidder, or Supplier can receive one of the
three real roles. Classify it "not_applicable" when the sentence:
   - obligates the issuing agency instead (the University, the Commonwealth, the State, the agency), or
   - describes contract mechanics: assignment, modification, renewal, termination procedure, notice
     periods, what a clause does or does not apply to, what the parties may agree between them, or
     what happens to obligations in some scenario, or
   - states an exception, exclusion, or limitation rather than a duty, or
   - obligates nobody to do anything specific.

STEP 2 - ASSIGN THE ROLE. Exactly one of:
   - "work_requirement": something the contractor must do, deliver, build, staff, maintain, insure,
     certify, or comply with if awarded. This INCLUDES ongoing post-award operational duties such as
     invoicing, reporting, audits, insurance, background checks, and accessibility compliance.
   - "submission_instruction": how to prepare, format, assemble, or submit the PROPOSAL DOCUMENT itself -
     cover sheets, required forms and attachments, narrative sections the proposal must contain, copies,
     page limits, packaging, submission deadline and delivery method.
     This is strictly about the bid package. It is NOT about performing the contract after award.
   - "evaluation_factor": something the issuer will use to score, weight, rank, or select proposals.
   - "not_applicable": the sentence does not obligate the contractor at all - see STEP 1.

TIE-BREAKER for "describe..." items. A candidate that asks the bidder to describe, explain, or provide a
narrative about something can be either a submission_instruction or an evaluation_factor. Use the Section
heading given with the candidate to decide:
   - Section is about evaluation, scoring, award criteria, or selection -> "evaluation_factor",
     because the issuer is telling you what it will grade.
   - Section is about proposal preparation, submission requirements, or proposal contents ->
     "submission_instruction", because it defines what the bid package must contain.

EXAMPLES:
   - "The University shall not discriminate against a faith-based organization on the basis of..."
     -> not_applicable. The subject is the University, not the contractor.
   - "This contract shall not be assignable in whole or in part without the written consent of the University."
     -> not_applicable. Contract mechanics; it requires no work from anyone.
   - "In most cases, the University shall issue eVA Purchase Orders for required performance."
     -> not_applicable. It describes the University's own process.
   - "All proper invoices shall be emailed to invoice@example.edu and reference the PO number."
     -> work_requirement. An ongoing post-award duty of the contractor. It is NOT a
        submission_instruction, because it has nothing to do with the proposal document.
   - "Written narrative statements to include how the Contractor plans to meet the objectives defined herein."
     (Section: XI. PROPOSAL PREPARATION AND SUBMISSION REQUIREMENTS)
     -> submission_instruction. It describes content the proposal document must contain.
   - "Describe how the proposed team will communicate with the University during implementation and launch."
     (Section: IX. EVALUATION CRITERIA AND AWARD PROCESS)
     -> evaluation_factor. Near-identical wording to the previous example, but this one sits under the
        evaluation section, so it is something the issuer will score.

2. "department" - the internal team that owns it. Use one of: Financial, Legal, Operations, Technical, Sales. Pick the single best fit. Give a department even when the role is not_applicable.

3. "confidence" - a number from 0 to 1 for how certain you are about "role".

RULES:
- Classify only what the candidate text actually says. Do not infer beyond it.
- Do not force a sentence into a real role just because it sounds obligatory. not_applicable is a correct, expected answer and should be used whenever STEP 1 applies.
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
 * Reads the wait time out of a Groq rate-limit message body.
 *
 * Groq states the delay in prose ("Please try again in 19m46.272s"). The
 * retry-after header is preferred when present, but this is the fallback
 * because a 429 that groqHelper declined to retry may carry no header at all.
 *
 * @param {string} message
 * @returns {number|null} Milliseconds to wait, or null when unparseable.
 */
function parseRetryFromMessage(message) {
  const match = /try again in\s+(?:(\d+)\s*m)?\s*([\d.]+)\s*s/i.exec(
    String(message || '')
  );

  if (!match) {
    return null;
  }

  const ms = (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 1000;

  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * How long a 429 wants us to wait, or null if this is not a rate limit.
 *
 * A 429 with no usable hint is treated as the abort threshold: groqHelper
 * only surfaces a 429 after declining to retry it, so by that point the wait
 * is already known to be longer than it was willing to sleep.
 *
 * @param {unknown} error
 * @returns {number|null}
 */
function getRateLimitWaitMs(error) {
  if (getErrorStatus(error) !== 429) {
    return null;
  }

  return (
    getRetryAfterMs(error) ??
    parseRetryFromMessage(error?.message) ??
    QUOTA_ABORT_THRESHOLD_MS
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
 * @returns {Promise<{results: Array<object>, aborted: object|null,
 *   stats: {total: number, batches: number, plannedBatches: number,
 *   failedBatches: number, candidatesNotAttempted: number,
 *   needsReview: number, byRole: Object<string, number>}}>}
 *   Candidates come back in input order with the original fields plus role,
 *   department, confidence, needsReview, classificationError.
 *
 *   Normally every input candidate is returned. If the run aborts on a rate
 *   limit, `results` covers only the batches that were attempted and
 *   `aborted` describes the stop — callers should persist what came back and
 *   surface `aborted` rather than treating the remainder as classified.
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
  let aborted = null;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];

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
        maxTokens: Math.max(
          MIN_COMPLETION_TOKENS,
          batch.length * TOKENS_PER_RESULT
        ),
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
      // re-thrown by groqHelper.
      const waitMs = getRateLimitWaitMs(error);

      failedBatches += 1;

      const reason = `api-error:${error?.message || 'unknown'}`;

      for (const candidate of batch) {
        results.push(degradedResult(candidate, reason));
      }

      if (waitMs !== null && waitMs >= QUOTA_ABORT_THRESHOLD_MS) {
        // Every remaining batch would fail identically. Stop here and let the
        // caller persist the work that did succeed.
        const notAttempted = list.length - results.length;

        aborted = {
          reason: 'rate_limit',
          retryAfterMs: waitMs,
          message: error?.message || 'rate limit reached',
          abortedAtBatch: batchIndex,
          batchesNotAttempted: batches.length - (batchIndex + 1),
          candidatesNotAttempted: notAttempted,
        };

        console.error(
          `[classify] batch ${batchIndex + 1}/${batches.length} hit a rate ` +
            `limit needing ${Math.round(waitMs / 1000)}s — aborting run, ` +
            `${aborted.batchesNotAttempted} batches (${notAttempted} ` +
            `candidates) not attempted:`,
          error?.message
        );

        break;
      }

      console.error(
        `[classify] batch ${batchIndex + 1}/${batches.length} failed ` +
          `(${batch.length} candidates):`,
        error?.message
      );

      continue;
    }

    if (response.usedFallback) {
      failedBatches += 1;

      for (const candidate of batch) {
        results.push(degradedResult(candidate, `batch:${response.reason}`));
      }

      console.error(
        `[classify] batch ${batchIndex + 1}/${batches.length} returned an ` +
          `unusable response (${batch.length} candidates), reason=` +
          `${response.reason}:`,
        JSON.stringify(response.errors)
      );

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
    aborted,
    stats: {
      total: results.length,
      // Batches actually sent, which is fewer than plannedBatches after an
      // abort. Candidates in unsent batches are "not attempted", not
      // "failed" — nothing was ever learned about them.
      batches: aborted ? aborted.abortedAtBatch + 1 : batches.length,
      plannedBatches: batches.length,
      failedBatches,
      candidatesNotAttempted: list.length - results.length,
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
