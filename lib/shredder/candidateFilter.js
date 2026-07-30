// §4.1 — Candidate filter. Plain code, no AI, no network, no DB.
//
// Its only job is to shrink a full RFP down to the lines plausibly worth
// spending an AI call on. It is deliberately conservative about VOLUME, not
// about recall: a missed line is recoverable (Gate 2 measures that), whereas
// feeding every line of a 60-page RFP to the classifier is not affordable.
//
// Three signals, per the plan:
//   obligation - the line uses binding language (shall / must / ...)
//   structure  - the line is a numbered item, bullet, or table row
//   location   - the line sits under a requirements-bearing section heading
//
// A line is promoted to a candidate when it carries obligation language on
// its own, or when it is structured AND sits in a relevant section. Structure
// alone matches tables of contents and page furniture; location alone matches
// entire chapters. Neither is worth an AI call by itself.

const MIN_CANDIDATE_LENGTH = 25;
const MAX_CANDIDATE_LENGTH = 1200;
const LONG_BLOCK_SPLIT_LENGTH = 400;

/**
 * Binding-obligation wording. Whole-word, case-insensitive.
 *
 * Kept tight on purpose — "should", "may", and "can" are advisory and pull in
 * far more noise than requirement.
 */
const OBLIGATION_PATTERN = new RegExp(
  [
    '\\bshall\\b',
    '\\bmust\\b',
    '\\b(?:is|are|was|were)\\s+required\\s+to\\b',
    '\\b(?:is|are)\\s+required\\b',
    '\\bwill\\s+(?:provide|furnish|supply|deliver|perform|maintain|submit)\\b',
    '\\b(?:is|are)\\s+responsible\\s+for\\b',
    '\\bresponsible\\s+for\\b',
    '\\brequired\\s+to\\s+(?:provide|submit|furnish|perform|maintain)\\b',
  ].join('|'),
  'i'
);

/** Numbered list markers: "1.", "1.2.3", "A.", "iv)", "IV." */
const NUMBERED_PATTERN =
  /^\s*(?:\(?\d+(?:\.\d+)*\)?[.)]|\(?[A-Za-z]\)?[.)]|\(?[IVXLCDM]+\)?[.)])\s+\S/;

/** Bullet glyphs commonly surviving PDF extraction. */
const BULLET_PATTERN = /^\s*(?:[*•▪●◦·–—-])\s+\S/;

/** Dot-leader table-of-contents rows: "Section 4 .......... 12" */
const TOC_PATTERN = /\.{4,}\s*\d+\s*$/;

/** A line that is only page furniture: "Page 4 of 60", bare numbers. */
const PAGE_FURNITURE_PATTERN =
  /^\s*(?:page\s+)?\d+(?:\s+of\s+\d+)?\s*$/i;

/**
 * Section headings whose contents tend to carry requirements.
 *
 * Topic patterns, not exact titles: this RFP says "IV. STATEMENT OF NEEDS"
 * and "XI. PROPOSAL PREPARATION AND SUBMISSION REQUIREMENTS", but other
 * issuers phrase the same sections differently, so each entry matches a
 * concept rather than a literal heading.
 */
const RELEVANT_SECTION_PATTERNS = [
  /\bstatement\s+of\s+(?:needs?|work|objectives?)\b/i,
  /\bscope\s+of\s+(?:work|services?)\b/i,
  /\bspecifications?\b/i,
  /\b(?:technical|functional|system|performance|security)\s+requirements?\b/i,
  /\brequirements?\b/i,
  /\bdeliverables?\b/i,
  /\btasks?\s+and\s+deliverables?\b/i,
  /\bproposal\s+preparation\b/i,
  /\bsubmission\s+(?:requirements?|instructions?)\b/i,
  /\binstructions?\s+to\s+(?:offerors?|bidders?|proposers?|vendors?)\b/i,
  /\b(?:contractor|vendor|offeror|supplier)\s+responsibilities\b/i,
  /\bperformance\s+standards?\b/i,
  /\bqualifications?\b/i,
  /\bevaluation\s+(?:criteria|factors?)\b/i,
  /\bterms?\s+and\s+conditions?\b/i,
  /\bgeneral\s+conditions?\b/i,
  /\bspecial\s+(?:terms?|provisions?)\b/i,
];

/**
 * Detects a section heading.
 *
 * Headings out of PDF text are short, largely uppercase, and often carry a
 * roman/numeric/letter prefix. Requiring shortness plus a high uppercase
 * ratio keeps ordinary sentences from being mistaken for headings.
 *
 * @param {string} line
 * @returns {string|null} The heading text, or null when not a heading.
 */
function detectHeading(line) {
  const trimmed = line.trim();

  if (trimmed.length < 4 || trimmed.length > 90) {
    return null;
  }

  if (TOC_PATTERN.test(trimmed)) {
    return null;
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, '');

  if (letters.length < 3) {
    return null;
  }

  // A real heading contains at least one substantial word. This rejects
  // running page headers built from document identifiers ("RFP # 26-ODU-30-
  // JNH") while keeping every genuine title ("IV. STATEMENT OF NEEDS:").
  if (!/[A-Za-z]{4,}/.test(trimmed)) {
    return null;
  }

  const uppercase = trimmed.replace(/[^A-Z]/g, '').length;
  const uppercaseRatio = uppercase / letters.length;

  // Either shouted (ALL CAPS style) or an explicitly numbered short title.
  const isShouted = uppercaseRatio >= 0.75;

  const isNumberedTitle =
    /^\s*(?:\(?[IVXLCDM]+\)?[.)]|\(?\d+(?:\.\d+)*\)?[.)]|\(?[A-Z]\)?[.)])\s+[A-Z]/.test(
      trimmed
    ) && uppercaseRatio >= 0.5;

  if (!isShouted && !isNumberedTitle) {
    return null;
  }

  // A heading is a label, not a statement.
  if (/[.!?]\s*$/.test(trimmed) && !/[.)]\s*$/.test(trimmed.slice(-2))) {
    return null;
  }

  return trimmed.replace(/\s+/g, ' ');
}

/**
 * Splits a heading that shares its line with the body text beneath it.
 *
 * Terms-and-conditions sections routinely extract as one run-on line:
 * "S. E-VERIFY REQUIREMENT OF ANY CONTRACTOR: Pursuant to Code of Virginia...".
 * Without this the whole line reads as a heading and every following block
 * gets attributed to the wrong section.
 *
 * @param {string} line
 * @returns {{heading: string, rest: string}|null}
 */
function splitInlineHeading(line) {
  const match =
    /^\s*((?:\(?(?:[IVXLCDM]+|[A-Z]{1,2}|\d+(?:\.\d+)*)\)?[.)]\s+)?[A-Z][A-Z0-9 ,&/'()-]{3,70}:)\s*(\S.*)$/.exec(
      line
    );

  if (!match) {
    return null;
  }

  const heading = match[1].trim();
  const rest = match[2].trim();

  if (!/[A-Za-z]{4,}/.test(heading) || rest.length < MIN_CANDIDATE_LENGTH) {
    return null;
  }

  return { heading: heading.replace(/\s+/g, ' '), rest };
}

/**
 * @param {string} heading
 * @returns {boolean} Whether this heading introduces requirement-bearing text.
 */
function isRelevantSection(heading) {
  if (!heading) {
    return false;
  }

  return RELEVANT_SECTION_PATTERNS.some((pattern) => pattern.test(heading));
}

/**
 * Detects table-row-like layout.
 *
 * PDF table rows survive extraction as a single line whose cells are
 * separated by runs of whitespace or pipes. Two or more such gaps is a good
 * proxy for a row; one gap is just a wide sentence break.
 *
 * @param {string} line Raw line, with intra-line spacing preserved.
 * @returns {boolean}
 */
function looksLikeTableRow(line) {
  const pipeCells = (line.match(/\|/g) || []).length;

  if (pipeCells >= 2) {
    return true;
  }

  const gaps = line.match(/\S(?:\s{2,}|\t+)\S/g) || [];

  return gaps.length >= 2 && line.trim().length >= MIN_CANDIDATE_LENGTH;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function hasStructureSignal(line) {
  return (
    NUMBERED_PATTERN.test(line) ||
    BULLET_PATTERN.test(line) ||
    looksLikeTableRow(line)
  );
}

/**
 * @param {string} line
 * @returns {boolean} True for page furniture, TOC rows, and other noise.
 */
function isNoiseLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return true;
  }

  if (PAGE_FURNITURE_PATTERN.test(trimmed)) {
    return true;
  }

  if (TOC_PATTERN.test(trimmed)) {
    return true;
  }

  // Lines with no letters at all (rules, dot runs, stray digits).
  return !/[A-Za-z]/.test(trimmed);
}

/**
 * @param {string} value
 * @returns {string} Whitespace-collapsed text, matching analyze.js's output.
 */
function collapse(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Splits a long block into sentences.
 *
 * @param {string} block
 * @returns {string[]}
 */
function splitSentences(block) {
  return block
    .split(/(?<=[.;:!?])\s+(?=[A-Z(\d])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Flattens pages into a single line stream that remembers its page number.
 *
 * @param {Array<{page: number, text: string}>|string} input
 * @returns {Array<{text: string, page: number|null}>}
 */
function toLines(input) {
  if (typeof input === 'string') {
    return input.split('\n').map((text) => ({ text, page: null }));
  }

  if (!Array.isArray(input)) {
    return [];
  }

  const lines = [];

  for (const entry of input) {
    const page = Number(entry?.page) || null;

    for (const text of String(entry?.text || '').split('\n')) {
      lines.push({ text, page });
    }
  }

  return lines;
}

/**
 * Groups consecutive lines into blocks.
 *
 * A requirement usually wraps across several PDF lines, so evaluating raw
 * lines would shred sentences mid-clause. A block breaks on a blank line, a
 * heading, or the start of a new list item — which is where a new requirement
 * actually begins.
 *
 * @param {Array<{text: string, page: number|null}>} lines
 * @returns {Array<{lines: string[], page: number|null, section: string|null,
 *   startedWithMarker: boolean, hasTableRow: boolean}>}
 */
function buildBlocks(lines) {
  const blocks = [];

  let current = null;
  let currentSection = null;

  const flush = () => {
    if (current && current.lines.length > 0) {
      blocks.push(current);
    }

    current = null;
  };

  for (const entry of lines) {
    const line = { ...entry };

    const heading = detectHeading(line.text);

    if (heading) {
      flush();
      currentSection = heading;
      continue;
    }

    if (isNoiseLine(line.text)) {
      flush();
      continue;
    }

    // "HEADING: body text..." on one line — adopt the heading, then keep
    // processing the body as the first line of the new section.
    const inline = splitInlineHeading(line.text);

    if (inline) {
      flush();
      currentSection = inline.heading;
      line.text = inline.rest;
    }

    const startsItem =
      NUMBERED_PATTERN.test(line.text) || BULLET_PATTERN.test(line.text);

    if (startsItem || !current) {
      flush();

      current = {
        lines: [],
        page: line.page,
        section: currentSection,
        startedWithMarker: startsItem,
        hasTableRow: false,
      };
    }

    current.lines.push(line.text);
    current.hasTableRow = current.hasTableRow || looksLikeTableRow(line.text);

    if (collapse(current.lines.join(' ')).length >= MAX_CANDIDATE_LENGTH) {
      flush();
    }
  }

  flush();

  return blocks;
}

/**
 * Extracts requirement candidates from an RFP.
 *
 * @param {Array<{page: number, text: string}>|string} input
 *   Page-tagged text from lib/shredder/extractPages.js, or a plain string
 *   when page numbers are unavailable (page comes back null).
 * @param {object} [options]
 * @param {number} [options.minLength=25] Shortest text worth keeping.
 * @returns {Array<{text: string, page: number|null, section: string|null,
 *   matchedSignal: string[]}>}
 *   `matchedSignal` lists every signal that fired — 'obligation',
 *   'structure', 'location' — because a candidate commonly matches more than
 *   one and Gate 2 needs to know which.
 *
 * @example
 * const { pages } = await extractPages(buffer);
 * const candidates = findCandidates(pages);
 */
function findCandidates(input, options = {}) {
  const minLength = Number(options.minLength) || MIN_CANDIDATE_LENGTH;

  const blocks = buildBlocks(toLines(input));
  const candidates = [];
  const seen = new Set();

  const push = (text, block, signals) => {
    const collapsed = collapse(text);

    if (collapsed.length < minLength) {
      return;
    }

    const key = collapsed.toLowerCase();

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    candidates.push({
      text:
        collapsed.length > MAX_CANDIDATE_LENGTH
          ? collapsed.slice(0, MAX_CANDIDATE_LENGTH).trim()
          : collapsed,
      page: block.page,
      section: block.section,
      matchedSignal: signals,
    });
  };

  for (const block of blocks) {
    const raw = block.lines.join('\n');
    const collapsed = collapse(raw);

    if (collapsed.length < minLength) {
      continue;
    }

    const hasObligation = OBLIGATION_PATTERN.test(collapsed);

    const hasStructure =
      block.startedWithMarker ||
      block.hasTableRow ||
      block.lines.some((line) => hasStructureSignal(line));

    const inRelevantSection = isRelevantSection(block.section);

    // The promotion rule. Structure or location alone is not enough.
    if (!hasObligation && !(hasStructure && inRelevantSection)) {
      continue;
    }

    const signals = [];

    if (hasObligation) {
      signals.push('obligation');
    }

    if (hasStructure) {
      signals.push('structure');
    }

    if (inRelevantSection) {
      signals.push('location');
    }

    // A long prose block that qualified purely on obligation wording is
    // narrowed to the sentences actually carrying the obligation, so the
    // classifier sees a requirement rather than a page of context.
    if (
      hasObligation &&
      !block.startedWithMarker &&
      collapsed.length > LONG_BLOCK_SPLIT_LENGTH
    ) {
      const sentences = splitSentences(collapsed).filter((sentence) =>
        OBLIGATION_PATTERN.test(sentence)
      );

      if (sentences.length > 0) {
        for (const sentence of sentences) {
          push(sentence, block, signals);
        }

        continue;
      }
    }

    push(collapsed, block, signals);
  }

  return candidates;
}

module.exports = {
  findCandidates,
  detectHeading,
  isRelevantSection,
  looksLikeTableRow,
  hasStructureSignal,
  OBLIGATION_PATTERN,
};
