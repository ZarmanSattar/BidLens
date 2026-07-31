// §6.2 — hard no-bid blockers. Plain code: no AI, no network, no token cost.
//
// A blocker is a fact, not a judgement. Each of the three rules compares a
// number or a name the RFP states against a number or a name the company
// profile states, and fires only when the comparison is unambiguous:
//
//   1. missing required certificate  — the RFP names a certification the
//      profile does not hold (or holds expired),
//   2. insurance above the limit     — a coverage figure exceeds the profile's
//      insurance_limit,
//   3. bonding above capacity        — a bond figure exceeds bonding_capacity.
//
// Every blocker carries the exact REQ number that caused it, because "you
// cannot bid this" is only actionable if you can go read the sentence.
//
// DELIBERATE NON-GOALS
//
// Anything requiring interpretation belongs to §6.3, not here. If a
// requirement says "adequate insurance" with no figure, this module says
// nothing at all rather than guessing — a false blocker is far more expensive
// than a missed one, since it stops a bid outright.
//
// Percentage-stated bonds ("a bond of 100% of contract value") are counted in
// stats.unquantified and produce no blocker: the contract value is not known
// here, so the comparison cannot be made honestly.
//
// OVERLAP WITH §5.2 IS INTENTIONAL. lib/risk/wordingRisk.js also finds
// insurance amounts. It answers a different question — "is this an unusual
// term a human should read?" against a hardcoded placeholder threshold, over
// the whole document. This answers "can this specific company clear the bar?"
// against the real profile, over classified requirement rows, and returns a
// REQ number. Neither module imports the other, on purpose.

/** Certification names worth recognising. A starter set, not exhaustive. */
const CERTIFICATE_CATALOG = [
  {
    id: 'iso_9001',
    label: 'ISO 9001 (quality management)',
    patterns: [/\biso[\s:/-]*9001\b/i],
  },
  {
    id: 'iso_27001',
    label: 'ISO/IEC 27001 (information security)',
    patterns: [/\biso[\s:/-]*(?:iec[\s:/-]*)?27001\b/i],
  },
  {
    id: 'iso_20000',
    label: 'ISO/IEC 20000 (IT service management)',
    patterns: [/\biso[\s:/-]*(?:iec[\s:/-]*)?20000\b/i],
  },
  {
    id: 'soc_2',
    label: 'SOC 2',
    patterns: [/\bsoc[\s-]*2\b/i, /\bsoc[\s-]*ii\b/i],
  },
  {
    id: 'cmmi',
    label: 'CMMI appraisal',
    patterns: [/\bcmmi\b/i, /\bcapability\s+maturity\s+model\b/i],
  },
  {
    id: 'fedramp',
    label: 'FedRAMP authorization',
    patterns: [/\bfed\s?ramp\b/i],
  },
  {
    id: 'pci_dss',
    label: 'PCI DSS',
    patterns: [/\bpci[\s-]*dss\b/i, /\bpayment\s+card\s+industry\s+data\b/i],
  },
  {
    id: 'swam',
    label: 'SWaM (small, women-owned and minority-owned) certification',
    patterns: [
      /\bswam\b/i,
      /\bsmall,?\s+women[\s-]*(?:owned)?,?\s*and\s+minority[\s-]*owned\b/i,
    ],
  },
  {
    id: 'dbe',
    label: 'DBE (disadvantaged business enterprise) certification',
    patterns: [/\bdbe\b/i, /\bdisadvantaged\s+business\s+enterprise\b/i],
  },
  {
    id: 'wbenc',
    label: 'WBENC / women-owned business certification',
    patterns: [/\bwbenc\b/i, /\bwomen[\s-]*owned\s+(?:small\s+)?business\b/i],
  },
  {
    id: 'sba_8a',
    label: 'SBA 8(a) certification',
    patterns: [/\b8\s?\(\s?a\s?\)\b/i],
  },
  {
    id: 'hubzone',
    label: 'HUBZone certification',
    patterns: [/\bhub\s?zone\b/i],
  },
  {
    id: 'sdvosb',
    label: 'SDVOSB / veteran-owned certification',
    patterns: [
      /\bsdvosb\b/i,
      /\bs?dvosb\b/i,
      /\bservice[\s-]*disabled\s+veteran[\s-]*owned\b/i,
    ],
  },
  {
    id: 'vpat',
    label: 'VPAT / Section 508 accessibility conformance report',
    patterns: [/\bvpat\b/i, /\bvoluntary\s+product\s+accessibility\b/i],
  },
];

// A work_requirement is already an obligation on the contractor — the
// classifier established that. This is a second, cheap filter so a sentence
// that merely mentions a certification in passing ("SWaM data is published
// quarterly") does not read as "you must hold SWaM".
const OBLIGATION_WORDING =
  /\b(shall|must|require[sd]?|requirement|certified|certification|accredit\w*|provide|possess|maintain|hold)\b/i;

const INSURANCE_KEYWORDS =
  /\b(insurance|insured|insurer|coverage|liability\s+limits?|umbrella|workers'?\s+comp\w*|general\s+liability|professional\s+liability|errors\s+and\s+omissions|cyber\s+liability|indemnit\w+)\b/i;

const BOND_KEYWORDS =
  /\b(bid\s+bond|performance\s+bond|payment\s+bond|surety\s+bond|surety|bonding\s+capacity|bonded|bonds?)\b/i;

/** Money written with an explicit $ sign, optionally scaled by a suffix. */
const MONEY_PATTERN = /\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?/gi;

/** "100% of the contract value" — real, but not comparable without a value. */
const PERCENT_PATTERN = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\b/i;

/** Below this a "$" figure is almost never a coverage or bond amount. */
const MIN_CREDIBLE_AMOUNT_USD = 1000;

const EVIDENCE_CHARS = 260;

/**
 * Parses a currency amount, honouring a million/billion suffix.
 *
 * Duplicated from lib/risk/wordingRisk.js rather than imported — see the
 * module header. Four lines of arithmetic is a cheaper price than coupling
 * two modules that are meant to answer different questions.
 *
 * @param {string} digits e.g. "5,000,000" or "2.5"
 * @param {string} [unit] e.g. "million"
 * @returns {number|null}
 */
function parseMoney(digits, unit) {
  const base = Number(String(digits || '').replace(/,/g, ''));

  if (!Number.isFinite(base)) {
    return null;
  }

  const suffix = String(unit || '').toLowerCase();

  if (suffix.startsWith('b')) {
    return base * 1e9;
  }

  if (suffix.startsWith('m')) {
    return base * 1e6;
  }

  return base;
}

/**
 * @param {number} value
 * @returns {string} e.g. "$5,000,000"
 */
function formatMoney(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
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
 * Reads a numeric profile field, treating blank/absent as "not stated".
 *
 * Zero is deliberately NOT treated as not-stated: a company that genuinely
 * carries no bonding capacity has 0, and that has to be able to produce
 * blockers.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Normalizes one profile certificate entry.
 *
 * Accepts both a bare string and the `{ name, expires }` object the settings
 * form stores, so hand-seeded data does not need to match the form exactly.
 *
 * @param {unknown} entry
 * @returns {{name: string, expires: string|null}|null}
 */
function toCertificate(entry) {
  if (typeof entry === 'string') {
    return entry.trim() ? { name: entry.trim(), expires: null } : null;
  }

  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const name = String(entry.name || entry.label || '').trim();

  if (!name) {
    return null;
  }

  const expires = entry.expires ? String(entry.expires).trim() : null;

  return { name, expires: expires || null };
}

/**
 * Whether a certificate has an expiry date already in the past.
 *
 * An unparseable or absent date counts as NOT expired. Guessing that a
 * malformed date means "lapsed" would manufacture a no-bid out of a typo.
 *
 * @param {{expires: string|null}} certificate
 * @param {Date} now
 * @returns {boolean}
 */
function isExpired(certificate, now) {
  if (!certificate.expires) {
    return false;
  }

  const when = new Date(certificate.expires);

  return !Number.isNaN(when.getTime()) && when.getTime() < now.getTime();
}

/**
 * Finds which catalog certifications a requirement demands.
 *
 * @param {string} text
 * @returns {Array<{id: string, label: string}>}
 */
function findRequiredCertificates(text) {
  if (!OBLIGATION_WORDING.test(text)) {
    return [];
  }

  return CERTIFICATE_CATALOG.filter((entry) =>
    entry.patterns.some((pattern) => pattern.test(text))
  ).map((entry) => ({ id: entry.id, label: entry.label }));
}

/**
 * Whether the profile holds a given catalog certification.
 *
 * Matching runs the catalog's own patterns over the profile's free-text
 * certificate names, so "ISO 9001:2015" in the profile satisfies an RFP asking
 * for "ISO 9001" without the two strings having to agree.
 *
 * @param {string} certificateId
 * @param {Array<{name: string, expires: string|null}>} held
 * @param {Date} now
 * @returns {{status: 'held'|'expired'|'missing', match: object|null}}
 */
function matchHeldCertificate(certificateId, held, now) {
  const entry = CERTIFICATE_CATALOG.find((item) => item.id === certificateId);

  if (!entry) {
    return { status: 'missing', match: null };
  }

  const matches = held.filter((candidate) =>
    entry.patterns.some((pattern) => pattern.test(candidate.name))
  );

  if (matches.length === 0) {
    return { status: 'missing', match: null };
  }

  const live = matches.find((candidate) => !isExpired(candidate, now));

  return live
    ? { status: 'held', match: live }
    : { status: 'expired', match: matches[0] };
}

/**
 * Largest explicit dollar figure in a piece of text.
 *
 * @param {string} text
 * @returns {{amount: number, raw: string}|null}
 */
function largestAmount(text) {
  MONEY_PATTERN.lastIndex = 0;

  let best = null;
  let match;

  while ((match = MONEY_PATTERN.exec(text)) !== null) {
    const amount = parseMoney(match[1], match[2]);

    if (amount === null || amount < MIN_CREDIBLE_AMOUNT_USD) {
      continue;
    }

    if (!best || amount > best.amount) {
      best = { amount, raw: clip(match[0], 40) };
    }
  }

  return best;
}

/**
 * Builds one blocker record.
 *
 * @param {object} parts
 * @returns {object}
 */
function makeBlocker({
  type,
  requirement,
  title,
  detail,
  required,
  available,
  suffix,
}) {
  return {
    // `suffix` distinguishes several blockers of the same type on the SAME
    // requirement — one sentence can name two certifications, and without it
    // both blockers would share an id and collide as list keys downstream.
    id: [type, requirement.req_number, suffix].filter(Boolean).join(':'),
    type,
    severity: 'blocker',
    // The whole point of the module: the exact REQ number that caused it.
    reqNumber: requirement.req_number,
    requirementId: requirement.id || null,
    page: requirement.page ?? null,
    section: requirement.section || null,
    department: requirement.department || null,
    title,
    detail,
    required,
    available,
    evidence: clip(requirement.requirement_text, EVIDENCE_CHARS),
  };
}

/**
 * §6.2 entry point: checks one RFP's requirements against the company profile.
 *
 * Pure and deterministic — same inputs, same blockers, no I/O of any kind.
 *
 * @param {Array<object>} requirements Rows from public.requirements. Callers
 *   should pass only `role = 'work_requirement'`; this does not filter, so a
 *   caller wanting a different population gets exactly what it asked for.
 * @param {object|null} profile A company_profile row, or null when none exists.
 * @param {object} [options]
 * @param {Date} [options.now] Reference date for certificate expiry, for tests.
 *
 * @returns {{blockers: Array<object>, clear: Array<object>,
 *   blockedReqNumbers: string[], stats: object}}
 *   `clear` is every requirement that produced no blocker — the population
 *   §6.3 judges. `stats.skippedRules` names the rules that could not run
 *   because the profile did not state the figure they compare against.
 *
 * @example
 * const { blockers, clear } = checkBlockers(workRequirements, profile);
 * blockers[0].reqNumber // 'REQ-042'
 */
function checkBlockers(requirements, profile, options = {}) {
  const rows = Array.isArray(requirements) ? requirements : [];
  const now = options.now instanceof Date ? options.now : new Date();

  const insuranceLimit = toNumber(profile?.insurance_limit);
  const bondingCapacity = toNumber(profile?.bonding_capacity);

  const held = (Array.isArray(profile?.certificates) ? profile.certificates : [])
    .map(toCertificate)
    .filter(Boolean);

  // No profile at all is NOT "everything is a blocker" — it is "nothing can be
  // checked". Reporting 84 blockers to someone who simply has not filled the
  // form in yet would be worse than useless.
  const hasProfile = Boolean(profile);

  const skippedRules = [];

  if (!hasProfile) {
    skippedRules.push('certificates', 'insurance', 'bonding');
  } else {
    if (held.length === 0) skippedRules.push('certificates');
    if (insuranceLimit === null) skippedRules.push('insurance');
    if (bondingCapacity === null) skippedRules.push('bonding');
  }

  const blockers = [];
  const blockedReqNumbers = new Set();

  const certificatesRequested = new Map();

  let insuranceMaxRequested = null;
  let bondingMaxRequested = null;
  let unquantified = 0;

  for (const requirement of rows) {
    const text = String(requirement.requirement_text || '');

    if (!text.trim()) {
      continue;
    }

    // ---- rule 1: a certification the RFP names and the profile lacks ----
    for (const required of findRequiredCertificates(text)) {
      certificatesRequested.set(required.id, required.label);

      // With no certificates on file there is nothing to compare against, so
      // the rule is skipped rather than firing on every mention.
      if (held.length === 0) {
        continue;
      }

      const { status, match } = matchHeldCertificate(required.id, held, now);

      if (status === 'held') {
        continue;
      }

      blockers.push(
        makeBlocker({
          type: 'certificate',
          requirement,
          suffix: required.id,
          title: `Required certification not held: ${required.label}`,
          detail:
            status === 'expired'
              ? `The profile lists "${match.name}" but it expired on ${match.expires}.`
              : 'This certification is not on the company profile.',
          required: required.label,
          available:
            status === 'expired'
              ? `${match.name} (expired ${match.expires})`
              : 'not held',
        })
      );

      blockedReqNumbers.add(requirement.req_number);
    }

    // ---- rule 2: coverage above the profile's insurance limit ----
    if (INSURANCE_KEYWORDS.test(text)) {
      const found = largestAmount(text);

      if (found) {
        if (
          insuranceMaxRequested === null ||
          found.amount > insuranceMaxRequested
        ) {
          insuranceMaxRequested = found.amount;
        }

        if (insuranceLimit !== null && found.amount > insuranceLimit) {
          blockers.push(
            makeBlocker({
              type: 'insurance',
              requirement,
              title: `Insurance requirement above the company limit`,
              detail:
                `This requirement calls for ${formatMoney(found.amount)} of ` +
                `coverage; the profile carries ${formatMoney(insuranceLimit)}.`,
              required: formatMoney(found.amount),
              available: formatMoney(insuranceLimit),
            })
          );

          blockedReqNumbers.add(requirement.req_number);
        }
      } else if (PERCENT_PATTERN.test(text)) {
        unquantified += 1;
      }
    }

    // ---- rule 3: a bond above the profile's bonding capacity ----
    if (BOND_KEYWORDS.test(text)) {
      const found = largestAmount(text);

      if (found) {
        if (
          bondingMaxRequested === null ||
          found.amount > bondingMaxRequested
        ) {
          bondingMaxRequested = found.amount;
        }

        if (bondingCapacity !== null && found.amount > bondingCapacity) {
          blockers.push(
            makeBlocker({
              type: 'bonding',
              requirement,
              title: 'Bond requirement above the company bonding capacity',
              detail:
                `This requirement calls for a bond of ${formatMoney(found.amount)}; ` +
                `the profile's capacity is ${formatMoney(bondingCapacity)}.`,
              required: formatMoney(found.amount),
              available: formatMoney(bondingCapacity),
            })
          );

          blockedReqNumbers.add(requirement.req_number);
        }
      } else if (PERCENT_PATTERN.test(text)) {
        // "a performance bond of 100% of the contract value" — a real
        // requirement, but the contract value is not known here.
        unquantified += 1;
      }
    }
  }

  const clear = rows.filter((row) => !blockedReqNumbers.has(row.req_number));

  return {
    blockers,
    clear,
    blockedReqNumbers: [...blockedReqNumbers],
    stats: {
      requirementsChecked: rows.length,
      blocked: blockedReqNumbers.size,
      clear: clear.length,
      byType: {
        certificate: blockers.filter((b) => b.type === 'certificate').length,
        insurance: blockers.filter((b) => b.type === 'insurance').length,
        bonding: blockers.filter((b) => b.type === 'bonding').length,
      },
      hasProfile,
      // Rules that could not run at all, so the caller can say WHY a clean
      // result is clean. "No blockers" from an empty profile means nothing.
      skippedRules,
      certificatesRequested: [...certificatesRequested.values()],
      certificatesHeld: held.length,
      insuranceLimit,
      bondingCapacity,
      insuranceMaxRequested,
      bondingMaxRequested,
      // Requirements stating a bond or coverage as a percentage, which cannot
      // be compared without a contract value.
      unquantified,
      aiUsed: false,
    },
  };
}

module.exports = {
  checkBlockers,
  CERTIFICATE_CATALOG,
  findRequiredCertificates,
  matchHeldCertificate,
  largestAmount,
  parseMoney,
  formatMoney,
};
