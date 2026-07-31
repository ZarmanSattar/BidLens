// Token-cost estimate for the §6.3 fit-judgment call.
//
// Same reason explainCost.js is its own file: CompanyFitCard imports it to
// render a live estimate on the button, and judgeFit.js imports it for the
// server-side log. Keeping it dependency-free means importing it from a
// component cannot pull groqHelper — and therefore groq-sdk — into the
// browser bundle.
//
// The numbers below are MEASURED against the ODU dataset (44-page RFP, 84
// unblocked work requirements), not guessed: the system prompt is 2,727
// characters, a rendered requirement averages 364, and a small company profile
// renders to 430. They are approximate by design — this exists so the button
// can be honest about the order of magnitude before anyone spends anything,
// not to bill against.

/** System prompt, re-sent once PER BATCH. Measured: 2,727 chars. */
const SYSTEM_PROMPT_TOKENS = 700;

/**
 * The company profile block, re-sent once PER BATCH.
 *
 * Measured at ~120 tokens for a sparse profile; a filled-in one with several
 * past projects and staff groups reaches ~400. The estimate uses the higher
 * end, because a profile that gets richer over time should not quietly make
 * the number on the button an under-quote.
 */
const PROFILE_TOKENS = 300;

/** REQ number, department, page, and the clipped requirement text. */
const TOKENS_PER_REQUIREMENT_IN = 100;

/** Verdict, two short evidence strings, a note, and the JSON wrapper. */
const TOKENS_PER_REQUIREMENT_OUT = 75;

/** Mirrors judgeFit's own budget, so the peak below matches what it sends. */
const TOKENS_PER_JUDGMENT_RESERVED = 110;
const MIN_COMPLETION_TOKENS = 1500;

/** Mirrors judgeFit.DEFAULT_BATCH_SIZE. Duplicated to keep this file dependency-free. */
const DEFAULT_BATCH_SIZE = 20;

/**
 * Estimates what one press of the fit-judgment button costs.
 *
 * Batching is not free: the system prompt and the whole company profile are
 * re-sent with every batch, so the fixed cost is multiplied by the batch count
 * rather than paid once. For 84 requirements at 20 per batch that is 5 copies
 * — roughly 5,000 tokens of overhead on top of the requirement text.
 *
 * @param {number} requirementCount Requirements that will be judged, i.e.
 *   work requirements MINUS the ones §6.2 already blocked.
 * @param {number} [batchSize=20] Requirements per Groq call.
 * @returns {{input: number, output: number, total: number, label: string,
 *   batches: number, perCallPeak: number}}
 *   `label` is display-ready, e.g. "~20,000 tokens". `perCallPeak` is what a
 *   single request presents to Groq's rate limiter — input PLUS the
 *   `max_tokens` reservation, which Groq counts as part of the request. That
 *   is the number that has to stay under the TPM cap; `total` is spend across
 *   the whole run and is bounded by the rolling window instead.
 *
 * @example
 * estimateJudgeTokens(84).label       // "~20,000 tokens"
 * estimateJudgeTokens(84).perCallPeak // 5200 — against a 12,000 TPM cap
 */
function estimateJudgeTokens(requirementCount, batchSize = DEFAULT_BATCH_SIZE) {
  const count = Math.max(0, Number(requirementCount) || 0);
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);

  const batches = Math.ceil(count / size);

  // Fixed cost is per BATCH, not per run — this is the whole tradeoff of
  // splitting the call up.
  const input =
    batches * (SYSTEM_PROMPT_TOKENS + PROFILE_TOKENS) +
    count * TOKENS_PER_REQUIREMENT_IN;

  const output = count * TOKENS_PER_REQUIREMENT_OUT;
  const total = input + output;

  // What the largest single request looks like to the rate limiter. A full
  // batch of `size`, plus the completion reservation judgeFit asks for.
  const perCallPeak =
    count === 0
      ? 0
      : SYSTEM_PROMPT_TOKENS +
        PROFILE_TOKENS +
        Math.min(count, size) * TOKENS_PER_REQUIREMENT_IN +
        Math.max(
          MIN_COMPLETION_TOKENS,
          Math.min(count, size) * TOKENS_PER_JUDGMENT_RESERVED
        );

  // Rounded to the nearest 500 — false precision on an estimate reads as a
  // promise it cannot keep.
  const rounded = Math.round(total / 500) * 500;

  return {
    input,
    output,
    total,
    batches,
    perCallPeak,
    label: `~${rounded.toLocaleString('en-US')} tokens`,
  };
}

module.exports = {
  estimateJudgeTokens,
  SYSTEM_PROMPT_TOKENS,
  PROFILE_TOKENS,
  TOKENS_PER_REQUIREMENT_IN,
  TOKENS_PER_REQUIREMENT_OUT,
  DEFAULT_BATCH_SIZE,
};
