// core/ai/pricing.ts - APPROXIMATE per-model USD rate table for cost
// estimation only. This is NOT exact billing - Anthropic's actual invoice is
// the source of truth. Update these constants if pricing changes; they are
// a documented, maintained estimate, never fabricated per-call.
//
// Rates are USD per 1,000,000 tokens, as of this phase's writing (2026-09).
export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  "claude-sonnet-4-5-20250929": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-1": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-haiku-4-5": { inputPerMillion: 0.8, outputPerMillion: 4 },
};

const DEFAULT_RATE: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };

/** Approximate estimated cost in USD for one call. Never claimed as exact billing. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_RATES[model] ?? DEFAULT_RATE;
  const cost =
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}
