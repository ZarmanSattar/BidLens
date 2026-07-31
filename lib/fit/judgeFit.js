const { callGroqWithValidation } = require('../ai/groqHelper');
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
// ONE batched call for the whole scan, for the same reasons explainFindings.js
// batches: the system prompt and the entire company profile are re-sent per
// call, so N calls means N copies of both, and a model shown one requirement
// at a time cannot tell that six of them describe the same capability.
//
// Everything degrades. groqHelper turns unusable content into the fallback
// instead of throwing, and the transport failures it does throw are caught
// here. A caller that gets nothing back still has every requirement and every
// §6.2 blocker — the judgement is an enhancement, never a dependency.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Classification, not prose, so the same low temperature the shredder's
// classifier uses.
const DEFAULT_TEMPERATURE = 0.1;

const REQUIREMENT_CHARS = 340;
const EVIDENCE_CHARS = 220;
const PROFILE_ITEM_CHARS = 160;

// Hard ceiling on one call. The ODU dataset produces 84 unblocked work
// requirements, so this leaves headroom without letting an unbounded batch
// become an unbounded prompt. Beyond it the remainder is reported as unjudged
// rather than quietly dropped.
const MAX_REQUIREMENTS_PER_CALL = 120;

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
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{judgments: Object<string, object>, stats: object,
 *   error: object|null}>}
 *   `judgments` is keyed by the requirement's 1-BASED POSITION in the batch,
 *   not by its row id — the caller joins by index against the same array it
 *   passed in. Each judgment carries `reqNumber` so a rendered verdict can
 *   always name the requirement it belongs to. An index absent from the map
 *   simply has no judgement.
 *
 * @example
 * const { judgments } = await judgeFit(clear, profile);
 * judgments['1'].verdict // 'partial'
 */
async function judgeFit(requirements, profile, options = {}) {
  const list = Array.isArray(requirements) ? requirements : [];

  const empty = (error, extra = {}) => ({
    judgments: {},
    error,
    stats: {
      requirements: list.length,
      requested: 0,
      judged: 0,
      skippedOverCap: 0,
      lowConfidence: 0,
      byVerdict: { can_do: 0, partial: 0, gap: 0 },
      aiUsed: false,
      ...extra,
    },
  });

  if (list.length === 0) {
    return empty(null);
  }

  const batch = list.slice(0, MAX_REQUIREMENTS_PER_CALL);
  const skippedOverCap = list.length - batch.length;

  const estimate = estimateJudgeTokens(batch.length);

  let response;

  try {
    response = await callGroqWithValidation({
      model: options.model || DEFAULT_MODEL,

      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(batch, profile) },
      ],

      schema: BATCH_SCHEMA,
      temperature: DEFAULT_TEMPERATURE,
      // ~75 tokens of JSON per judgment. A truncated response is unparseable
      // and costs the whole batch, so the budget is generous rather than tight.
      maxTokens: Math.max(2000, batch.length * 110),
      maxRetries: Number.isFinite(Number(options.maxRetries))
        ? Number(options.maxRetries)
        : 1,

      fallback: () => ({ judgments: [] }),
      client: options.client || null,
    });
  } catch (error) {
    // Transport failure — rate limit, 5xx, exhausted retries. groqHelper
    // re-throws these so callers can map their own status codes.
    console.error('[fit/judge] call failed:', error?.message);

    return empty(
      {
        reason: 'api-error',
        message: error?.message || 'The fit judgment call failed.',
        status: Number(error?.status || error?.statusCode || 0),
      },
      { requested: batch.length, skippedOverCap }
    );
  }

  if (response.usedFallback) {
    console.error(
      '[fit/judge] unusable response, reason=' + response.reason + ':',
      JSON.stringify(response.errors)
    );

    return empty(
      {
        reason: response.reason,
        message:
          'The model returned an unusable response, so no fit judgments were ' +
          'generated. The blocker checks above are unaffected.',
        status: 0,
      },
      { requested: batch.length, skippedOverCap, aiUsed: true }
    );
  }

  const entries = Array.isArray(response.data?.judgments)
    ? response.data.judgments
    : [];

  const judgments = {};
  const byVerdict = { can_do: 0, partial: 0, gap: 0 };

  let lowConfidence = 0;

  batch.forEach((requirement, offset) => {
    // Prefer the model's own index, so a reordered response cannot attach one
    // requirement's verdict to a different requirement — the same failure mode
    // classifyRequirements and explainFindings both guard against.
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

    judgments[String(offset + 1)] = {
      ...normalized,
      index: offset + 1,
      // Carried through so a rendered verdict can name its requirement without
      // the consumer having to hold the batch array to join against.
      reqNumber: requirement.req_number || null,
      department: requirement.department || null,
      page: requirement.page ?? null,
      requirementText: clip(requirement.requirement_text, EVIDENCE_CHARS),
    };
  });

  const judged = Object.keys(judgments).length;

  console.log(
    '[fit/judge]',
    judged,
    'of',
    batch.length,
    'requirements judged in 1 call, est.',
    estimate.label
  );

  return {
    judgments,
    error: null,
    stats: {
      requirements: list.length,
      requested: batch.length,
      judged,
      // A requirement the model skipped or answered unusably. It renders with
      // no verdict rather than a guessed one.
      unjudged: batch.length - judged,
      skippedOverCap,
      lowConfidence,
      byVerdict,
      attempts: response.attempts,
      estimatedTokens: estimate.total,
      aiUsed: true,
    },
  };
}

module.exports = {
  judgeFit,
  buildUserPrompt,
  renderProfile,
  renderRequirement,
  normalizeEntry,
  MAX_REQUIREMENTS_PER_CALL,
  CONFIDENCE_THRESHOLD,
  VALID_VERDICTS,
};
