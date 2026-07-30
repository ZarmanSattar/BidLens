const Groq = require('groq-sdk');

// Shared Groq call wrapper for every AI-backed module in the app.
//
// It exists so no module has to re-implement the same three concerns:
//   1. retrying transient Groq failures (5xx, short rate limits, network),
//   2. proving the model actually returned the shape the caller needs,
//   3. degrading to a caller-supplied safe default instead of throwing when
//      the model returns something unusable.
//
// Everything here is plain JS on purpose. No schema-validation dependency is
// needed for "are the required top-level keys present with the right basic
// types", which is the only guarantee this layer makes. Deep per-item
// normalization stays the caller's job.

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_BACKOFF_MS = 750;
const DEFAULT_MAX_RETRY_AFTER_MS = 10000;
const DEFAULT_UNCERTAINTY_THRESHOLD = 0.7;

// HTTP statuses that mean "the request itself was wrong". Retrying these
// burns the serverless time budget and will fail identically every time.
const NON_RETRYABLE_STATUSES = [400, 401, 403, 404, 413, 422];
const RETRYABLE_SERVER_STATUSES = [500, 502, 503, 504];

let cachedClient = null;

/**
 * Lazily builds (and reuses) a Groq client from GROQ_API_KEY.
 *
 * Lazy rather than module-scope so importing this file from a module that
 * never makes an AI call cannot throw at import time.
 *
 * @returns {import('groq-sdk')} A shared Groq client.
 * @throws {Error} If GROQ_API_KEY is not set.
 */
function getGroqClient() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  if (!cachedClient) {
    cachedClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  return cachedClient;
}

/**
 * Pulls an HTTP status off a Groq SDK error, whatever shape it arrived in.
 *
 * @param {unknown} error
 * @returns {number} The status, or 0 when there is none (e.g. a socket error).
 */
function getErrorStatus(error) {
  return Number(
    error?.status || error?.statusCode || error?.response?.status || 0
  );
}

/**
 * Reads the `retry-after` response header and converts it to milliseconds.
 *
 * @param {unknown} error
 * @returns {number|null} Milliseconds to wait, or null when absent/unusable.
 */
function getRetryAfterMs(error) {
  const headers = error?.headers || error?.response?.headers;

  let value = null;

  if (typeof headers?.get === 'function') {
    value = headers.get('retry-after');
  } else {
    value = headers?.['retry-after'] || headers?.['Retry-After'];
  }

  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Decides whether a failed Groq call is worth retrying.
 *
 * Retryable: 5xx, 408, network/transport errors with no status, and 429 only
 * when the server says the limit resets soon. A 429 with a long (or absent)
 * reset is a real quota wall — sleeping through it inside a request handler
 * just converts a fast error into a function timeout.
 *
 * @param {unknown} error
 * @param {number} maxRetryAfterMs Longest 429 reset still worth waiting out.
 * @returns {boolean}
 */
function isRetryableError(error, maxRetryAfterMs) {
  const status = getErrorStatus(error);

  if (NON_RETRYABLE_STATUSES.includes(status)) {
    return false;
  }

  if (RETRYABLE_SERVER_STATUSES.includes(status) || status === 408) {
    return true;
  }

  if (status === 429) {
    const retryAfterMs = getRetryAfterMs(error);

    return Boolean(retryAfterMs && retryAfterMs <= maxRetryAfterMs);
  }

  // No status at all: connection reset, DNS failure, aborted socket, timeout.
  return status === 0;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strips markdown fences and surrounding prose, then parses the JSON object.
 *
 * This is the default parser. Callers with their own recovery logic (for
 * example repairing responses truncated by max_tokens) should pass a `parse`
 * function instead of relying on this.
 *
 * @param {string} rawResponse Raw message content from the model.
 * @returns {unknown} The parsed value.
 * @throws {Error} If no JSON object can be recovered.
 */
function parseJsonLoose(rawResponse) {
  // trim() also strips a leading BOM, which is whitespace per the spec.
  const cleaned = String(rawResponse || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const candidates = [cleaned];

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        // Trailing commas are the single most common model JSON slip.
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        // Try the next candidate.
      }
    }
  }

  throw new Error('AI response did not contain parseable JSON');
}

/**
 * @param {unknown} value
 * @param {string} type One of: string, number, boolean, array, object, any.
 * @returns {boolean}
 */
function matchesType(value, type) {
  switch (type) {
    case 'any':
      return true;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        value !== null && typeof value === 'object' && !Array.isArray(value)
      );
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * Normalizes a schema entry into its long form.
 *
 * Accepts either the shorthand `'array'` or the full
 * `{ type, required, confidence }`.
 *
 * @param {string|object} rule
 * @returns {{type: string, required: boolean, confidence: boolean}}
 */
function normalizeRule(rule) {
  if (typeof rule === 'string') {
    return { type: rule, required: true, confidence: false };
  }

  return {
    type: rule?.type || 'any',
    required: rule?.required !== false,
    confidence: Boolean(rule?.confidence),
  };
}

/**
 * Checks a parsed response against a caller-supplied shape descriptor.
 *
 * Only top-level keys are checked, and only for presence and basic type.
 * A key whose rule is `{ required: false }` may be absent, but if present it
 * must still match its type.
 *
 * @param {unknown} value The parsed model response.
 * @param {Object<string, string|object>} schema Shape descriptor.
 * @returns {{valid: boolean, errors: string[]}}
 *
 * @example
 * validateShape(parsed, {
 *   summary: 'object',
 *   risks: { type: 'array', required: false },
 * });
 */
function validateShape(value, schema) {
  const errors = [];

  if (!matchesType(value, 'object')) {
    return { valid: false, errors: ['response is not a JSON object'] };
  }

  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors };
  }

  for (const [key, rawRule] of Object.entries(schema)) {
    const rule = normalizeRule(rawRule);
    const present = value[key] !== undefined && value[key] !== null;

    if (!present) {
      if (rule.required) {
        errors.push(`missing required key "${key}"`);
      }

      continue;
    }

    if (!matchesType(value[key], rule.type)) {
      errors.push(
        `key "${key}" should be ${rule.type} but was ${
          Array.isArray(value[key]) ? 'array' : typeof value[key]
        }`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Finds the schema keys that carry a confidence score.
 *
 * A key counts as confidence-bearing if its rule sets `confidence: true`, or
 * if it is literally named `confidence`.
 *
 * @param {Object<string, string|object>} schema
 * @returns {string[]}
 */
function getConfidenceFields(schema) {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  return Object.entries(schema)
    .filter(
      ([key, rawRule]) =>
        key === 'confidence' || normalizeRule(rawRule).confidence
    )
    .map(([key]) => key);
}

/**
 * Flags a valid-but-low-confidence response for human review.
 *
 * Low confidence is deliberately NOT treated as malformed: the data is
 * structurally fine and still usable, it just should not be trusted blindly.
 * Returns a shallow copy so the caller's parsed object is never mutated.
 *
 * @param {object} data Validated response data.
 * @param {Object<string, string|object>} schema
 * @param {number|null} threshold Values strictly below this flag the response.
 * @returns {object} `data`, or a copy carrying `needsReview: true`.
 */
function applyUncertaintyFlag(data, schema, threshold) {
  const fields = getConfidenceFields(schema);

  if (fields.length === 0 || threshold === null) {
    return data;
  }

  const isUncertain = fields.some((field) => {
    const score = Number(data[field]);

    return Number.isFinite(score) && score < threshold;
  });

  return isUncertain ? { ...data, needsReview: true } : data;
}

/**
 * Calls Groq, validates the response shape, and never throws on bad output.
 *
 * Failure handling splits deliberately in two:
 *
 *   - **Transport/API failures** (rate limits, 5xx, bad request, exhausted
 *     retries) are re-thrown with the original error intact, so callers keep
 *     their own HTTP status mapping (429 -> 429, 413 -> 413, and so on).
 *   - **Content failures** (unparseable JSON, wrong shape, empty message)
 *     resolve to `fallback` with `usedFallback: true`. The model answering
 *     badly should degrade the result, not break the request.
 *
 * @param {object} options
 * @param {Array<{role: string, content: string}>} options.messages
 *   Groq chat messages array.
 * @param {string} options.model Model id, e.g. 'llama-3.3-70b-versatile'.
 * @param {Object<string, string|object>} [options.schema]
 *   Required top-level keys and their basic types. Shorthand `'array'` means
 *   required; `{ type: 'array', required: false }` makes it optional;
 *   `{ type: 'number', confidence: true }` marks a confidence score.
 * @param {*|(() => *)} options.fallback Safe default returned when the
 *   response is unusable. Should already match the shape the caller's
 *   consumers expect. May be a factory function, which is invoked only if a
 *   fallback is actually needed — use that form when building the default is
 *   expensive, so the happy path does not pay for it.
 * @param {number} [options.maxRetries=2] Retries after the first attempt.
 * @param {number} [options.temperature=0.1]
 * @param {number} [options.maxTokens=5000] Sent to Groq as `max_tokens`.
 * @param {(raw: string) => unknown} [options.parse] Custom JSON parser. Use
 *   this when you have recovery logic the default parser lacks.
 * @param {number|null} [options.uncertaintyThreshold=0.7] Confidence below
 *   this adds `needsReview: true`. Pass null to disable.
 * @param {number} [options.maxRetryAfterMs=10000] Longest 429 reset still
 *   worth waiting out inside a request handler.
 * @param {object} [options.client] Groq client override, mainly for tests.
 *
 * @returns {Promise<{data: *, usedFallback: boolean, attempts: number,
 *   reason: string|null, errors: string[]}>}
 *   `reason` is null on success, otherwise 'empty-response', 'unparseable',
 *   or 'schema-mismatch'. `errors` lists the specific shape violations.
 *
 * @throws {Error} The original Groq error when the API call itself fails.
 *
 * @example
 * const { data, usedFallback } = await callGroqWithValidation({
 *   messages: [{ role: 'system', content: prompt }],
 *   model: 'llama-3.3-70b-versatile',
 *   schema: { summary: 'object', risks: { type: 'array', required: false } },
 *   fallback: { summary: {}, risks: [] },
 * });
 */
async function callGroqWithValidation({
  messages,
  model,
  schema = null,
  fallback = null,
  maxRetries = DEFAULT_MAX_RETRIES,
  temperature = 0.1,
  maxTokens = 5000,
  parse = parseJsonLoose,
  uncertaintyThreshold = DEFAULT_UNCERTAINTY_THRESHOLD,
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
  client = null,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('callGroqWithValidation requires a non-empty messages array');
  }

  if (!model) {
    throw new Error('callGroqWithValidation requires a model');
  }

  const groq = client || getGroqClient();
  const totalAttempts = Math.max(1, Number(maxRetries) + 1);

  let completion = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    attempts = attempt;

    try {
      completion = await groq.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });

      break;
    } catch (error) {
      const lastAttempt = attempt === totalAttempts;

      if (lastAttempt || !isRetryableError(error, maxRetryAfterMs)) {
        throw error;
      }

      await wait(getRetryAfterMs(error) || DEFAULT_BASE_BACKOFF_MS * attempt);
    }
  }

  const rawResponse = completion?.choices?.[0]?.message?.content;

  const degraded = (reason, errors = []) => ({
    data: typeof fallback === 'function' ? fallback() : fallback,
    usedFallback: true,
    attempts,
    reason,
    errors,
  });

  if (!rawResponse) {
    return degraded('empty-response', ['model returned no message content']);
  }

  let parsed;

  try {
    parsed = parse(rawResponse);
  } catch (error) {
    return degraded('unparseable', [error?.message || 'JSON parse failed']);
  }

  const { valid, errors } = validateShape(parsed, schema);

  if (!valid) {
    return degraded('schema-mismatch', errors);
  }

  return {
    data: applyUncertaintyFlag(parsed, schema, uncertaintyThreshold),
    usedFallback: false,
    attempts,
    reason: null,
    errors: [],
  };
}

module.exports = {
  callGroqWithValidation,
  getGroqClient,
  validateShape,
  parseJsonLoose,
  isRetryableError,
  getErrorStatus,
  getRetryAfterMs,
};
