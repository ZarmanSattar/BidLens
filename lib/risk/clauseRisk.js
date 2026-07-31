const { CLAUSE_LIBRARY, SEVERITY } = require('./farClauses');

// §5.1 — clause-number risk lookup. Plain code: no AI, no network, no DB.
//
// Finds federal clause references in the document text and looks each one up
// in the starter library. Two kinds of finding come out:
//
//   1. one per RECOGNIZED clause, carrying the library's plain-language
//      description, and
//   2. a single grouped finding listing every clause referenced that the
//      library does not cover.
//
// (2) exists because the library is a starting set. Silently dropping the
// clauses it does not know would turn "we have not reviewed this" into
// "there is nothing here", which is the more dangerous of the two messages.

// FAR clauses are 52.<3 digits>-<1-2 digits>; DFARS and the other supplements
// are 2xx.<3 digits>-<4 digits>. Both may carry an alternate suffix, which is
// captured separately so "52.212-4 Alt I" still resolves to 52.212-4.
//
// The trailing (?!\d) stops a clause number from matching the leading part of
// a longer number, and the leading (?<![\d.]) stops it from matching the tail
// of one.
const CLAUSE_PATTERN =
  /(?<![\d.])(52\.\d{3}-\d{1,2}|2\d{2}\.\d{3}-\d{4})(?!\d)(\s*(?:Alt|Alternate)\s*[IVX]+)?/gi;

// Characters of surrounding document text kept with each hit, so a reviewer
// can see the reference in context without opening the PDF.
const SNIPPET_RADIUS = 110;

// More than this many quotations of the same clause adds noise, not evidence.
const MAX_MATCHES_PER_FINDING = 4;

/**
 * Normalizes text for snippet display: collapses the whitespace runs that PDF
 * extraction leaves behind, without touching the content.
 *
 * @param {string} value
 * @returns {string}
 */
function tidy(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Turns the caller's input into a uniform list of {page, text} segments.
 *
 * Accepts a flat string (page numbers unavailable, page stays null) or the
 * one-string-per-page array that rfps.pages stores, where the page number IS
 * the 1-based index — the same convention the shredder relies on.
 *
 * @param {string|Array<string|{page: number, text: string}>} input
 * @returns {Array<{page: number|null, text: string}>}
 */
function toSegments(input) {
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      if (entry && typeof entry === 'object') {
        return {
          page: Number.isFinite(Number(entry.page)) ? Number(entry.page) : index + 1,
          text: String(entry.text || ''),
        };
      }

      return { page: index + 1, text: String(entry || '') };
    });
  }

  return [{ page: null, text: String(input || '') }];
}

/**
 * Extracts every federal clause reference in the document.
 *
 * Deduplicated by clause number: a clause cited twelve times is one reference
 * with twelve occurrences, not twelve references.
 *
 * @param {string|Array} input Document text, flat or per page.
 * @returns {Array<{clause: string, occurrences: number,
 *   matches: Array<{page: number|null, snippet: string, raw: string}>}>}
 *   Ordered by first appearance in the document.
 *
 * @example
 * extractClauseReferences('... FAR 52.249-2 Termination ...')
 * // -> [{ clause: '52.249-2', occurrences: 1, matches: [...] }]
 */
function extractClauseReferences(input) {
  const segments = toSegments(input);
  const found = new Map();

  for (const segment of segments) {
    const text = segment.text;

    // The regex is module-scope and /g, so its lastIndex has to be reset for
    // each segment or the second page would resume mid-string.
    CLAUSE_PATTERN.lastIndex = 0;

    let match;

    while ((match = CLAUSE_PATTERN.exec(text)) !== null) {
      const clause = match[1];

      if (!found.has(clause)) {
        found.set(clause, { clause, occurrences: 0, matches: [] });
      }

      const entry = found.get(clause);

      entry.occurrences += 1;

      if (entry.matches.length < MAX_MATCHES_PER_FINDING) {
        const start = Math.max(0, match.index - SNIPPET_RADIUS);
        const end = Math.min(text.length, match.index + match[0].length + SNIPPET_RADIUS);

        entry.matches.push({
          page: segment.page,
          raw: tidy(match[0]),
          snippet: `…${tidy(text.slice(start, end))}…`,
        });
      }
    }
  }

  return [...found.values()];
}

/**
 * §5.1 entry point: clause references, resolved against the starter library.
 *
 * @param {string|Array} input Document text, flat or one string per page.
 * @returns {{findings: Array<object>, stats: object}}
 *   `findings` carries one entry per recognized clause plus, when applicable,
 *   one grouped entry for unrecognized references. `stats` reports the split
 *   so the UI can be honest about coverage.
 *
 * @example
 * const { findings, stats } = scanClauseRisk(rfp.pages);
 */
function scanClauseRisk(input) {
  const references = extractClauseReferences(input);

  const recognized = [];
  const unrecognized = [];

  for (const reference of references) {
    if (CLAUSE_LIBRARY[reference.clause]) {
      recognized.push(reference);
    } else {
      unrecognized.push(reference);
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 };

  const findings = recognized
    .map((reference) => {
      const entry = CLAUSE_LIBRARY[reference.clause];

      return {
        id: `clause:${reference.clause}`,
        category: 'clause',
        severity: entry.severity,
        clause: reference.clause,
        system: entry.system,
        label: `${entry.system} ${reference.clause}`,
        title: entry.title,
        description: entry.description,
        occurrences: reference.occurrences,
        matches: reference.matches,
      };
    })
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        a.clause.localeCompare(b.clause)
    );

  if (unrecognized.length > 0) {
    findings.push({
      id: 'clause:unrecognized',
      category: 'clause',
      severity: SEVERITY.LOW,
      label: 'Unreviewed clauses',
      title: `${unrecognized.length} clause reference(s) not in the starter library`,
      description:
        'These clause numbers appear in the document but are not covered by ' +
        'the built-in starter list, which is deliberately small. They have ' +
        'NOT been assessed — treat this as "not yet reviewed" rather than ' +
        '"no risk", and read them directly.',
      occurrences: unrecognized.reduce((sum, item) => sum + item.occurrences, 0),
      clauses: unrecognized.map((item) => item.clause).sort(),
      matches: unrecognized.slice(0, MAX_MATCHES_PER_FINDING).flatMap((item) =>
        item.matches.slice(0, 1)
      ),
    });
  }

  return {
    findings,
    stats: {
      referencesFound: references.length,
      recognized: recognized.length,
      unrecognized: unrecognized.length,
      librarySize: Object.keys(CLAUSE_LIBRARY).length,
    },
  };
}

module.exports = {
  scanClauseRisk,
  extractClauseReferences,
  toSegments,
  tidy,
  CLAUSE_PATTERN,
};
