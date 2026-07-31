const {
  callGroqWithValidation,
  getErrorStatus,
  getRetryAfterMs,
} = require('../ai/groqHelper');

// §4.4 — the linking pass. A lighter second pass over rows §4.2 already
// classified, so it never re-reads the PDF and never re-decides a role.
//
// Two passes, because the two kinds of relationship in the plan are not the
// same kind of problem:
//
//   Pass A — structural, plain code, zero tokens.
//     Enumerated sub-items ("a.", "b.", "c.") belong to the numbered item
//     above them. That is visible in the text itself, so paying a model to
//     notice it would be waste.
//
//   Pass B — semantic, batched AI.
//     "This work requirement is submitted under that instruction" and
//     "scored by that factor" are NOT structurally derivable. The two ends of
//     such a pair sit in different sections by definition: on the ODU RFP the
//     evaluation factors live in "IX. EVALUATION CRITERIA AND AWARD PROCESS"
//     and the work they score lives in the statement-of-needs and terms
//     sections. Matching on section would therefore link evaluation factors to
//     each other and nothing else — 29 rows in that one section is an 812-pair
//     clique of links that say only "these were printed near each other".
//
// Pass B's cost is bounded by narrowing before asking. Only work_requirement
// rows are candidate sources, and only submission_instruction and
// evaluation_factor rows are candidate targets. not_applicable rows are
// excluded outright — a sentence that obligates nobody is not submitted under
// anything and is not scored by anything.

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// 12 sources per call. The anchor catalog is re-sent on every call and is the
// dominant cost, so larger batches amortize it — but the catalog plus 12
// sources plus the system prompt is already ~4k input tokens, and pushing the
// batch higher mostly grows the output budget, which is where truncation
// (and therefore a wholly unusable batch) starts to bite.
const DEFAULT_SOURCE_BATCH_SIZE = 12;

// Enough of each row for the model to judge subject matter. Full requirement
// text is not needed to decide "is this the thing that factor scores?", and
// the anchor catalog is paid for once per call.
const ANCHOR_TEXT_CHARS = 160;
const SOURCE_TEXT_CHARS = 400;

// Beyond this the catalog stops fitting in a sane prompt. No ODU-scale
// document comes close (51 anchors); the cap exists so a pathological RFP
// degrades to "linked the highest-confidence anchors" instead of blowing the
// token budget. Reported in stats so a truncated run is never silent.
const MAX_ANCHORS = 150;

// At most 2 links per source. A work requirement genuinely submitted under
// three different instructions is rare; a model returning six is padding.
const MAX_LINKS_PER_SOURCE = 2;

const MAX_NOTE_CHARS = 160;

const TOKENS_PER_SOURCE_RESULT = 60;
const MIN_COMPLETION_TOKENS = 1200;

// Same rule classifyRequirements uses: a 429 asking for longer than this is a
// quota wall, not a blip, so the run stops and the caller persists what landed.
const QUOTA_ABORT_THRESHOLD_MS = 60000;

// How far back Pass A will look for a sub-item's parent. Sub-items run in
// short blocks; a gap wider than this means the enumerator is not a
// continuation of anything, it just happens to start with a letter.
const PARENT_LOOKBACK = 20;

const SOURCE_ROLE = 'work_requirement';
const ANCHOR_ROLES = ['submission_instruction', 'evaluation_factor'];

// Relationship kinds. These are the vocabulary of relationship_note's prefix —
// the column is free text, so the prefix is what makes a link machine-readable
// after the fact (the Traceability Matrix badges on it).
const KIND_SUB_ITEM = 'sub_item_of';
const KIND_SUBMITTED_UNDER = 'submitted_under';
const KIND_SCORED_BY = 'scored_by';

const AI_KINDS = [KIND_SUBMITTED_UNDER, KIND_SCORED_BY];

// Which kind an anchor's role implies. The model is asked for a kind, but the
// anchor it picked is the real signal, so a mismatch is corrected rather than
// dropped.
const KIND_BY_ANCHOR_ROLE = {
  submission_instruction: KIND_SUBMITTED_UNDER,
  evaluation_factor: KIND_SCORED_BY,
};

const BATCH_SCHEMA = {
  results: 'array',
};

/**
 * Lowercase-letter or lowercase-roman enumerators: "a.", "(b)", "iv)".
 *
 * Deliberately lowercase-only. Digit enumerators ("1.", "2.1") head top-level
 * items and uppercase ones ("A. COMPLIANCE:") are section headings, so
 * treating either as a sub-item would inverse the parent relationship.
 *
 * The trailing `\s+\S` is what keeps "e.g. foo" out: "e" then "." then "g",
 * with no whitespace between, fails the match.
 */
const SUB_ITEM_PATTERN = /^\s*\(?(?:[a-z]{1,2}|[ivxlcdm]{1,5})\)?[.)]\s+\S/;

const SYSTEM_PROMPT = `You are linking requirements that were already extracted and classified from ONE government RFP.

You are given:
  - a CATALOG of anchor requirements. Each is either a submission instruction (what the proposal document must contain) or an evaluation factor (what the issuer will score).
  - a batch of WORK REQUIREMENTS: things the contractor must do, deliver, staff, maintain, or comply with if awarded.

For each work requirement, identify which catalog anchors — if any — it is specifically related to:

  - "submitted_under": the anchor is a submission instruction directing the bidder to describe, document, or evidence THIS work inside the proposal.
  - "scored_by": the anchor is an evaluation factor the issuer will use to score how well the bidder addresses THIS work.

THE MOST IMPORTANT RULE: most work requirements link to NOTHING. An empty "links" array is a correct, expected, and common answer. Only link when the two texts are about the SAME SPECIFIC SUBJECT MATTER — the same system, deliverable, service, certification, staffing duty, or data obligation.

Do NOT link because:
  - both belong to the same contract or the same RFP,
  - both are generically about "the contractor" or "the work",
  - the anchor is a broad catch-all ("describe your approach", "submit all required forms"),
  - the wording merely sounds similar.

Return at most ${MAX_LINKS_PER_SOURCE} links per work requirement. Fewer is better. Use only "req" values that appear in the CATALOG, exactly as written.

Give each link a "note": one short clause (under 20 words) naming the shared subject, e.g. "both concern the search index refresh SLA". Do not restate either requirement.

Return one valid JSON object only. No markdown, no code fences, no commentary.

Use exactly this structure:

{
  "results": [
    {
      "index": 1,
      "links": [
        { "req": "REQ-044", "kind": "scored_by", "note": "both concern prior enterprise search implementations" }
      ]
    },
    {
      "index": 2,
      "links": []
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
 * Numeric tail of a REQ number, for document-order sorting.
 *
 * REQ numbers are issued in candidate order and never reassigned, so the
 * sequence IS document order — which is what Pass A's "the item above this
 * one" depends on.
 *
 * @param {string} reqNumber
 * @returns {number} 0 when there is no trailing number.
 */
function sequenceOf(reqNumber) {
  const match = /(\d+)\s*$/.exec(String(reqNumber || ''));

  return match ? Number(match[1]) : 0;
}

/**
 * @param {string} text
 * @returns {boolean} True when the line opens with a sub-item enumerator.
 */
function isSubItem(text) {
  return SUB_ITEM_PATTERN.test(String(text || ''));
}

/**
 * Builds a relationship_note. The kind prefix is the machine-readable part.
 *
 * @param {string} kind
 * @param {string} detail
 * @returns {string}
 */
function formatNote(kind, detail) {
  const trimmed = String(detail || '').replace(/\s+/g, ' ').trim();

  if (!trimmed) {
    return kind;
  }

  return `${kind}: ${trimmed.slice(0, MAX_NOTE_CHARS)}`;
}

/**
 * Pass A — enumerated sub-items linked to the item they continue.
 *
 * A row whose text opens with a lowercase letter or roman enumerator is a
 * continuation of the nearest preceding row that does NOT, provided the two
 * share a section and sit on the same page or across one page break. Other
 * sub-items are skipped over on the way up, so "a.", "b.", and "c." all
 * resolve to the same numbered parent rather than chaining to each other.
 *
 * Runs on every row regardless of role: an enumerated continuation is a fact
 * about the document's layout, not about what the classifier decided.
 *
 * @param {Array<object>} ordered Requirements in document order.
 * @returns {Array<{requirement_id: string, linked_requirement_id: string,
 *   relationship_note: string}>}
 */
function findSubItemLinks(ordered) {
  const links = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];

    if (!isSubItem(row.requirement_text)) {
      continue;
    }

    const start = Math.max(0, index - PARENT_LOOKBACK);

    for (let back = index - 1; back >= start; back -= 1) {
      const candidate = ordered[back];

      // Section is the strongest grouping signal available. A null section
      // cannot be matched against anything, so those rows get no parent
      // rather than a guessed one.
      if (!candidate.section || candidate.section !== row.section) {
        break;
      }

      if (isSubItem(candidate.requirement_text)) {
        continue;
      }

      // Same page, or the parent immediately before a page break.
      const samePage =
        Number.isFinite(Number(row.page)) &&
        Number.isFinite(Number(candidate.page)) &&
        Number(row.page) - Number(candidate.page) <= 1;

      if (!samePage) {
        break;
      }

      links.push({
        requirement_id: row.id,
        linked_requirement_id: candidate.id,
        relationship_note: formatNote(
          KIND_SUB_ITEM,
          `enumerated continuation of ${candidate.req_number} in ${row.section}`
        ),
      });

      break;
    }
  }

  return links;
}

/**
 * Renders the anchor catalog re-sent on every Pass B call.
 *
 * @param {Array<object>} anchors
 * @returns {string}
 */
function buildCatalog(anchors) {
  return anchors
    .map((anchor) => {
      const text = String(anchor.requirement_text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, ANCHOR_TEXT_CHARS);

      const section = anchor.section ? ` | Section: ${anchor.section}` : '';

      return `${anchor.req_number} [${anchor.role}]${section}\n  ${text}`;
    })
    .join('\n');
}

/**
 * Renders one batch of work requirements as the user message.
 *
 * @param {Array<object>} batch
 * @param {string} catalog
 * @param {number} anchorCount
 * @returns {string}
 */
function buildUserPrompt(batch, catalog, anchorCount) {
  const body = batch
    .map((row, offset) => {
      const text = String(row.requirement_text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SOURCE_TEXT_CHARS);

      const section = row.section ? `\nSection: ${row.section}` : '';

      return `Work requirement ${offset + 1}:${section}\nText: ${text}`;
    })
    .join('\n\n');

  return (
    `CATALOG (${anchorCount} anchors):\n${catalog}\n\n` +
    `Now link the following ${batch.length} work requirement(s). ` +
    `Return exactly ${batch.length} result object(s), one per work ` +
    `requirement, in order. Most should have an empty "links" array.` +
    `\n\n${body}`
  );
}

/**
 * Reads the wait time out of a Groq rate-limit message body.
 *
 * Groq states the delay in prose ("Please try again in 19m46.272s"). The
 * header is preferred when present, but a 429 groqHelper declined to retry
 * may carry no header at all.
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
 * How long a 429 wants us to wait, or null if this is not a rate limit.
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
 * Turns one model-proposed link into a row, or null if it is unusable.
 *
 * The anchor the model picked is trusted over the kind it labelled the link
 * with: "REQ-044" identifies a row whose role already determines whether this
 * is submitted_under or scored_by, so a mislabelled kind is corrected rather
 * than thrown away. A req that is not in the catalog at all IS thrown away —
 * that is the model inventing an anchor.
 *
 * @param {object} source
 * @param {unknown} entry
 * @param {Map<string, object>} anchorsByNumber
 * @param {{invented: number, coerced: number}} counters Mutated in place.
 * @returns {object|null}
 */
function toLinkRow(source, entry, anchorsByNumber, counters) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const reqNumber = String(entry.req || '').trim();
  const anchor = anchorsByNumber.get(reqNumber);

  if (!anchor) {
    counters.invented += 1;

    return null;
  }

  // The check constraint forbids it, and a row that links to itself carries
  // no information anyway.
  if (anchor.id === source.id) {
    return null;
  }

  const claimedKind = String(entry.kind || '').trim();
  const trueKind = KIND_BY_ANCHOR_ROLE[anchor.role];

  if (AI_KINDS.includes(claimedKind) && claimedKind !== trueKind) {
    counters.coerced += 1;
  }

  return {
    requirement_id: source.id,
    linked_requirement_id: anchor.id,
    relationship_note: formatNote(
      trueKind,
      `${anchor.req_number} — ${entry.note || 'related subject matter'}`
    ),
  };
}

/**
 * Links classified requirements to each other (§4.4).
 *
 * Pure with respect to the database: it reads rows it is handed and returns
 * rows to write. Persisting them — and deciding what an existing link set
 * means — is the caller's job.
 *
 * @param {Array<{id: string, req_number: string, requirement_text: string,
 *   page: number|null, section: string|null, role: string|null}>} requirements
 *   Every classified row for ONE rfp.
 * @param {object} [options]
 * @param {number} [options.sourceBatchSize=12] Work requirements per Groq call.
 * @param {string} [options.model='llama-3.3-70b-versatile']
 * @param {boolean} [options.skipAi=false] Run Pass A only. Costs no tokens —
 *   used to exercise the pipeline without spending quota.
 * @param {number} [options.maxRetries=1] Passed through to groqHelper.
 * @param {object} [options.client] Groq client override, for tests.
 *
 * @returns {Promise<{links: Array<object>, aborted: object|null,
 *   stats: object}>}
 *   `links` are deduplicated insert-ready rows for requirement_links.
 *   `aborted` describes a rate-limit stop; the links found before it are still
 *   returned and are still valid.
 *
 * @example
 * const { links, stats } = await linkRequirements(rows);
 */
async function linkRequirements(requirements, options = {}) {
  const list = Array.isArray(requirements) ? requirements : [];

  const ordered = [...list].sort(
    (a, b) => sequenceOf(a.req_number) - sequenceOf(b.req_number)
  );

  const structural = findSubItemLinks(ordered);

  const sources = ordered.filter((row) => row.role === SOURCE_ROLE);

  let anchors = ordered.filter((row) => ANCHOR_ROLES.includes(row.role));
  let anchorsTruncated = 0;

  if (anchors.length > MAX_ANCHORS) {
    anchorsTruncated = anchors.length - MAX_ANCHORS;

    // Keep the anchors the classifier was most sure about — a low-confidence
    // anchor is the worst thing to hang a link off.
    anchors = [...anchors]
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, MAX_ANCHORS)
      .sort((a, b) => sequenceOf(a.req_number) - sequenceOf(b.req_number));
  }

  const semantic = [];
  const counters = { invented: 0, coerced: 0, missingResult: 0 };

  let batchesSent = 0;
  let failedBatches = 0;
  let aborted = null;

  const skipAi =
    options.skipAi === true || sources.length === 0 || anchors.length === 0;

  const batchSize =
    Number(options.sourceBatchSize) || DEFAULT_SOURCE_BATCH_SIZE;

  const batches = skipAi ? [] : chunk(sources, batchSize);

  const catalog = skipAi ? '' : buildCatalog(anchors);

  const anchorsByNumber = new Map(
    anchors.map((anchor) => [anchor.req_number, anchor])
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];

    let response;

    try {
      response = await callGroqWithValidation({
        model: options.model || DEFAULT_MODEL,

        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt(batch, catalog, anchors.length),
          },
        ],

        schema: BATCH_SCHEMA,
        temperature: 0.1,
        maxTokens: Math.max(
          MIN_COMPLETION_TOKENS,
          batch.length * TOKENS_PER_SOURCE_RESULT
        ),
        maxRetries: Number.isFinite(Number(options.maxRetries))
          ? Number(options.maxRetries)
          : 1,

        fallback: () => ({ results: [] }),
        client: options.client || null,
      });

      batchesSent += 1;
    } catch (error) {
      const waitMs = getRateLimitWaitMs(error);

      failedBatches += 1;
      batchesSent += 1;

      // Unlike §4.2, a failed batch here costs nothing but links. The
      // requirements themselves are already classified and persisted, so
      // there is no degraded row to write — the sources in this batch simply
      // end up unlinked, which is also what "no relationship" looks like.
      if (waitMs !== null && waitMs >= QUOTA_ABORT_THRESHOLD_MS) {
        // Batches before this one were full size; this one and everything
        // after it produced nothing.
        const sourcesNotAttempted = sources.length - batchIndex * batchSize;

        aborted = {
          reason: 'rate_limit',
          retryAfterMs: waitMs,
          message: error?.message || 'rate limit reached',
          abortedAtBatch: batchIndex,
          batchesNotAttempted: batches.length - (batchIndex + 1),
          sourcesNotAttempted,
        };

        console.error(
          `[link] batch ${batchIndex + 1}/${batches.length} hit a rate limit ` +
            `needing ${Math.round(waitMs / 1000)}s — aborting run, ` +
            `${aborted.batchesNotAttempted} batches not attempted:`,
          error?.message
        );

        break;
      }

      console.error(
        `[link] batch ${batchIndex + 1}/${batches.length} failed ` +
          `(${batch.length} work requirements):`,
        error?.message
      );

      continue;
    }

    if (response.usedFallback) {
      failedBatches += 1;

      console.error(
        `[link] batch ${batchIndex + 1}/${batches.length} returned an ` +
          `unusable response, reason=${response.reason}:`,
        JSON.stringify(response.errors)
      );

      continue;
    }

    const entries = Array.isArray(response.data?.results)
      ? response.data.results
      : [];

    batch.forEach((source, offset) => {
      // Prefer the model's own index, so a reordered response cannot attach
      // one row's links to a different row.
      const entry =
        entries.find((item) => Number(item?.index) === offset + 1) ||
        entries[offset];

      if (!entry) {
        counters.missingResult += 1;

        return;
      }

      const proposed = Array.isArray(entry.links) ? entry.links : [];

      for (const item of proposed.slice(0, MAX_LINKS_PER_SOURCE)) {
        const row = toLinkRow(source, item, anchorsByNumber, counters);

        if (row) {
          semantic.push(row);
        }
      }
    });
  }

  // Pass A first, so a pair found both structurally and semantically keeps the
  // structural note — that one is derived from the document, not inferred.
  const seen = new Set();
  const links = [];

  for (const link of [...structural, ...semantic]) {
    const key = `${link.requirement_id}|${link.linked_requirement_id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    links.push(link);
  }

  const byKind = {};

  for (const link of links) {
    const kind = link.relationship_note.split(':')[0];

    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  return {
    links,
    aborted,
    stats: {
      requirements: list.length,
      sources: sources.length,
      anchors: anchors.length,
      anchorsTruncated,
      structuralLinks: structural.length,
      semanticLinks: semantic.length,
      duplicatesDropped: structural.length + semantic.length - links.length,
      totalLinks: links.length,
      batchesSent,
      plannedBatches: batches.length,
      failedBatches,
      // Anchors the model named that do not exist, and links whose kind
      // disagreed with the anchor's own role. Both are model-quality signals
      // worth seeing rather than absorbing silently.
      inventedAnchors: counters.invented,
      coercedKinds: counters.coerced,
      missingResults: counters.missingResult,
      byKind,
      aiSkipped: skipAi,
    },
  };
}

module.exports = {
  linkRequirements,
  findSubItemLinks,
  isSubItem,
  SOURCE_ROLE,
  ANCHOR_ROLES,
  KIND_SUB_ITEM,
  KIND_SUBMITTED_UNDER,
  KIND_SCORED_BY,
};
