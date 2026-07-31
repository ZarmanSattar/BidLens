// Token-cost estimate for the §6.3 fit-judgment call.
//
// Same reason explainCost.js is its own file: CompanyFitCard imports it to
// render a live estimate on the button, and judgeFit.js imports it for the
// server-side log. Keeping it dependency-free means importing it from a
// component cannot pull groqHelper — and therefore groq-sdk — into the
// browser bundle.

/** System prompt, re-sent once per call. */
const SYSTEM_PROMPT_TOKENS = 600;

/** The company profile block, sent once and shared by every requirement. */
const PROFILE_TOKENS = 450;

/** REQ number, department, page, and the clipped requirement text. */
const TOKENS_PER_REQUIREMENT_IN = 95;

/** Verdict, two short evidence strings, and the JSON wrapper. */
const TOKENS_PER_REQUIREMENT_OUT = 75;

/**
 * Estimates the total tokens one fit-judgment call will cost.
 *
 * Approximate by design — it exists so the button can be honest about the
 * order of magnitude before anyone spends anything, not to bill against.
 *
 * @param {number} requirementCount Requirements that will be judged, i.e.
 *   work requirements MINUS the ones §6.2 already blocked.
 * @returns {{input: number, output: number, total: number, label: string}}
 *   `label` is display-ready, e.g. "~14,000 tokens".
 *
 * @example
 * estimateJudgeTokens(84).label // "~15,000 tokens"
 */
function estimateJudgeTokens(requirementCount) {
  const count = Math.max(0, Number(requirementCount) || 0);

  const input =
    SYSTEM_PROMPT_TOKENS + PROFILE_TOKENS + count * TOKENS_PER_REQUIREMENT_IN;
  const output = count * TOKENS_PER_REQUIREMENT_OUT;
  const total = input + output;

  // Rounded to the nearest 500 — false precision on an estimate reads as a
  // promise it cannot keep.
  const rounded = Math.round(total / 500) * 500;

  return {
    input,
    output,
    total,
    label: `~${rounded.toLocaleString('en-US')} tokens`,
  };
}

module.exports = {
  estimateJudgeTokens,
  SYSTEM_PROMPT_TOKENS,
  PROFILE_TOKENS,
  TOKENS_PER_REQUIREMENT_IN,
  TOKENS_PER_REQUIREMENT_OUT,
};
