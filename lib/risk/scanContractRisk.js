const { scanClauseRisk } = require('./clauseRisk');
const { scanWordingRisk } = require('./wordingRisk');

// Module 4 — the combined terms-risk scan (§5.1 + §5.2).
//
// One entry point over both passes, so callers never have to know the module
// is split in two. Plain code throughout: no AI, no network, no DB, no token
// cost. §5.3 (AI-written explanations of each finding) is deliberately not
// wired in — every description here is static text from the library, and the
// module is useful without it.
//
// The scan is pure and deterministic: the same document always produces the
// same findings. That is why nothing here is persisted — re-deriving it on
// view is cheap, and a stored copy would go stale the moment the clause
// library or a threshold changes.

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Runs the full contract-risk scan over one document.
 *
 * @param {string|Array} input Document text. Prefer the one-string-per-page
 *   array from rfps.pages — findings then carry real page numbers. A flat
 *   string works, but every finding's page will be null.
 * @param {object} [options] Passed through to the wording scan.
 * @returns {{findings: Array<object>, summary: object, stats: object}}
 *   `findings` is every clause and wording finding, most severe first.
 *
 * @example
 * const { findings, summary } = scanContractRisk(rfp.pages);
 */
function scanContractRisk(input, options = {}) {
  const clause = scanClauseRisk(input);
  const wording = scanWordingRisk(input, options);

  const findings = [...clause.findings, ...wording.findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.category.localeCompare(b.category) ||
      String(a.label).localeCompare(String(b.label))
  );

  const bySeverity = { high: 0, medium: 0, low: 0 };

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  }

  return {
    findings,
    summary: {
      total: findings.length,
      bySeverity,
      clauseFindings: clause.findings.length,
      wordingFindings: wording.findings.length,
    },
    stats: {
      clause: clause.stats,
      wording: wording.stats,
      // Stated explicitly so no consumer has to infer it: this pass never
      // calls a model.
      aiUsed: false,
    },
  };
}

module.exports = { scanContractRisk, SEVERITY_RANK };
