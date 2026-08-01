const {
  callGroqWithValidation,
  getErrorStatus,
  getRetryAfterMs,
} = require('../ai/groqHelper');
const { selectLibraryForBatch } = require('./skeletonLibrary');
const { estimateSkeletonTokens } = require('./skeletonCost');

// §8.3 — drafting a response skeleton for each requirement.
//
// Structurally a sibling of lib/fit/judgeFit.js, deliberately: small batches,
// global-position index keying, an onBatch hook that persists before the next
// call, per-batch degradation, and a quota-wall abort that keeps what it
// earned. Those properties were not designed here — they were paid for in
// Module 2, and rebuilding them differently would only find the same bugs
// again.
//
// WHAT IS DIFFERENT FROM §6.3, AND WHY
//
//   Batch size 10, not 20. A judgment is a verdict plus two short evidence
//   strings; a skeleton is a drafted paragraph. Output per item is roughly
//   double, and Groq counts the max_tokens reservation toward TPM, so the
//   batch has to be smaller to keep the per-call peak in the same place.
//
//   The library slice is chosen PER BATCH by skeletonLibrary rather than sent
//   whole. See §8.2's note: the library is resent every call exactly like the
//   company profile, so an unfiltered one grows the per-call cost without
//   bound.
//
//   Batches are formed department-first. Requirements are sorted by department
//   before chunking, so most batches hold one department and get a tight,
//   relevant library slice. Sorting does NOT change the returned keys: every
//   requirement keeps the position it had in the caller's list.
//
// Everything degrades. groqHelper turns unusable content into the fallback
// instead of throwing, and the transport failures it does throw are caught
// here. A caller that gets nothing back still has every requirement and the
// coverage counter still reads honestly — a skeleton is a draft, never a
// dependency.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Prose, so slightly above the 0.1 the classifiers use, but still anchored.
const DEFAULT_TEMPERATURE = 0.3;

const DEFAULT_BATCH_SIZE = 10;

const REQUIREMENT_CHARS = 420;
const LIBRARY_CONTENT_CHARS = 700;
const MAX_SKELETON_CHARS = 1400;

// Output budget per skeleton. A truncated response is unparseable and costs
// the whole batch, so this is generous — but it scales with the batch instead
// of being a flat reservation, because Groq counts it toward TPM.
const TOKENS_PER_SKELETON = 250;
const MIN_COMPLETION_TOKENS = 1200;

// A 429 asking for longer than this is the rolling window being empty, not a
// blip: every remaining batch would fail the same way.
const QUOTA_ABORT_THRESHOLD_MS = 60000;

/** Hard ceiling on ONE run, across all batches. Bounds a single button press. */
const MAX_REQUIREMENTS_PER_RUN = 120;

const BATCH_SCHEMA = {
  skeletons: 'array',
};

const SYSTEM_PROMPT = `You are drafting the FIRST DRAFT of a proposal response to individual requirements from a solicitation. A human proposal writer will edit what you produce; your job is to give them a solid starting paragraph, not a finished submission.

You are given a set of the company's own reusable content, then a numbered list of requirements. For EACH requirement, draft one response.

WHAT TO WRITE:
- 2-4 sentences. Under 120 words. Plain professional English.
- Say what the company WILL DO to meet this requirement, and where the library supports it, say what the company has already done.
- Ground every factual claim in the COMPANY CONTENT you were given. Quote or paraphrase it.
- When the library contains nothing relevant, write a clearly-marked placeholder that says what the writer needs to supply, e.g. "[Needs input: describe our approach to X]". A short honest placeholder is far more useful than an invented capability.

WHAT NOT TO WRITE:
- Do NOT invent certifications, staff, clients, dates, dollar figures, or past projects. If it is not in the company content, it does not exist.
- Do NOT restate the requirement back. The reader already has it.
- Do NOT write marketing language, superlatives, or claims of being "best in class".
- Do NOT use markdown, headings, bullets, or bold.

Also give "used_library_titles": an array of the exact titles of the company content entries you actually drew on, or an empty array if you used none. Be accurate — this is recorded so the draft can be rechecked when that content changes.

Also give "confidence": 0 to 1, how well the company content supported the draft. Use a LOW value when you had to write a placeholder.

Return one object per requirement, with "index" matching the requirement's number, for EVERY requirement, in order. Never omit one.

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "skeletons": [
    {
      "index": 1,
      "content": "We will provide 24x7 tier-2 support through our existing US-Eastern service desk, extending coverage with a paid on-call rotation. Our team delivered the same model for the ODU CMS replatform, where we sustained a one-hour response target across a 40,000-page estate.",
      "used_library_titles": ["ODU CMS replatform"],
      "confidence": 0.8
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
 * Reads the wait time out of a Groq rate-limit message body.
 *
 * @param {string} message
 * @returns {number|null}
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
 * @param {unknown} error
 * @returns {number|null} Milliseconds to wait, or null if not a rate limit.
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
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
function clip(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Renders the selected library entries for the prompt.
 *
 * @param {Array<object>} entries
 * @returns {string}
 */
function renderLibrary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return (
      'COMPANY CONTENT: none available for these requirements. Write a ' +
      'placeholder for every response saying what the writer must supply. Do ' +
      'not invent anything.'
    );
  }

  const lines = ['COMPANY CONTENT (the only facts you may assert):'];

  for (const entry of entries) {
    lines.push(
      `--- ${entry.title} [${entry.category}]\n${clip(entry.content, LIBRARY_CONTENT_CHARS)}`
    );
  }

  return lines.join('\n');
}

/**
 * Renders one requirement for the prompt.
 *
 * @param {object} requirement
 * @param {number} number 1-based position WITHIN THE BATCH.
 * @returns {string}
 */
function renderRequirement(requirement, number) {
  const lines = [`Requirement ${number}:`];

  const meta = [
    requirement.req_number ? `ref ${requirement.req_number}` : '',
    requirement.department ? `owner: ${requirement.department}` : '',
    requirement.role === 'evaluation_factor'
      ? 'this is an EVALUATION FACTOR — the issuer scores the proposal on it'
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

  if (meta) {
    lines.push(meta);
  }

  if (requirement.section) {
    lines.push(`Section: ${clip(requirement.section, 90)}`);
  }

  lines.push(`Text: ${clip(requirement.requirement_text, REQUIREMENT_CHARS)}`);

  return lines.join('\n');
}

/**
 * @param {Array<object>} batch
 * @param {Array<object>} libraryEntries
 * @returns {string}
 */
function buildUserPrompt(batch, libraryEntries) {
  const body = batch
    .map((requirement, offset) => renderRequirement(requirement, offset + 1))
    .join('\n\n');

  return (
    `${renderLibrary(libraryEntries)}\n\n` +
    `Draft a response for each of the following ${batch.length} requirement(s). ` +
    `Return exactly ${batch.length} skeleton object(s).\n\n${body}`
  );
}

/**
 * Validates one entry from the model's response.
 *
 * @param {unknown} entry
 * @param {Array<object>} libraryEntries The slice this batch was shown.
 * @returns {object|null} null when unusable, leaving that requirement undrafted
 *   rather than storing an empty skeleton.
 */
function normalizeEntry(entry, libraryEntries) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const content = clip(entry.content, MAX_SKELETON_CHARS);

  if (!content) {
    return null;
  }

  // Titles are mapped back to ids against the slice actually sent. A title the
  // model invented matches nothing and is dropped — the recorded ids must be
  // real, because §8.2 staleness compares against them.
  const byTitle = new Map(
    (Array.isArray(libraryEntries) ? libraryEntries : []).map((item) => [
      String(item.title || '').trim().toLowerCase(),
      item,
    ])
  );

  const claimed = Array.isArray(entry.used_library_titles)
    ? entry.used_library_titles
    : [];

  const usedIds = [];
  const usedTitles = [];

  for (const title of claimed) {
    const match = byTitle.get(String(title || '').trim().toLowerCase());

    if (match && !usedIds.includes(match.id)) {
      usedIds.push(match.id);
      usedTitles.push(match.title);
    }
  }

  const raw = Number(entry.confidence);
  const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

  return {
    content,
    usedLibraryIds: usedIds,
    usedLibraryTitles: usedTitles,
    confidence,
    // Placeholders are the honest output when the library is thin, and the UI
    // should surface them rather than letting them read as finished prose.
    hasPlaceholder: /\[needs? input/i.test(content),
  };
}

/**
 * Orders requirements so that each batch is as department-coherent as possible.
 *
 * Sorting by department groups same-owner requirements together, so most
 * batches receive one department's library slice rather than the union of
 * three. Only the batch straddling a boundary spans two.
 *
 * The ORIGINAL position is carried on each item, so this reordering is
 * invisible in the result: keys are always positions in the caller's list.
 *
 * @param {Array<object>} rows
 * @returns {Array<{row: object, index: number}>}
 */
function orderForBatching(rows) {
  return rows
    .map((row, offset) => ({ row, index: offset + 1 }))
    .sort(
      (a, b) =>
        String(a.row.department || '~').localeCompare(
          String(b.row.department || '~')
        ) || a.index - b.index
    );
}

/**
 * Generates response skeletons for a set of requirements (§8.3).
 *
 * Never throws. Every failure mode resolves to "some or all requirements have
 * no skeleton", which the coverage counter reports honestly.
 *
 * @param {Array<object>} requirements Requirements still needing a skeleton.
 * @param {Array<object>} library All content_library rows.
 * @param {object} [options]
 * @param {string} [options.model='llama-3.3-70b-versatile']
 * @param {number} [options.batchSize=10]
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {(batch: Array<object>, info: object) => Promise<void>}
 *   [options.onBatch] Called with each batch's skeletons as soon as that batch
 *   succeeds, before the next call — so a run that dies part-way keeps what it
 *   earned. Awaited; its failures are logged and swallowed.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{skeletons: Object<string, object>, stats: object,
 *   error: object|null}>}
 *   `skeletons` is keyed by 1-BASED POSITION IN THE LIST THIS FUNCTION WAS
 *   GIVEN — not by batch position, and unaffected by the internal reordering.
 *   Each carries `requirementId`, which is what persistence joins on.
 *   `error` is non-null only when NOTHING was drafted.
 *
 * @example
 * const { skeletons } = await buildSkeletons(pending, library, { onBatch });
 */
async function buildSkeletons(requirements, library, options = {}) {
  const list = Array.isArray(requirements) ? requirements : [];
  const entries = Array.isArray(library) ? library : [];

  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;

  const attempted = list.slice(0, MAX_REQUIREMENTS_PER_RUN);
  const skippedOverCap = list.length - attempted.length;

  const baseStats = {
    requirements: list.length,
    requested: 0,
    drafted: 0,
    skippedOverCap,
    placeholders: 0,
    batches: 0,
    plannedBatches: 0,
    failedBatches: 0,
    requirementsNotAttempted: 0,
    librarySelections: [],
    aborted: null,
    aiUsed: false,
  };

  if (attempted.length === 0) {
    return { skeletons: {}, error: null, stats: baseStats };
  }

  const ordered = orderForBatching(attempted);
  const batches = chunk(ordered, batchSize);
  const estimate = estimateSkeletonTokens(attempted.length, batchSize);

  // Resolved once, so the call and the onBatch hook record the same model.
  // The hook needs it to stamp provenance on rows it writes DURING this
  // function, which is why it travels on the hook's meta argument rather than
  // on the stats object — stats does not exist until this function returns.
  const model = options.model || DEFAULT_MODEL;

  const skeletons = {};

  let placeholders = 0;
  let failedBatches = 0;
  let attemptedCount = 0;
  let aborted = null;
  let lastError = null;
  let aiUsed = false;

  const librarySelections = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const rows = batch.map((item) => item.row);

    // §8.2 — the filtered slice for THIS batch, not the whole library.
    const { entries: slice, stats: sliceStats } = selectLibraryForBatch(
      entries,
      rows
    );

    librarySelections.push({ batch: batchIndex + 1, ...sliceStats });

    let response;

    try {
      attemptedCount += batch.length;

      response = await callGroqWithValidation({
        model,

        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(rows, slice) },
        ],

        schema: BATCH_SCHEMA,
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: Math.max(
          MIN_COMPLETION_TOKENS,
          batch.length * TOKENS_PER_SKELETON
        ),
        maxRetries: Number.isFinite(Number(options.maxRetries))
          ? Number(options.maxRetries)
          : 1,

        fallback: () => ({ skeletons: [] }),
        client: options.client || null,
      });

      aiUsed = true;
    } catch (error) {
      const waitMs = getRateLimitWaitMs(error);

      failedBatches += 1;
      lastError = error;

      if (waitMs !== null && waitMs >= QUOTA_ABORT_THRESHOLD_MS) {
        const notAttempted = attempted.length - attemptedCount;

        aborted = {
          reason: 'rate_limit',
          retryAfterMs: waitMs,
          message: error?.message || 'rate limit reached',
          abortedAtBatch: batchIndex,
          batchesNotAttempted: batches.length - (batchIndex + 1),
          requirementsNotAttempted: notAttempted,
        };

        console.error(
          `[response/build] batch ${batchIndex + 1}/${batches.length} hit a ` +
            `rate limit needing ${Math.round(waitMs / 1000)}s — stopping, ` +
            `${aborted.batchesNotAttempted} batch(es) (${notAttempted} ` +
            `requirements) not attempted:`,
          error?.message
        );

        break;
      }

      console.error(
        `[response/build] batch ${batchIndex + 1}/${batches.length} failed ` +
          `(${batch.length} requirements):`,
        error?.message
      );

      continue;
    }

    if (response.usedFallback) {
      failedBatches += 1;

      console.error(
        `[response/build] batch ${batchIndex + 1}/${batches.length} returned ` +
          `an unusable response, reason=${response.reason}:`,
        JSON.stringify(response.errors)
      );

      lastError = {
        reason: response.reason,
        message:
          'The model returned an unusable response, so those requirements ' +
          'were not drafted. Everything already drafted is unaffected.',
        status: 0,
      };

      continue;
    }

    const returned = Array.isArray(response.data?.skeletons)
      ? response.data.skeletons
      : [];

    const fresh = [];

    batch.forEach((item, offset) => {
      // Prefer the model's own index so a reordered response cannot attach one
      // requirement's draft to another — the failure mode judgeFit and
      // classifyRequirements both guard against. The model numbers within its
      // batch; the caller's position is carried on the item.
      const entry =
        returned.find((row) => Number(row?.index) === offset + 1) ||
        returned[offset];

      const normalized = normalizeEntry(entry, slice);

      if (!normalized) {
        return;
      }

      if (normalized.hasPlaceholder) {
        placeholders += 1;
      }

      const skeleton = {
        ...normalized,
        index: item.index,
        requirementId: item.row.id,
        reqNumber: item.row.req_number || null,
        department: item.row.department || null,
        role: item.row.role || null,
      };

      skeletons[String(item.index)] = skeleton;
      fresh.push(skeleton);
    });

    // Persist before the next call, so a quota wall costs nothing already won.
    if (typeof options.onBatch === 'function' && fresh.length > 0) {
      try {
        await options.onBatch(fresh, {
          batchIndex,
          batches: batches.length,
          model,
        });
      } catch (hookError) {
        console.error(
          `[response/build] onBatch hook failed for batch ${batchIndex + 1}:`,
          hookError?.message
        );
      }
    }
  }

  const drafted = Object.keys(skeletons).length;

  const stats = {
    ...baseStats,
    requested: attemptedCount,
    drafted,
    undrafted: attemptedCount - drafted,
    placeholders,
    batches: aborted ? aborted.abortedAtBatch + 1 : batches.length,
    plannedBatches: batches.length,
    failedBatches,
    requirementsNotAttempted: attempted.length - attemptedCount,
    librarySelections,
    aborted,
    estimatedTokens: estimate.total,
    aiUsed,
  };

  if (drafted === 0) {
    const status = Number(lastError?.status || lastError?.statusCode || 0);

    console.error(
      '[response/build] nothing drafted across',
      batches.length,
      'batch(es)'
    );

    return {
      skeletons: {},
      stats,
      error: {
        reason: lastError?.reason || 'api-error',
        message:
          lastError?.message ||
          (aborted
            ? 'Groq’s rate limit was reached before any batch completed.'
            : 'The generation pass produced no usable drafts.'),
        status: aborted ? 429 : status,
      },
    };
  }

  console.log(
    '[response/build]',
    drafted,
    'of',
    attempted.length,
    'requirements drafted in',
    stats.batches,
    'batch(es), est.',
    estimate.label
  );

  return { skeletons, error: null, stats };
}

module.exports = {
  buildSkeletons,
  buildUserPrompt,
  renderLibrary,
  renderRequirement,
  normalizeEntry,
  orderForBatching,
  chunk,
  DEFAULT_BATCH_SIZE,
  MAX_REQUIREMENTS_PER_RUN,
};
