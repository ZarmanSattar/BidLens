const { parseMoney, formatMoney } = require('../fit/blockerCheck');

// §7.2 — contradictions BETWEEN the files of one RFP package.
//
// CODE-ONLY, ZERO TOKENS. Regex extraction and value comparison, nothing else.
//
// This asks a question none of the existing scanners ask. lib/risk/wordingRisk
// finds terms that are risky in isolation; lib/fit/blockerCheck compares terms
// against the company profile. Neither can see that the base solicitation says
// NET 30 and Exhibit C says NET 45 — because both read the package as ONE
// concatenated document, where the two figures simply coexist.
//
// A contradiction is worth flagging precisely because it is not resolvable by
// reading harder: whichever value the bidder prices against, the other one is
// in the contract too. It is a question for the issuer, and the deadline for
// asking questions usually closes well before the bid does.
//
// parseMoney/formatMoney are IMPORTED from lib/fit/blockerCheck rather than
// duplicated a third time. Nothing in lib/fit or lib/risk is modified.

/** Radius of context kept around a matched value, for evidence. */
const SNIPPET_RADIUS = 110;

/** Below this a "$" figure is almost never a coverage or bond amount. */
const MIN_CREDIBLE_AMOUNT_USD = 1000;

const MONTHS =
  '(january|february|march|april|may|june|july|august|september|october|november|december)';

/**
 * @param {string} value
 * @returns {string}
 */
function tidy(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @returns {string}
 */
function snippet(text, index, length) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);

  return `…${tidy(text.slice(start, end))}…`;
}

/**
 * Runs a global regex over one file's pages, yielding matches with page numbers.
 *
 * @param {Array<string>} pages
 * @param {RegExp} pattern
 * @param {(match: RegExpExecArray, page: number, text: string) => object|null} build
 * @returns {Array<object>}
 */
function scanPages(pages, pattern, build) {
  const found = [];

  pages.forEach((text, pageIndex) => {
    const body = String(text || '');

    pattern.lastIndex = 0;

    let match;

    while ((match = pattern.exec(body)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;

        continue;
      }

      const built = build(match, pageIndex + 1, body);

      if (built) {
        found.push(built);
      }
    }
  });

  return found;
}

// Each extractor pulls ONE comparable fact out of a file. `value` is what gets
// compared across files and must be a primitive; `display` is what a human
// reads.
const EXTRACTORS = [
  {
    key: 'payment_terms',
    label: 'Payment terms',
    unit: 'days',
    describe: (value) => `NET ${value}`,
    extract: (pages) =>
      scanPages(pages, /\bnet\s*(\d{1,3})\b/gi, (match, page, body) => {
        const days = Number(match[1]);

        // Three-digit day counts are nearly always a misparse.
        if (!Number.isFinite(days) || days <= 0 || days > 180) {
          return null;
        }

        return {
          value: days,
          display: `NET ${days}`,
          page,
          snippet: snippet(body, match.index, match[0].length),
        };
      }),
  },
  {
    key: 'insurance_minimum',
    label: 'Required insurance',
    unit: 'USD',
    describe: (value) => formatMoney(value),
    extract: (pages) =>
      scanPages(
        pages,
        /\b(?:insurance|coverage|liability\s+limits?|general\s+liability|professional\s+liability)\b[^.]{0,160}?\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?/gi,
        (match, page, body) => {
          const amount = parseMoney(match[1], match[2]);

          if (amount === null || amount < MIN_CREDIBLE_AMOUNT_USD) {
            return null;
          }

          return {
            value: amount,
            display: formatMoney(amount),
            page,
            snippet: snippet(body, match.index, match[0].length),
          };
        }
      ),
  },
  {
    key: 'bond_amount',
    label: 'Bond requirement',
    unit: 'USD',
    describe: (value) => formatMoney(value),
    extract: (pages) =>
      scanPages(
        pages,
        /\b(?:bid\s+bond|performance\s+bond|payment\s+bond|surety)\b[^.]{0,140}?\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?/gi,
        (match, page, body) => {
          const amount = parseMoney(match[1], match[2]);

          if (amount === null || amount < MIN_CREDIBLE_AMOUNT_USD) {
            return null;
          }

          return {
            value: amount,
            display: formatMoney(amount),
            page,
            snippet: snippet(body, match.index, match[0].length),
          };
        }
      ),
  },
  {
    key: 'submission_deadline',
    label: 'Submission deadline',
    unit: 'date',
    describe: (value) => value,
    extract: (pages) =>
      scanPages(
        pages,
        new RegExp(
          `\\b(?:due|deadline|closing|close|submit(?:ted|ssion)?|received)\\b[^.]{0,90}?\\b${MONTHS}\\s+(\\d{1,2}),?\\s+(\\d{4})`,
          'gi'
        ),
        (match, page, body) => {
          const month = String(match[1] || '').toLowerCase();
          const day = Number(match[2]);
          const year = Number(match[3]);

          if (!Number.isFinite(day) || !Number.isFinite(year)) {
            return null;
          }

          const monthIndex = [
            'january', 'february', 'march', 'april', 'may', 'june',
            'july', 'august', 'september', 'october', 'november', 'december',
          ].indexOf(month);

          if (monthIndex === -1) {
            return null;
          }

          // ISO, so string comparison across files is date comparison.
          const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

          return {
            value: iso,
            display: iso,
            page,
            snippet: snippet(body, match.index, match[0].length),
          };
        }
      ),
  },
];

/**
 * Normalizes one file into `{ filename, pages }`.
 *
 * Accepts the rfp_files row shape, falling back to splitting raw_text when a
 * file was stored without page tracking.
 *
 * @param {object} file
 * @returns {{filename: string, pages: string[], role: string}}
 */
function toFile(file) {
  const pages = Array.isArray(file?.pages) && file.pages.length > 0
    ? file.pages
    : typeof file?.raw_text === 'string' && file.raw_text.trim()
      ? [file.raw_text]
      : [];

  return {
    filename: file?.filename || 'Untitled file',
    role: file?.role || 'attachment',
    pages,
  };
}

/**
 * §7.2 entry point: finds values that two files of one package disagree on.
 *
 * Pure and deterministic — no I/O, no AI, no token cost.
 *
 * @param {Array<object>} files rfp_files rows (or `{filename, pages, role}`).
 * @param {object} [options]
 * @param {string[]} [options.only] Extractor keys to run, for testing.
 *
 * @returns {{conflicts: Array<object>, values: Array<object>, stats: object}}
 *   `conflicts` is one entry per fact the files disagree on, each listing
 *   every distinct value with the file, page and quote behind it.
 *
 * @example
 * const { conflicts } = checkCrossFile(files);
 * conflicts[0].label   // 'Payment terms'
 * conflicts[0].values  // [{display:'NET 30', filename:'base.pdf'}, ...]
 */
function checkCrossFile(files, options = {}) {
  const list = (Array.isArray(files) ? files : []).map(toFile).filter(
    (file) => file.pages.length > 0
  );

  const only = Array.isArray(options.only) ? new Set(options.only) : null;
  const active = only
    ? EXTRACTORS.filter((extractor) => only.has(extractor.key))
    : EXTRACTORS;

  const conflicts = [];
  const values = [];

  // A single file cannot contradict another file. Saying so explicitly beats
  // returning an empty list that reads like "checked, all clear".
  if (list.length < 2) {
    return {
      conflicts: [],
      values: [],
      stats: {
        files: list.length,
        comparable: false,
        reason:
          list.length === 0
            ? 'No per-file text is stored for this RFP, so its files cannot be compared.'
            : 'This RFP is a single file, so there is nothing to compare it against.',
        extractorsRun: 0,
        aiUsed: false,
      },
    };
  }

  for (const extractor of active) {
    // filename -> the distinct values that file states for this fact.
    const perFile = new Map();

    for (const file of list) {
      const hits = extractor.extract(file.pages);

      if (hits.length === 0) {
        continue;
      }

      const distinct = new Map();

      for (const hit of hits) {
        if (!distinct.has(hit.value)) {
          distinct.set(hit.value, { ...hit, occurrences: 1 });
        } else {
          distinct.get(hit.value).occurrences += 1;
        }
      }

      perFile.set(file.filename, [...distinct.values()]);

      for (const entry of distinct.values()) {
        values.push({
          key: extractor.key,
          label: extractor.label,
          filename: file.filename,
          role: file.role,
          value: entry.value,
          display: entry.display,
          page: entry.page,
          occurrences: entry.occurrences,
        });
      }
    }

    if (perFile.size < 2) {
      // Only one file mentions this fact — nothing to disagree with.
      continue;
    }

    // A file stating several values for the same fact (a table of coverage
    // types, say) is normal. A conflict is when the SETS across files do not
    // overlap at all — no single value both files could be referring to.
    const sets = [...perFile.entries()].map(([filename, entries]) => ({
      filename,
      entries,
      valueSet: new Set(entries.map((entry) => entry.value)),
    }));

    for (let a = 0; a < sets.length; a += 1) {
      for (let b = a + 1; b < sets.length; b += 1) {
        const left = sets[a];
        const right = sets[b];

        const overlaps = [...left.valueSet].some((value) =>
          right.valueSet.has(value)
        );

        if (overlaps) {
          continue;
        }

        conflicts.push({
          id: `${extractor.key}:${left.filename}:${right.filename}`,
          key: extractor.key,
          label: extractor.label,
          unit: extractor.unit,
          severity: 'high',
          title: `${extractor.label} differ between files`,
          description:
            `${left.filename} and ${right.filename} state different ` +
            `${extractor.label.toLowerCase()}, and both are part of the same ` +
            'solicitation. Whichever one is priced against, the other is still ' +
            'in the package — raise it as a written question before the ' +
            'question deadline rather than choosing one.',
          values: [
            ...left.entries.map((entry) => ({
              filename: left.filename,
              display: entry.display,
              value: entry.value,
              page: entry.page,
              snippet: entry.snippet,
            })),
            ...right.entries.map((entry) => ({
              filename: right.filename,
              display: entry.display,
              value: entry.value,
              page: entry.page,
              snippet: entry.snippet,
            })),
          ],
        });
      }
    }
  }

  return {
    conflicts,
    values,
    stats: {
      files: list.length,
      comparable: true,
      extractorsRun: active.length,
      conflictsFound: conflicts.length,
      factsExtracted: values.length,
      aiUsed: false,
    },
  };
}

module.exports = {
  checkCrossFile,
  EXTRACTORS,
  toFile,
};
