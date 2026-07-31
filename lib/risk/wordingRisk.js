const { toSegments, tidy } = require('./clauseRisk');
const { SEVERITY } = require('./farClauses');

// §5.2 — risky-wording detection. Plain code: no AI, no network, no DB.
//
// Two kinds of detector, because two kinds of risk read differently:
//
//   PRESENCE detectors fire on wording alone. "Unlimited liability" is a
//   problem the moment it appears; there is no threshold to clear.
//
//   THRESHOLD detectors capture a number and fire only when it crosses a
//   limit. NET 30 is ordinary and NET 90 is a cash-flow problem, so the
//   pattern alone cannot decide — `qualify` reads the captured value and
//   either rejects the hit or explains why it was kept.
//
// Everything is regex over the extracted text, so both false positives and
// misses are expected. A finding here means "a human should look at this
// sentence", never "this contract is bad".

// ---------------------------------------------------------------------------
// Thresholds
//
// TODO(Phase 3): these are HARDCODED PLACEHOLDERS. §6.1's company_profile
// table (insurance_limit, bonding_capacity, ...) does not exist yet, so there
// is nothing to compare against and no way to know what this company can
// actually carry. Once that table lands, these should be read from it per
// request and passed in as options rather than baked in here — a $5M limit is
// unremarkable for one bidder and disqualifying for another.
// ---------------------------------------------------------------------------

/** Federal Prompt Payment is 30 days; anything longer is worth flagging. */
const PAYMENT_TERMS_MAX_DAYS = 30;

/** Beyond two years a warranty starts carrying real reserve cost. */
const WARRANTY_MAX_MONTHS = 24;

/** PLACEHOLDER — see the TODO above. Not this company's real capacity. */
const INSURANCE_ALERT_THRESHOLD_USD = 5000000;

const SNIPPET_RADIUS = 130;
const MAX_MATCHES_PER_FINDING = 5;

/**
 * Parses a currency amount, honouring a "million"/"billion" suffix.
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

// Each detector: patterns fire, then `qualify` (optional) inspects the regex
// captures and returns a short detail string to keep the hit, or null to
// discard it.
const DETECTORS = [
  {
    id: 'unlimited_liability',
    severity: SEVERITY.HIGH,
    label: 'Unlimited liability',
    title: 'Liability is stated without a cap',
    description:
      'The contract appears to place liability on the contractor without an upper limit, or to explicitly disclaim any cap. Uncapped liability can exceed the entire contract value and is usually the single most negotiable — and most important — term to fix before signing.',
    patterns: [
      /\bunlimited\s+liabilit(?:y|ies)\b/gi,
      /\bliabilit(?:y|ies)\b[^.]{0,80}?\bshall\s+not\s+be\s+limited\b/gi,
      /\bwithout\s+limitation\b[^.]{0,60}?\bliabilit(?:y|ies)\b/gi,
      /\bno\s+limitation\s+of\s+liabilit(?:y|ies)\b/gi,
      /\bliabilit(?:y|ies)\b[^.]{0,60}?\bunlimited\b/gi,
    ],
  },
  {
    id: 'ip_transfer',
    severity: SEVERITY.HIGH,
    label: 'IP / ownership transfer',
    title: 'Intellectual property or ownership transfers to the buyer',
    description:
      'Language assigning ownership, title, or work-made-for-hire status to the issuing agency. Check carefully whether it reaches your pre-existing/background IP and reusable tooling, not just the deliverables built under this contract.',
    patterns: [
      /\bworks?\s+made\s+for\s+hire\b/gi,
      /\ball\s+right,?\s*title,?\s*and\s+interest\b/gi,
      /\bshall\s+(?:become|be)\s+the\s+(?:sole\s+and\s+)?(?:exclusive\s+)?property\s+of\b/gi,
      /\b(?:assigns?|assignment\s+of)\b[^.]{0,80}?\bintellectual\s+property\b/gi,
      /\bintellectual\s+property\b[^.]{0,80}?\bvest(?:s|ed)?\s+in\b/gi,
    ],
  },
  {
    id: 'termination_convenience',
    severity: SEVERITY.HIGH,
    label: 'Termination for convenience',
    title: 'The buyer may terminate without cause',
    description:
      'The issuer can end the contract at its own discretion, without any failure on your part. Recovery is normally limited to costs incurred plus profit on completed work — anticipated profit on the remaining term is lost. Do not commit hiring or capacity against the full contract value.',
    patterns: [
      /\btermination\s+for\s+(?:the\s+)?convenience\b/gi,
      /\bterminate[sd]?\b[^.]{0,60}?\bfor\s+(?:its|the\s+\w+'?s?)?\s*convenience\b/gi,
      /\bterminat(?:e|ion)\b[^.]{0,60}?\bwithout\s+cause\b/gi,
      /\bterminate[sd]?\b[^.]{0,50}?\bat\s+any\s+time\b[^.]{0,50}?\bwithout\s+(?:cause|penalty)\b/gi,
    ],
  },
  {
    id: 'liquidated_damages',
    severity: SEVERITY.HIGH,
    label: 'Penalty / liquidated damages',
    title: 'Pre-agreed damages apply to delay or non-performance',
    description:
      'A fixed sum becomes payable on delay or failure to perform, without the issuer having to prove actual loss. Model the per-day exposure against a realistic worst-case schedule before pricing, and check whether it is capped.',
    patterns: [
      /\bliquidated\s+damages\b/gi,
      /\bpenalt(?:y|ies)\b[^.]{0,60}?\bper\s+(?:calendar\s+|business\s+|working\s+)?day\b/gi,
      /\$\s?[\d,]+(?:\.\d{2})?\s*(?:per|\/)\s*(?:calendar\s+|business\s+|working\s+)?day\b/gi,
      /\bassess(?:ed|ment\s+of)?\b[^.]{0,50}?\bdamages\b[^.]{0,50}?\bdelay\b/gi,
    ],
  },
  {
    id: 'payment_terms',
    severity: SEVERITY.MEDIUM,
    label: 'Payment terms',
    title: `Payment terms slower than NET ${PAYMENT_TERMS_MAX_DAYS}`,
    description: `Payment appears to be due more than ${PAYMENT_TERMS_MAX_DAYS} days after invoice. Every extra day is working capital you finance. Confirm the clock starts on invoice receipt rather than on acceptance, which can add weeks more.`,
    patterns: [
      /\bnet\s*(\d{1,3})\b/gi,
      /\bwithin\s+(\d{1,3})\s+(?:calendar\s+|business\s+)?days?\b[^.]{0,70}?\b(?:invoice|receipt\s+of\s+invoice|proper\s+invoice)\b/gi,
      /\bpayment\s+terms?\b[^.]{0,60}?(\d{1,3})\s*days?\b/gi,
      /\b(?:invoice|invoices)\b[^.]{0,70}?\bpaid\s+within\s+(\d{1,3})\s*days?\b/gi,
    ],
    // The pattern matches any NET number; only a slow one is a finding.
    qualify: (match) => {
      const days = Number(match[1]);

      if (!Number.isFinite(days) || days <= PAYMENT_TERMS_MAX_DAYS) {
        return null;
      }

      // Three-digit day counts are nearly always a misparse (a dollar figure,
      // a section number) rather than a real payment term.
      if (days > 365) {
        return null;
      }

      return `${days} days (slower than NET ${PAYMENT_TERMS_MAX_DAYS})`;
    },
  },
  {
    id: 'warranty_length',
    severity: SEVERITY.MEDIUM,
    label: 'Warranty length',
    title: `Warranty period longer than ${WARRANTY_MAX_MONTHS} months`,
    description: `A warranty obligation appears to run beyond ${WARRANTY_MAX_MONTHS} months. Long tails mean carrying support cost and reserve well past revenue recognition — price the tail, and check whether it renews on repaired or replaced items.`,
    // The suffix group is optional because the bare verb is the commonest
    // form in practice — "the Contractor shall warrant all work for 5 years"
    // never says "warranty". Requiring a suffix silently missed those.
    patterns: [
      /\bwarrant(?:y|ies|ed|s|ing)?\b[^.]{0,120}?\b(\d{1,3})\s*(year|month)s?\b/gi,
      /\b(\d{1,3})\s*(year|month)s?\b[^.]{0,90}?\bwarrant(?:y|ies|ed|s|ing)?\b/gi,
    ],
    qualify: (match) => {
      const amount = Number(match[1]);
      const unit = String(match[2] || '').toLowerCase();

      if (!Number.isFinite(amount) || amount <= 0) {
        return null;
      }

      const months = unit.startsWith('year') ? amount * 12 : amount;

      // A "60 month" warranty is plausible; a "2000 year" one is a misparse.
      if (months <= WARRANTY_MAX_MONTHS || months > 600) {
        return null;
      }

      return `${amount} ${unit}${amount === 1 ? '' : 's'} (${months} months)`;
    },
  },
  {
    id: 'insurance_limits',
    severity: SEVERITY.MEDIUM,
    label: 'Insurance limits',
    title: `Required insurance above ${formatMoney(INSURANCE_ALERT_THRESHOLD_USD)}`,
    description: `A coverage requirement appears to exceed ${formatMoney(INSURANCE_ALERT_THRESHOLD_USD)}. Confirm your carrier will write it, and get the premium quoted before pricing the bid — high limits and unusual endorsements are a common late-stage surprise. NOTE: this threshold is a placeholder, not your company's real capacity (see the Phase 3 TODO in wordingRisk.js).`,
    patterns: [
      // Amount stated after the coverage keyword ...
      /\b(?:insurance|coverage|liability\s+limits?|policy|indemnit\w+)\b[^.]{0,160}?\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?/gi,
      // ... and before it.
      /\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion|m\b|b\b)?[^.]{0,110}?\b(?:insurance|coverage|liability\s+limits?|policy)\b/gi,
    ],
    qualify: (match) => {
      const amount = parseMoney(match[1], match[2]);

      if (amount === null || amount < INSURANCE_ALERT_THRESHOLD_USD) {
        return null;
      }

      return formatMoney(amount);
    },
  },
];

/**
 * §5.2 entry point: scans document text for risky wording.
 *
 * @param {string|Array} input Document text, flat or one string per page.
 * @param {object} [options]
 * @param {string[]} [options.only] Detector ids to run, for testing.
 * @returns {{findings: Array<object>, stats: object}}
 *   One finding per detector that fired, each carrying up to
 *   MAX_MATCHES_PER_FINDING evidence snippets with page numbers.
 *
 * @example
 * const { findings } = scanWordingRisk(rfp.pages);
 */
function scanWordingRisk(input, options = {}) {
  const segments = toSegments(input);

  const only = Array.isArray(options.only) ? new Set(options.only) : null;
  const active = only
    ? DETECTORS.filter((detector) => only.has(detector.id))
    : DETECTORS;

  const findings = [];

  for (const detector of active) {
    const matches = [];
    const seen = new Set();

    let occurrences = 0;

    for (const segment of segments) {
      const text = segment.text;

      for (const pattern of detector.patterns) {
        // Module-scope /g regexes carry lastIndex between uses; reset per
        // segment or later pages resume from a stale offset.
        pattern.lastIndex = 0;

        let match;

        while ((match = pattern.exec(text)) !== null) {
          // A zero-length match would spin forever.
          if (match[0].length === 0) {
            pattern.lastIndex += 1;

            continue;
          }

          const detail = detector.qualify ? detector.qualify(match) : '';

          if (detail === null) {
            continue;
          }

          occurrences += 1;

          const start = Math.max(0, match.index - SNIPPET_RADIUS);
          const end = Math.min(
            text.length,
            match.index + match[0].length + SNIPPET_RADIUS
          );

          const snippet = `…${tidy(text.slice(start, end))}…`;

          // The detectors overlap on purpose (several patterns per risk), so
          // the same sentence can match more than once. Deduplicate on the
          // snippet so the evidence list reads as distinct places in the
          // document rather than the same one repeated.
          if (seen.has(snippet) || matches.length >= MAX_MATCHES_PER_FINDING) {
            continue;
          }

          seen.add(snippet);

          matches.push({
            page: segment.page,
            raw: tidy(match[0]).slice(0, 120),
            detail: detail || null,
            snippet,
          });
        }
      }
    }

    if (matches.length === 0) {
      continue;
    }

    findings.push({
      id: `wording:${detector.id}`,
      category: 'wording',
      severity: detector.severity,
      label: detector.label,
      title: detector.title,
      description: detector.description,
      occurrences,
      matches,
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 };

  findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.label.localeCompare(b.label)
  );

  return {
    findings,
    stats: {
      detectorsRun: active.length,
      detectorsFired: findings.length,
      thresholds: {
        paymentTermsMaxDays: PAYMENT_TERMS_MAX_DAYS,
        warrantyMaxMonths: WARRANTY_MAX_MONTHS,
        insuranceAlertUsd: INSURANCE_ALERT_THRESHOLD_USD,
        // Surfaced so the UI can say plainly that these are not the
        // company's real figures yet.
        source: 'hardcoded-placeholder',
      },
    },
  };
}

module.exports = {
  scanWordingRisk,
  DETECTORS,
  parseMoney,
  formatMoney,
  PAYMENT_TERMS_MAX_DAYS,
  WARRANTY_MAX_MONTHS,
  INSURANCE_ALERT_THRESHOLD_USD,
};
