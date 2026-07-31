const {
  callGroqWithValidation,
  getErrorStatus,
  getRetryAfterMs,
} = require('../ai/groqHelper');
const { estimateJudgeTokens } = require('./judgeCost');

// §6.3 — soft fit. For each requirement §6.2 did NOT block, can the company
// do it: can-do / partial / gap, with evidence from both sides.
//
// "Soft" is the operative word. §6.2 already handled everything decidable by
// comparing two numbers or two names. What is left needs reading — "the
// contractor shall provide 24x7 tier-2 support" against a profile listing four
// support engineers in one time zone is a judgement, not an arithmetic check.
// That is the only reason this module is allowed to cost tokens.
//
// SMALL BATCHES, one call each, exactly as classifyRequirements does it.
//
// This started as a single call for the whole scan. That does not work: Groq
// counts `max_tokens` as part of the request, so 83 requirements asked for
// ~7,200 input + a 9,130-token completion reservation = 16,337 against a
// 12,000 TPM cap. A request larger than the entire window is rejected
// deterministically on every key — it is not a quota that waiting clears.
//
// Batching cuts both halves at once: fewer requirements per call means less
// input AND a proportionally smaller reservation. At 20 per call the peak is
// ~5,200 tokens, comfortably inside the cap even for unusually long
// requirements.
//
// The cost of batching is that the system prompt and the whole company profile
// are re-sent per call — the same tradeoff the linking pass accepts for its
// anchor catalog. For 84 requirements that is 5 copies, ~5,000 tokens of
// overhead against a ~20,000-token total.
//
// TPM IS A ROLLING 60-SECOND WINDOW, NOT A PER-REQUEST LIMIT. ~20,000 tokens
// of work against a 12,000-token window cannot finish inside one request on
// this tier, however it is sliced. So this does what classifyRequirements
// does: run batches until Groq says the wait is long, then stop, keep every
// judgment already earned, and report how far it got. A partial answer that
// says so is worth more than a failed one.
//
// Everything degrades, now per batch rather than all-or-nothing. groqHelper
// turns unusable content into the fallback instead of throwing, and the
// transport failures it does throw are caught here. A caller that gets nothing
// back still has every requirement and every §6.2 blocker — the judgement is
// an enhancement, never a dependency.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Classification, not prose, so the same low temperature the shredder's
// classifier uses.
const DEFAULT_TEMPERATURE = 0.1;

const REQUIREMENT_CHARS = 340;
const EVIDENCE_CHARS = 220;
const PROFILE_ITEM_CHARS = 160;

// 20 per call, the same size classifyRequirements settled on. Measured against
// this dataset that is ~1,000 fixed tokens (system prompt + profile) + ~2,000
// of requirement text + a 2,200-token completion reservation ≈ 5,200 per call,
// or 43% of the 12,000 TPM cap — margin enough that a batch of unusually long
// requirements still clears it.
//
// Deliberately not smaller. The ~1,000-token fixed cost is paid per call, so
// smaller batches spend MORE of the rolling window on overhead and judge fewer
// requirements before it empties: at 20 the window covers ~40 requirements, at
// 12 only ~36. The tradeoff is blast radius — one bad batch costs 20 rows
// their judgment, which is why failures are per batch and counted, not
// absorbed.
const DEFAULT_BATCH_SIZE = 20;

// Output budget for one batch. A truncated response is unparseable and
// degrades the whole batch, so this is generous rather than tight — but it is
// also what Groq counts toward TPM, so it scales with the batch instead of
// being a flat reservation.
const TOKENS_PER_JUDGMENT = 110;
const MIN_COMPLETION_TOKENS = 1500;

// A 429 asking us to wait longer than this is the rolling window being empty,
// not a blip: every remaining batch would fail the same way, so the run stops
// and returns what it has instead of firing doomed calls.
const QUOTA_ABORT_THRESHOLD_MS = 60000;

// Hard ceiling on ONE RUN, across all batches. Bounds total spend on a single
// press of the button; beyond it the remainder is reported as unjudged rather
// than quietly dropped.
const MAX_REQUIREMENTS_PER_RUN = 120;

// Mirrors classifyRequirements and explainFindings: groqHelper's uncertainty
// flagging only reaches TOP-LEVEL keys, and batching puts confidence one level
// down inside `judgments`, so the same rule is applied per item here.
const CONFIDENCE_THRESHOLD = 0.7;

const VALID_VERDICTS = ['can_do', 'partial', 'gap'];

const BATCH_SCHEMA = {
  judgments: 'array',
};

const SYSTEM_PROMPT = `You are assessing whether ONE specific company can meet requirements taken from a solicitation it is considering bidding on.

You are given the company's profile once, then a numbered list of requirements. For EACH requirement, decide how well this company — not a typical company — can meet it.

"verdict" is exactly one of:
   - "can_do": the profile shows the company already has what this requirement asks for. Something in the profile supports it directly.
   - "partial": the company has related capability but not clearly enough. It could meet this with effort, existing staff redeployed, or a modest addition.
   - "gap": nothing in the profile supports this, and meeting it would need a capability, credential, or resource the company does not appear to have.

RULES:
- Judge against the PROFILE YOU WERE GIVEN, not against what a competent contractor generally does. An empty or thin profile means more "gap" verdicts, and that is the correct answer.
- A requirement that any bidder satisfies by simply agreeing to it (accepting a term, following a procedure, submitting a report on time) is "can_do" unless the profile suggests otherwise.
- Do NOT decide whether the requirement is fair, risky, or negotiable. That is a different assessment.
- Do NOT invent certifications, staff, offices, revenue, or past projects that are not in the profile.
- Do NOT mark something a hard blocker. Missing certifications, insurance limits, and bonding were already checked separately by exact comparison before you saw this list.

"evidence_rfp": a SHORT quote or close paraphrase of the part of the requirement that drove your verdict. Under 20 words.
"evidence_profile": what in the profile supports or fails to support it, quoted or named. Under 20 words. If nothing in the profile is relevant, say "nothing in profile" — do not leave it blank and do not invent something.
"note": one sentence, under 25 words, on what it would actually take to meet this. Plain business English. No markdown.
"confidence": 0 to 1, how well the profile let you decide. Use a LOW value when the profile was too thin to tell.

Return one object per requirement, with "index" matching the requirement's number, for EVERY requirement, in order. Never omit one — use a low confidence instead.

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "judgments": [
    {
      "index": 1,
      "verdict": "partial",
      "evidence_rfp": "24x7 tier-2 support with a 1-hour response target",
      "evidence_profile": "4 support engineers, all US-Eastern",
      "note": "Round-the-clock cover needs either a second time zone or a paid on-call rotation.",
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
 * Groq states the delay in prose ("Please try again in 19m46.272s"). The
 * retry-after header is preferred when present, but this is the fallback
 * because a 429 that groqHelper declined to retry may carry no header at all.
 *
 * Same helper classifyRequirements uses, duplicated rather than shared: the
 * shredder is a different module with its own failure budget, and reaching
 * across into lib/shredder to borrow four lines would couple them.
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
 * A 429 with no usable hint is treated as the abort threshold: groqHelper only
 * surfaces a 429 after declining to retry it, so by that point the wait is
 * already known to be longer than it was willing to sleep.
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
 * Renders one profile list (certificates, staff, past projects, ...) as lines.
 *
 * Every field is free-form jsonb, so entries arrive as strings, as objects
 * from the settings form, or as a mix of both. Rather than demanding one
 * shape, this flattens whatever is there into readable text — a profile the
 * model can read is worth more than a profile that validates.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function describeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (entry === null || entry === undefined) {
        return '';
      }

      if (typeof entry !== 'object') {
        return clip(String(entry), PROFILE_ITEM_CHARS);
      }

      // Object entries render as "key: value" pairs so the model sees the
      // field names the user filled in, whatever they happen to be.
      const parts = Object.entries(entry)
        .filter(([, item]) => item !== null && item !== undefined && item !== '')
        .map(([key, item]) => `${key}: ${item}`);

      return clip(parts.join(', '), PROFILE_ITEM_CHARS);
    })
    .filter(Boolean);
}

/**
 * @param {number|null|undefined} value
 * @returns {string}
 */
function money(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? `$${Math.round(parsed).toLocaleString('en-US')}`
    : 'not stated';
}

/**
 * Renders the company profile for the prompt.
 *
 * Sent once per call, ahead of every requirement, because all of them are
 * judged against the same profile.
 *
 * @param {object|null} profile
 * @returns {string}
 */
function renderProfile(profile) {
  if (!profile) {
    return 'COMPANY PROFILE: none on file. Judge every requirement as "gap" with low confidence and say the profile is empty.';
  }

  const sections = [
    ['Certifications held', describeList(profile.certificates)],
    ['Registrations', describeList(profile.registrations)],
    ['Staff', describeList(profile.staff)],
    ['Geographies served', describeList(profile.geography)],
    ['Past projects', describeList(profile.past_projects)],
  ];

  const lines = ['COMPANY PROFILE'];

  lines.push(`Insurance limit carried: ${money(profile.insurance_limit)}`);
  lines.push(`Bonding capacity: ${money(profile.bonding_capacity)}`);

  for (const [label, items] of sections) {
    lines.push(
      items.length > 0
        ? `${label}:\n${items.map((item) => `  - ${item}`).join('\n')}`
        : `${label}: none listed`
    );
  }

  return lines.join('\n');
}

/**
 * Renders one requirement for the prompt.
 *
 * The REQ number goes in as context but the model is never asked to echo it —
 * alignment is by index, so a mangled REQ number cannot misattribute a
 * verdict.
 *
 * @param {object} requirement
 * @param {number} number 1-based position in the batch.
 * @returns {string}
 */
function renderRequirement(requirement, number) {
  const lines = [`Requirement ${number}:`];

  const meta = [
    requirement.req_number ? `ref ${requirement.req_number}` : '',
    requirement.department ? `owner: ${requirement.department}` : '',
    requirement.page ? `page ${requirement.page}` : '',
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
 * @param {object|null} profile
 * @returns {string}
 */
function buildUserPrompt(batch, profile) {
  const body = batch
    .map((requirement, offset) => renderRequirement(requirement, offset + 1))
    .join('\n\n');

  return (
    `${renderProfile(profile)}\n\n` +
    `Judge the following ${batch.length} requirement(s) against that profile. ` +
    `Return exactly ${batch.length} judgment object(s).\n\n${body}`
  );
}

/**
 * Validates one entry from the model's response.
 *
 * @param {unknown} entry
 * @returns {object|null} null when the entry is unusable, which leaves that
 *   requirement unjudged rather than showing an empty verdict.
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const verdict = String(entry.verdict || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  // An invalid verdict is not recoverable by guessing. Dropping the entry
  // leaves the requirement unjudged, which is honest; coercing it to
  // "partial" would invent a judgement nobody made.
  if (!VALID_VERDICTS.includes(verdict)) {
    return null;
  }

  const raw = Number(entry.confidence);
  const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

  return {
    verdict,
    evidenceRfp: clip(entry.evidence_rfp, EVIDENCE_CHARS),
    evidenceProfile: clip(entry.evidence_profile, EVIDENCE_CHARS),
    note: clip(entry.note, EVIDENCE_CHARS),
    confidence,
    // Usable, but worth a second look — the same rule the classifier and the
    // §5.3 explainer apply.
    needsReview: confidence < CONFIDENCE_THRESHOLD,
  };
}

/**
 * Judges soft fit for one RFP's unblocked requirements (§6.3).
 *
 * Never throws. Every failure mode resolves to "some or all requirements have
 * no judgement", which the UI is required to render normally.
 *
 * @param {Array<object>} requirements Unblocked work requirements, in the
 *   order the caller wants them judged. §6.2's `clear` list.
 * @param {object|null} profile The company_profile row.
 * @param {object} [options]
 * @param {string} [options.model='llama-3.3-70b-versatile']
 * @param {number} [options.batchSize=20] Requirements per Groq call.
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{judgments: Object<string, object>, stats: object,
 *   error: object|null}>}
 *   `judgments` is keyed by the requirement's 1-BASED POSITION IN THE FULL
 *   LIST, not by its row id and not by its position within a batch — the
 *   caller joins by index against the same array it passed in, and batching
 *   stays an implementation detail. Each judgment carries `reqNumber` so a
 *   rendered verdict can always name the requirement it belongs to. An index
 *   absent from the map simply has no judgement.
 *
 *   `error` is non-null only when NOTHING was judged. A run where some batches
 *   succeeded returns the judgments it earned with `error: null`, and reports
 *   the shortfall through `stats.failedBatches` / `stats.aborted` — a partial
 *   answer is a success with a caveat, not a failure.
 *
 * @example
 * const { judgments } = await judgeFit(clear, profile);
 * judgments['1'].verdict // 'partial'
 */
async function judgeFit(requirements, profile, options = {}) {
  const list = Array.isArray(requirements) ? requirements : [];

  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;

  const attempted = list.slice(0, MAX_REQUIREMENTS_PER_RUN);
  const skippedOverCap = list.length - attempted.length;

  const baseStats = {
    requirements: list.length,
    requested: 0,
    judged: 0,
    skippedOverCap,
    lowConfidence: 0,
    byVerdict: { can_do: 0, partial: 0, gap: 0 },
    batches: 0,
    plannedBatches: 0,
    failedBatches: 0,
    requirementsNotAttempted: 0,
    aborted: null,
    aiUsed: false,
  };

  if (attempted.length === 0) {
    return { judgments: {}, error: null, stats: baseStats };
  }

  const batches = chunk(attempted, batchSize);
  const estimate = estimateJudgeTokens(attempted.length, batchSize);

  const judgments = {};
  const byVerdict = { can_do: 0, partial: 0, gap: 0 };

  let lowConfidence = 0;
  let failedBatches = 0;
  let attemptedCount = 0;
  let aborted = null;
  let lastError = null;
  let aiUsed = false;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];

    // Position of this batch's first requirement in the FULL list. Every index
    // below is offset by it, so the returned keys stay global and the caller
    // never has to know a batch existed.
    const batchStart = batchIndex * batchSize;

    let response;

    try {
      attemptedCount += batch.length;

      response = await callGroqWithValidation({
        model: options.model || DEFAULT_MODEL,

        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(batch, profile) },
        ],

        schema: BATCH_SCHEMA,
        temperature: DEFAULT_TEMPERATURE,
        // Scales with the batch. Groq counts this reservation toward TPM, so a
        // flat budget would put the old 9,130-token request back.
        maxTokens: Math.max(
          MIN_COMPLETION_TOKENS,
          batch.length * TOKENS_PER_JUDGMENT
        ),
        maxRetries: Number.isFinite(Number(options.maxRetries))
          ? Number(options.maxRetries)
          : 1,

        fallback: () => ({ judgments: [] }),
        client: options.client || null,
      });

      aiUsed = true;
    } catch (error) {
      // Transport failure — rate limit, 5xx, exhausted retries. groqHelper
      // re-throws these so callers can map their own status codes.
      const waitMs = getRateLimitWaitMs(error);

      failedBatches += 1;
      lastError = error;

      if (waitMs !== null && waitMs >= QUOTA_ABORT_THRESHOLD_MS) {
        // The rolling window is empty. Every remaining batch would fail the
        // same way, so stop and keep what has already been judged.
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
          `[fit/judge] batch ${batchIndex + 1}/${batches.length} hit a rate ` +
            `limit needing ${Math.round(waitMs / 1000)}s — stopping, ` +
            `${aborted.batchesNotAttempted} batch(es) (${notAttempted} ` +
            `requirements) not attempted:`,
          error?.message
        );

        break;
      }

      console.error(
        `[fit/judge] batch ${batchIndex + 1}/${batches.length} failed ` +
          `(${batch.length} requirements):`,
        error?.message
      );

      continue;
    }

    if (response.usedFallback) {
      failedBatches += 1;

      console.error(
        `[fit/judge] batch ${batchIndex + 1}/${batches.length} returned an ` +
          `unusable response (${batch.length} requirements), reason=` +
          `${response.reason}:`,
        JSON.stringify(response.errors)
      );

      lastError = {
        reason: response.reason,
        message:
          'The model returned an unusable response, so those requirements ' +
          'were not judged. The blocker checks are unaffected.',
        status: 0,
      };

      continue;
    }

    const entries = Array.isArray(response.data?.judgments)
      ? response.data.judgments
      : [];

    batch.forEach((requirement, offset) => {
      // Prefer the model's own index, so a reordered response cannot attach one
      // requirement's verdict to a different requirement — the same failure
      // mode classifyRequirements and explainFindings both guard against. The
      // model numbers 1..batchSize within its own batch; the global position is
      // recovered by adding batchStart.
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

      byVerdict[normalized.verdict] += 1;

      const globalIndex = batchStart + offset + 1;

      judgments[String(globalIndex)] = {
        ...normalized,
        index: globalIndex,
        // Carried through so a rendered verdict can name its requirement
        // without the consumer having to hold the batch array to join against.
        reqNumber: requirement.req_number || null,
        department: requirement.department || null,
        page: requirement.page ?? null,
        requirementText: clip(requirement.requirement_text, EVIDENCE_CHARS),
      };
    });
  }

  const judged = Object.keys(judgments).length;

  const stats = {
    ...baseStats,
    requested: attemptedCount,
    judged,
    // A requirement the model skipped or answered unusably. It renders with no
    // verdict rather than a guessed one.
    unjudged: attemptedCount - judged,
    lowConfidence,
    byVerdict,
    batches: aborted ? aborted.abortedAtBatch + 1 : batches.length,
    plannedBatches: batches.length,
    failedBatches,
    requirementsNotAttempted: attempted.length - attemptedCount,
    aborted,
    estimatedTokens: estimate.total,
    aiUsed,
  };

  // Only a run that produced NOTHING is an error. Anything else is a usable
  // result the caller should render, with the shortfall reported in stats —
  // returning an error alongside 60 good judgments would make the route treat
  // a mostly-successful run as a failure.
  if (judged === 0) {
    const status = Number(
      lastError?.status || lastError?.statusCode || 0
    );

    console.error('[fit/judge] no requirements judged across', batches.length, 'batch(es)');

    return {
      judgments: {},
      stats,
      error: {
        reason: lastError?.reason || 'api-error',
        message:
          lastError?.message ||
          (aborted
            ? 'Groq’s rate limit was reached before any batch completed.'
            : 'The fit judgment produced no usable results.'),
        status: aborted ? 429 : status,
      },
    };
  }

  console.log(
    '[fit/judge]',
    judged,
    'of',
    attempted.length,
    'requirements judged in',
    stats.batches,
    'batch(es), est.',
    estimate.label
  );

  return { judgments, error: null, stats };
}

module.exports = {
  judgeFit,
  buildUserPrompt,
  renderProfile,
  renderRequirement,
  normalizeEntry,
  chunk,
  DEFAULT_BATCH_SIZE,
  MAX_REQUIREMENTS_PER_RUN,
  CONFIDENCE_THRESHOLD,
  VALID_VERDICTS,
};
