// core/crm/qualification.ts - deterministic lead qualification (Phase 7,
// item 10). A pure function: same input always produces the same output, no
// I/O, no LLM call, no opaque single number - always `qualified` PLUS a
// human-readable `reasons[]` explaining the verdict (or explaining why it's
// still UNKNOWN for lack of signal).
export interface QualificationSignals {
  /** From research/CRM: does the company appear to be a real, findable business? */
  hasVerifiedCompany: boolean;
  /** Does the company's industry match a configured product category's target market? Undefined = unknown. */
  industryMatchesProductLine?: boolean;
  /** A real contact person (not just a generic info@ address) is known. */
  hasNamedContact: boolean;
  /** Estimated order value/potential, if known from research or the lead itself. */
  estimatedValue?: number | null;
  /** Any negative/disqualifying signal found (e.g. explicitly not accepting new suppliers, competitor, etc). */
  disqualifyingSignals?: string[];
  /** Whether research actually ran and returned real findings (vs. no research yet). */
  researchCompleted: boolean;
}

export interface QualificationResult {
  qualified: boolean | "UNKNOWN";
  reasons: string[];
  scoredAt: string;
}

const MIN_VALUE_OF_INTEREST = 100; // currency units - a below-threshold estimate is a reason, not a disqualifier

/**
 * Deterministic rule set (documented exhaustively, per item 10):
 * 1. Any disqualifying signal -> qualified = false, reasons list each one.
 * 2. Research not completed AND no verified company -> qualified = "UNKNOWN"
 *    (not enough information to say either way - never guess).
 * 3. Verified company + named contact + no disqualifiers -> qualified = true.
 * 4. Verified company but no named contact yet, or industry match unknown ->
 *    qualified = "UNKNOWN" with a reason naming exactly what's missing.
 * 5. Everything else (e.g. company not verified but research did complete) ->
 *    qualified = false, reason states the company could not be verified.
 */
export function qualifyLead(signals: QualificationSignals): QualificationResult {
  const reasons: string[] = [];
  const scoredAt = new Date().toISOString();

  if (signals.disqualifyingSignals && signals.disqualifyingSignals.length > 0) {
    for (const s of signals.disqualifyingSignals) reasons.push(`Disqualifying signal: ${s}`);
    return { qualified: false, reasons, scoredAt };
  }

  if (!signals.researchCompleted && !signals.hasVerifiedCompany) {
    reasons.push("Research has not completed yet and the company is not otherwise verified - insufficient information to qualify.");
    return { qualified: "UNKNOWN", reasons, scoredAt };
  }

  if (!signals.hasVerifiedCompany) {
    reasons.push("Research completed but could not verify the company is a real, findable business.");
    return { qualified: false, reasons, scoredAt };
  }
  reasons.push("Company was verified as a real business.");

  if (!signals.hasNamedContact) {
    reasons.push("No named contact person found yet (only a generic address, or none) - cannot fully qualify without one.");
    return { qualified: "UNKNOWN", reasons, scoredAt };
  }
  reasons.push("A named contact person is known.");

  if (signals.industryMatchesProductLine === false) {
    reasons.push("Company's industry does not appear to match any configured product category.");
    return { qualified: false, reasons, scoredAt };
  }
  if (signals.industryMatchesProductLine === undefined) {
    reasons.push("Industry-to-product-line match could not be determined from available data.");
    return { qualified: "UNKNOWN", reasons, scoredAt };
  }
  reasons.push("Company's industry matches a configured product category.");

  if (typeof signals.estimatedValue === "number" && signals.estimatedValue < MIN_VALUE_OF_INTEREST) {
    reasons.push(`Estimated value (${signals.estimatedValue}) is below the threshold of interest (${MIN_VALUE_OF_INTEREST}), but not disqualifying on its own.`);
  }

  reasons.push("No disqualifying signals found.");
  return { qualified: true, reasons, scoredAt };
}
