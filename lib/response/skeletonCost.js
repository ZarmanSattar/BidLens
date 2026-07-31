// Token-cost estimate for the §8.3 skeleton-generation run.
//
// Same reason explainCost.js and judgeCost.js are separate files: the card
// imports this to price the button, and buildSkeletons.js imports it for the
// server log. Dependency-free, so importing it from a component cannot pull
// groqHelper — and therefore groq-sdk — into the browser bundle.
//
// Numbers are measured against the reference dataset (109 work requirements
// and evaluation factors across 5 departments) and the §6.3 shape that was
// already tuned against the 12,000 TPM cap.

/** System prompt, resent once per batch. */
const SYSTEM_PROMPT_TOKENS = 750;

/**
 * Library slice per batch — the budget skeletonLibrary enforces, not the
 * library's real size. This is the whole point of filtering: the estimate
 * stops growing when the library does.
 */
const LIBRARY_TOKENS_PER_BATCH = 1800;

/** REQ number, department, section and the clipped requirement text. */
const TOKENS_PER_REQUIREMENT_IN = 110;

/** A drafted paragraph plus its JSON wrapper. */
const TOKENS_PER_SKELETON_OUT = 200;

/** Mirrors buildSkeletons' own reservation, so perCallPeak matches reality. */
const TOKENS_RESERVED_PER_SKELETON = 250;
const MIN_COMPLETION_TOKENS = 1200;

/** Mirrors buildSkeletons.DEFAULT_BATCH_SIZE. Duplicated to stay dependency-free. */
const DEFAULT_BATCH_SIZE = 10;

/**
 * Estimates what generating skeletons for N requirements costs.
 *
 * @param {number} requirementCount Requirements still needing a skeleton.
 * @param {number} [batchSize=10]
 * @returns {{input: number, output: number, total: number, label: string,
 *   batches: number, perCallPeak: number}}
 *   `perCallPeak` is what one request presents to the rate limiter — input
 *   PLUS the max_tokens reservation, which Groq counts as part of the request.
 *   That is the number that must clear the TPM cap; `total` is spend across
 *   the whole run and is bounded by the rolling window instead.
 *
 * @example
 * estimateSkeletonTokens(109).label       // "~62,000 tokens"
 * estimateSkeletonTokens(109).perCallPeak // ~6,150 against a 12,000 cap
 */
function estimateSkeletonTokens(requirementCount, batchSize = DEFAULT_BATCH_SIZE) {
  const count = Math.max(0, Number(requirementCount) || 0);
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);

  const batches = Math.ceil(count / size);

  // Fixed cost is per BATCH: both the system prompt and the library slice are
  // resent every call.
  const input =
    batches * (SYSTEM_PROMPT_TOKENS + LIBRARY_TOKENS_PER_BATCH) +
    count * TOKENS_PER_REQUIREMENT_IN;

  const output = count * TOKENS_PER_SKELETON_OUT;
  const total = input + output;

  const perBatch = Math.min(count, size);

  const perCallPeak =
    count === 0
      ? 0
      : SYSTEM_PROMPT_TOKENS +
        LIBRARY_TOKENS_PER_BATCH +
        perBatch * TOKENS_PER_REQUIREMENT_IN +
        Math.max(MIN_COMPLETION_TOKENS, perBatch * TOKENS_RESERVED_PER_SKELETON);

  const rounded = Math.round(total / 1000) * 1000;

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
  estimateSkeletonTokens,
  SYSTEM_PROMPT_TOKENS,
  LIBRARY_TOKENS_PER_BATCH,
  TOKENS_PER_REQUIREMENT_IN,
  TOKENS_PER_SKELETON_OUT,
  DEFAULT_BATCH_SIZE,
};
