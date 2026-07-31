// §8.2 — choosing which content library entries go into each batch's prompt.
//
// Part 1 documented the decision and flagged the constraint: send the library
// directly in the prompt (no embeddings, no index, no retrieval model), but
// the library is resent with EVERY batch exactly like §6.3's company profile,
// and a full library pushes the per-call total toward the 12,000 TPM cap as it
// grows. This is the filtering that Part 1 recommended.
//
// FILTERING, NOT RETRIEVAL. Every rule here is a deterministic lookup a person
// can predict and argue with — a department-to-category map, literal tag
// matching, and a token budget. Nothing is scored by a model, so the same
// batch always gets the same library slice, and when the wrong entry is picked
// the reason is inspectable rather than buried in an embedding.

/**
 * Which library categories plausibly help a requirement owned by each
 * department. Deliberately generous — a missing category means the model never
 * sees content it needed, which is a worse failure than one wasted paragraph.
 */
const DEPARTMENT_CATEGORIES = {
  Technical: ['standard_approach', 'past_project', 'staff_bio', 'certificate'],
  Operations: ['standard_approach', 'past_project', 'staff_bio'],
  Financial: ['company_description', 'certificate', 'past_project'],
  Legal: ['certificate', 'company_description'],
  'Human Resources': ['staff_bio', 'company_description', 'standard_approach'],
  Sales: ['company_description', 'past_project'],
};

/**
 * Categories included for every batch regardless of department.
 *
 * A response that never says who the company is reads as a fragment. This is
 * one or two short entries, so the cost of always carrying it is small.
 */
const ALWAYS_CATEGORIES = ['company_description'];

/** Fallback when a requirement has no department (classifier declined one). */
const DEFAULT_CATEGORIES = [
  'company_description',
  'standard_approach',
  'past_project',
];

/**
 * Ceiling on the library portion of one prompt.
 *
 * The whole point of filtering. Measured against the §6.3 shape, a call is
 * roughly: 750 system + LIBRARY + 1,100 requirement text + 2,500 completion
 * reservation. At 1,800 that totals ~6,150 against a 12,000 cap — margin that
 * survives the library tripling in size, because this budget does not move
 * when the library grows.
 */
const MAX_LIBRARY_TOKENS = 1800;

/** Rough token estimate. Deliberately crude; it only has to bound a budget. */
const CHARS_PER_TOKEN = 4;

/** Never send more than this many entries, however small they are. */
const MAX_ENTRIES = 14;

/**
 * @param {object} entry
 * @returns {number}
 */
function estimateEntryTokens(entry) {
  const text = `${entry.title || ''}\n${entry.content || ''}`;

  return Math.ceil(text.length / CHARS_PER_TOKEN) + 8;
}

/**
 * The categories relevant to a set of departments.
 *
 * A batch usually holds one department (the caller sorts by it), but boundary
 * batches can span two, in which case the union is used — a requirement must
 * never lose access to its own categories because it shared a batch.
 *
 * @param {Array<string|null>} departments
 * @returns {string[]}
 */
function categoriesForDepartments(departments) {
  const wanted = new Set(ALWAYS_CATEGORIES);

  const list = Array.isArray(departments) ? departments : [];

  if (list.length === 0) {
    DEFAULT_CATEGORIES.forEach((category) => wanted.add(category));
  }

  for (const department of list) {
    const mapped = DEPARTMENT_CATEGORIES[department] || DEFAULT_CATEGORIES;

    mapped.forEach((category) => wanted.add(category));
  }

  return [...wanted];
}

/**
 * Whether any of an entry's tags appears literally in the batch's text.
 *
 * Word-boundary matching on the tag, so "eva" cannot match "evaluation" and a
 * tag like "508" still matches "Section 508". This is the cheap half of
 * relevance: an entry tagged `drupal` genuinely belongs with a requirement
 * that says Drupal.
 *
 * @param {object} entry
 * @param {string} haystack Lowercased concatenation of the batch's text.
 * @returns {number} How many distinct tags matched.
 */
function countTagHits(entry, haystack) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];

  let hits = 0;

  for (const rawTag of tags) {
    const tag = String(rawTag || '').trim().toLowerCase();

    if (tag.length < 3) {
      continue;
    }

    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack)) {
      hits += 1;
    }
  }

  return hits;
}

/**
 * Picks the library entries to send with one batch.
 *
 * Pure and deterministic: same batch plus same library always yields the same
 * slice, in the same order.
 *
 * @param {Array<object>} entries All content_library rows.
 * @param {Array<object>} batch The requirements in this batch.
 * @param {object} [options]
 * @param {number} [options.maxTokens=1800] Library budget for this prompt.
 * @param {number} [options.maxEntries=14]
 *
 * @returns {{entries: Array<object>, stats: object}}
 *   `stats` explains the choice — which categories were allowed, how many
 *   entries were dropped, and the estimated token weight actually sent.
 *
 * @example
 * const { entries } = selectLibraryForBatch(library, batch);
 */
function selectLibraryForBatch(entries, batch, options = {}) {
  const library = Array.isArray(entries) ? entries : [];
  const rows = Array.isArray(batch) ? batch : [];

  const maxTokens = Number.isFinite(Number(options.maxTokens))
    ? Number(options.maxTokens)
    : MAX_LIBRARY_TOKENS;

  const maxEntries = Number.isFinite(Number(options.maxEntries))
    ? Number(options.maxEntries)
    : MAX_ENTRIES;

  if (library.length === 0) {
    return {
      entries: [],
      stats: {
        available: 0,
        selected: 0,
        droppedOverBudget: 0,
        categories: [],
        tokens: 0,
      },
    };
  }

  const departments = [
    ...new Set(rows.map((row) => row.department).filter(Boolean)),
  ];

  const allowed = new Set(categoriesForDepartments(departments));

  const haystack = rows
    .map((row) => `${row.requirement_text || ''} ${row.section || ''}`)
    .join(' ')
    .toLowerCase();

  const scored = library.map((entry) => {
    const inAllowed = allowed.has(entry.category);
    const isAlways = ALWAYS_CATEGORIES.includes(entry.category);
    const tagHits = countTagHits(entry, haystack);

    // Category relevance dominates; tags refine within it. An entry outside
    // the allowed categories can still be pulled in by a strong tag match,
    // which is what stops the department map from being a hard filter.
    const score =
      (inAllowed ? 3 : 0) + (isAlways ? 2 : 0) + Math.min(tagHits, 3) * 2;

    return { entry, score, tagHits, tokens: estimateEntryTokens(entry) };
  });

  const candidates = scored
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Cheaper entries first at equal relevance, so the budget buys more of
        // them rather than one long one.
        a.tokens - b.tokens ||
        String(a.entry.title).localeCompare(String(b.entry.title))
    );

  const selected = [];

  let tokens = 0;
  let dropped = 0;

  for (const item of candidates) {
    if (selected.length >= maxEntries || tokens + item.tokens > maxTokens) {
      dropped += 1;

      continue;
    }

    selected.push(item.entry);
    tokens += item.tokens;
  }

  // A batch with nothing at all makes the model invent content, which is the
  // one outcome worth spending budget to avoid. Take the single cheapest
  // candidate even if it blows the budget.
  if (selected.length === 0 && candidates.length > 0) {
    const cheapest = [...candidates].sort((a, b) => a.tokens - b.tokens)[0];

    selected.push(cheapest.entry);
    tokens = cheapest.tokens;
    dropped = Math.max(0, dropped - 1);
  }

  return {
    entries: selected,
    stats: {
      available: library.length,
      selected: selected.length,
      droppedOverBudget: dropped,
      categories: [...allowed],
      departments,
      tokens,
      maxTokens,
    },
  };
}

module.exports = {
  selectLibraryForBatch,
  categoriesForDepartments,
  countTagHits,
  estimateEntryTokens,
  DEPARTMENT_CATEGORIES,
  ALWAYS_CATEGORIES,
  DEFAULT_CATEGORIES,
  MAX_LIBRARY_TOKENS,
  MAX_ENTRIES,
};
