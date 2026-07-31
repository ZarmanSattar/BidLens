// §6.4 — one fit score, a factor-by-factor breakdown, and a ranked gap list
// with a recommended action per gap.
//
// Pure and dependency-free: it combines §6.2's blockers (always present, zero
// token cost) with §6.3's judgments (opt-in, may be absent) and derives
// everything else arithmetically. No AI is involved in the score OR in the
// recommended actions — those come from the rule table below, so the same
// inputs always produce the same advice and it can be argued with.
//
// The score is deliberately NOT a probability of winning. It answers a
// narrower question: how much of what this solicitation asks for can this
// company, as described by its profile, actually supply today.

/** Contribution to the capability score, per §6.3 verdict. */
const VERDICT_WEIGHT = {
  can_do: 1,
  partial: 0.5,
  gap: 0,
};

/** Points removed per blocker. */
const BLOCKER_PENALTY = 20;

/** Most a blocker pile can remove, so the capability signal stays readable. */
const MAX_BLOCKER_PENALTY = 60;

const VERDICT_LABEL = {
  can_do: 'Can do',
  partial: 'Partial',
  gap: 'Gap',
};

const ACTION_LABEL = {
  build: 'Build in-house',
  subcontract: 'Subcontract',
  partner: 'Partner / team',
  do_not_bid: 'Do not bid',
};

// Requirements whose gap is a CREDENTIAL rather than a capability. You cannot
// subcontract a certification the prime is required to hold, so these route to
// partnering (or teaming with a prime who has it) instead.
const CREDENTIAL_WORDING =
  /\b(certif\w*|accredit\w*|licens\w*|registrat\w*|bond\w*|insur\w*|clearance|authoriz\w*)\b/i;

/** Factor key -> the blocker `type` string §6.2 actually emits. */
const FACTOR_BLOCKER_TYPE = {
  certificates: 'certificate',
  insurance: 'insurance',
  bonding: 'bonding',
};

/**
 * Verdict for the whole opportunity.
 *
 * The two "not really an answer" states come first and are named as such.
 * A card that shows 100 / Strong fit because nothing could be checked is
 * worse than one that shows nothing — it is confidently wrong, and the
 * reader has no way to tell it apart from a real pass.
 *
 * @param {number|null} score
 * @param {number} blockerCount
 * @param {boolean} provisional True when the capability half is missing.
 * @returns {{key: string, label: string, tone: string}}
 */
function toVerdict(score, blockerCount, provisional) {
  // A single blocker is a hard stop by definition — §6.2 only fires when a
  // stated requirement exceeds a stated company figure. It must not be
  // averaged away by a long tail of easy requirements.
  if (blockerCount > 0) {
    return {
      key: 'no_bid',
      label: 'Do not bid as prime',
      tone: 'danger',
    };
  }

  if (score === null) {
    return { key: 'not_assessed', label: 'Not assessed', tone: 'secondary' };
  }

  // Blocker rules ran and found nothing, but nothing has judged whether the
  // company can actually do the work. That is "no hard stop", not "good fit".
  if (provisional) {
    return {
      key: 'checks_clear',
      label: 'No blockers — fit not yet judged',
      tone: 'secondary',
    };
  }

  if (score >= 75) {
    return { key: 'strong_fit', label: 'Strong fit', tone: 'success' };
  }

  if (score >= 50) {
    return { key: 'fit_with_gaps', label: 'Fit with gaps', tone: 'warning' };
  }

  return { key: 'weak_fit', label: 'Weak fit', tone: 'danger' };
}

/**
 * The recommended action for one gap.
 *
 * A fixed rule table, stated here so it can be disagreed with:
 *
 *   - insurance / bonding blocker -> do not bid. Financial capacity cannot be
 *     borrowed for a contract you are the prime on.
 *   - certificate blocker        -> partner. The credential has to be held,
 *     not bought in, so the route is teaming with someone who holds it.
 *   - "gap" on a credential-flavoured requirement -> partner, same reasoning.
 *   - "gap" on anything else     -> subcontract. No capability today, but it
 *     is capability, and capability is purchasable.
 *   - "partial"                  -> build. Most of the way there already;
 *     closing it in-house is normally cheaper than bringing in a third party.
 *
 * @param {object} item
 * @returns {{key: string, label: string, why: string}}
 */
function recommendAction(item) {
  if (item.kind === 'blocker') {
    if (item.type === 'insurance' || item.type === 'bonding') {
      return {
        key: 'do_not_bid',
        label: ACTION_LABEL.do_not_bid,
        why: 'Financial capacity has to be yours as prime — raise the limit before bidding, or let this one go.',
      };
    }

    return {
      key: 'partner',
      label: ACTION_LABEL.partner,
      why: 'The certification must be held by the bidder, so the route is teaming with a firm that already holds it.',
    };
  }

  if (item.verdict === 'partial') {
    return {
      key: 'build',
      label: ACTION_LABEL.build,
      why: 'Related capability already exists — closing the remaining distance in-house is usually the cheapest option.',
    };
  }

  if (CREDENTIAL_WORDING.test(item.text || '')) {
    return {
      key: 'partner',
      label: ACTION_LABEL.partner,
      why: 'This asks for a credential rather than work, and a credential cannot be subcontracted.',
    };
  }

  return {
    key: 'subcontract',
    label: ACTION_LABEL.subcontract,
    why: 'Nothing in the profile covers this, but it is deliverable work — price a subcontractor into the bid.',
  };
}

/**
 * Turns a §6.2 blocker into a gap-list row.
 *
 * @param {object} blocker
 * @returns {object}
 */
function fromBlocker(blocker) {
  const item = {
    kind: 'blocker',
    rank: 0,
    // Carried through so consumers have a stable, unique key per row.
    id: blocker.id,
    type: blocker.type,
    reqNumber: blocker.reqNumber,
    page: blocker.page,
    department: blocker.department,
    title: blocker.title,
    detail: blocker.detail,
    required: blocker.required,
    available: blocker.available,
    text: blocker.evidence,
    verdict: 'blocker',
    verdictLabel: 'Blocker',
    confidence: null,
    needsReview: false,
    source: 'code',
  };

  return { ...item, action: recommendAction(item) };
}

/**
 * Turns a §6.3 judgment into a gap-list row.
 *
 * @param {object} judgment
 * @returns {object}
 */
function fromJudgment(judgment) {
  const item = {
    kind: 'soft',
    rank: judgment.verdict === 'gap' ? 1 : 2,
    // Batch position, not row id — one requirement has exactly one judgment,
    // so this is unique across the soft half.
    id: `soft:${judgment.index}`,
    type: judgment.verdict,
    reqNumber: judgment.reqNumber,
    page: judgment.page,
    department: judgment.department,
    title:
      judgment.verdict === 'gap'
        ? 'No capability on file for this requirement'
        : 'Partial capability for this requirement',
    detail: judgment.note,
    required: judgment.evidenceRfp,
    available: judgment.evidenceProfile,
    text: judgment.requirementText,
    verdict: judgment.verdict,
    verdictLabel: VERDICT_LABEL[judgment.verdict],
    confidence: judgment.confidence,
    needsReview: judgment.needsReview,
    source: 'ai',
  };

  return { ...item, action: recommendAction(item) };
}

/**
 * Builds the factor-by-factor breakdown.
 *
 * The three blocker rules are reported even when they found nothing, because
 * "checked, clear" and "could not check" are different answers and only one of
 * them is reassuring.
 *
 * @param {object} blockerStats §6.2 stats.
 * @param {Array<object>} blockers
 * @param {number|null} capabilityScore
 * @param {object} verdictCounts
 * @returns {Array<object>}
 */
function buildFactors(blockerStats, blockers, capabilityScore, verdictCounts) {
  const skipped = new Set(blockerStats.skippedRules || []);

  const rule = (key, label, detailWhenClear) => {
    // Factor keys are plural ("certificates"); blocker types are singular
    // ("certificate"). Comparing them directly reported a factor as CLEAR
    // while its own blockers sat in the gap list underneath it.
    const hits = blockers.filter(
      (blocker) => blocker.type === FACTOR_BLOCKER_TYPE[key]
    );

    if (skipped.has(key)) {
      return {
        key,
        label,
        status: 'unknown',
        count: 0,
        detail:
          key === 'certificates'
            ? 'No certifications on the company profile, so nothing could be compared.'
            : `The company profile does not state a ${key === 'insurance' ? 'insurance limit' : 'bonding capacity'}, so nothing could be compared.`,
      };
    }

    // One requirement can raise several blockers of the same kind — a single
    // sentence naming two certifications produces two. The count is of
    // blockers; the REQ list is deduplicated, because repeating the same
    // number reads as a rendering fault.
    const reqNumbers = [...new Set(hits.map((hit) => hit.reqNumber))];

    return {
      key,
      label,
      status: hits.length > 0 ? 'fail' : 'pass',
      count: hits.length,
      detail:
        hits.length > 0
          ? `${hits.length} unmet ${hits.length === 1 ? 'check' : 'checks'} in ` +
            `${reqNumbers.length} requirement${reqNumbers.length === 1 ? '' : 's'}: ` +
            `${reqNumbers.join(', ')}.`
          : detailWhenClear,
    };
  };

  const factors = [
    rule(
      'certificates',
      'Certifications',
      'Every certification named in the requirements is on the company profile.'
    ),
    rule(
      'insurance',
      'Insurance',
      'No stated coverage requirement exceeds the profile’s insurance limit.'
    ),
    rule(
      'bonding',
      'Bonding',
      'No stated bond requirement exceeds the profile’s bonding capacity.'
    ),
  ];

  factors.push({
    key: 'capability',
    label: 'Capability coverage',
    status:
      capabilityScore === null
        ? 'unknown'
        : capabilityScore >= 75
          ? 'pass'
          : capabilityScore >= 50
            ? 'partial'
            : 'fail',
    count: verdictCounts.gap,
    score: capabilityScore,
    detail:
      capabilityScore === null
        ? 'Not assessed. Run the AI fit judgment to score how much of the work the profile actually covers.'
        : `${verdictCounts.can_do} can do · ${verdictCounts.partial} partial · ${verdictCounts.gap} gap, across ${
            verdictCounts.can_do + verdictCounts.partial + verdictCounts.gap
          } judged requirement(s).`,
  });

  return factors;
}

/**
 * §6.4 entry point: combines §6.2 and §6.3 into a score, factors, and gaps.
 *
 * @param {object} input
 * @param {Array<object>} input.blockers §6.2 blockers.
 * @param {object} input.blockerStats §6.2 stats.
 * @param {Object<string, object>} [input.judgments] §6.3 judgments, keyed by
 *   1-based batch index. Absent or empty means the AI pass has not been run.
 *
 * @returns {{score: number|null, verdict: object, provisional: boolean,
 *   factors: Array<object>, gaps: Array<object>, counts: object}}
 *   `score` is null only when there is nothing at all to score. `provisional`
 *   is true whenever the capability half is missing, so the UI can say the
 *   number is incomplete rather than implying a full assessment.
 *
 * @example
 * const { score, verdict, gaps } = computeFitScore({ blockers, blockerStats });
 * gaps[0].action.label // 'Do not bid'
 */
function computeFitScore({ blockers, blockerStats, judgments }) {
  const blockerList = Array.isArray(blockers) ? blockers : [];
  const stats = blockerStats || { skippedRules: [] };

  const judgmentList = judgments ? Object.values(judgments) : [];

  const verdictCounts = { can_do: 0, partial: 0, gap: 0 };

  let weightTotal = 0;

  for (const judgment of judgmentList) {
    if (!(judgment.verdict in VERDICT_WEIGHT)) {
      continue;
    }

    verdictCounts[judgment.verdict] += 1;
    weightTotal += VERDICT_WEIGHT[judgment.verdict];
  }

  const judged = verdictCounts.can_do + verdictCounts.partial + verdictCounts.gap;

  const capabilityScore =
    judged > 0 ? Math.round((weightTotal / judged) * 100) : null;

  // With no capability signal the score reports the blocker checks alone,
  // starting from 100 rather than 0 — an unjudged requirement is not a failed
  // one, and `provisional` says the number is half an answer.
  const base = capabilityScore === null ? 100 : capabilityScore;

  const penalty = Math.min(
    MAX_BLOCKER_PENALTY,
    blockerList.length * BLOCKER_PENALTY
  );

  // Nothing was assessed at all: no capability judgment, and every blocker
  // rule sat out because the profile had nothing to compare against. There is
  // no number to report, and reporting 100 would read as a pass.
  const skippedRules = new Set(stats.skippedRules || []);

  const nothingAssessed =
    capabilityScore === null &&
    Object.keys(FACTOR_BLOCKER_TYPE).every((key) => skippedRules.has(key));

  const score =
    nothingAssessed || !stats.requirementsChecked
      ? null
      : Math.max(0, Math.min(100, Math.round(base - penalty)));

  const gaps = [
    ...blockerList.map(fromBlocker),
    ...judgmentList
      .filter((judgment) => judgment.verdict !== 'can_do')
      .map(fromJudgment),
  ].sort((a, b) => {
    // Blockers, then gaps, then partials. Within a tier, the least certain
    // first — a low-confidence gap is the one most worth a human's time.
    if (a.rank !== b.rank) return a.rank - b.rank;

    const confidence = (item) =>
      item.confidence === null ? 1 : item.confidence;

    return (
      confidence(a) - confidence(b) ||
      String(a.reqNumber).localeCompare(String(b.reqNumber))
    );
  });

  const actionCounts = gaps.reduce((totals, gap) => {
    totals[gap.action.key] = (totals[gap.action.key] || 0) + 1;

    return totals;
  }, {});

  return {
    score,
    verdict: toVerdict(score, blockerList.length, capabilityScore === null),
    // True whenever the capability half is missing, so no consumer can present
    // a blocker-only number as a complete fit assessment.
    provisional: capabilityScore === null,
    capabilityScore,
    factors: buildFactors(stats, blockerList, capabilityScore, verdictCounts),
    gaps,
    counts: {
      blockers: blockerList.length,
      judged,
      ...verdictCounts,
      actions: actionCounts,
    },
    scoring: {
      base,
      penalty,
      blockerPenalty: BLOCKER_PENALTY,
      maxBlockerPenalty: MAX_BLOCKER_PENALTY,
      weights: VERDICT_WEIGHT,
    },
  };
}

module.exports = {
  computeFitScore,
  recommendAction,
  toVerdict,
  VERDICT_WEIGHT,
  VERDICT_LABEL,
  ACTION_LABEL,
  BLOCKER_PENALTY,
  MAX_BLOCKER_PENALTY,
};
