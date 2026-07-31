// Token-cost estimate for the §5.3 explanation call.
//
// Deliberately dependency-free and in its own file: ContractRiskCard imports
// it to render a live estimate on the button, and explainFindings.js imports
// it for the server-side log. If this lived in explainFindings.js, importing
// it from a component would pull groqHelper — and therefore groq-sdk — into
// the browser bundle.

/** Roughly the system prompt, re-sent once per call. */
const SYSTEM_PROMPT_TOKENS = 450;

/** Label + title + static description + two truncated evidence snippets. */
const TOKENS_PER_FINDING_IN = 160;

/** Two sentences of prose plus the JSON wrapper, per finding. */
const TOKENS_PER_FINDING_OUT = 70;

/**
 * Estimates the total tokens one explanation call will cost.
 *
 * Approximate by design — it exists so the button can be honest about the
 * order of magnitude before anyone spends anything, not to bill against.
 *
 * @param {number} findingCount
 * @returns {{input: number, output: number, total: number, label: string}}
 *   `label` is display-ready, e.g. "~1,100 tokens".
 *
 * @example
 * estimateExplainTokens(3).label // "~1,000 tokens"
 */
function estimateExplainTokens(findingCount) {
  const count = Math.max(0, Number(findingCount) || 0);

  const input = SYSTEM_PROMPT_TOKENS + count * TOKENS_PER_FINDING_IN;
  const output = count * TOKENS_PER_FINDING_OUT;
  const total = input + output;

  // Round to the nearest 100 — false precision on an estimate reads as a
  // promise it cannot keep.
  const rounded = Math.round(total / 100) * 100;

  return {
    input,
    output,
    total,
    label: `~${rounded.toLocaleString('en-US')} tokens`,
  };
}

module.exports = {
  estimateExplainTokens,
  SYSTEM_PROMPT_TOKENS,
  TOKENS_PER_FINDING_IN,
  TOKENS_PER_FINDING_OUT,
};
