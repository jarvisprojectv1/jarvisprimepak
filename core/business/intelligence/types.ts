// core/business/intelligence/types.ts - Phase 11 (Business Intelligence),
// section 2: the FACT/OBSERVATION/CALCULATION/FORECAST/INFERENCE/
// RECOMMENDATION/UNKNOWN taxonomy. This is the backbone type every BI
// module's output uses - every generated statement a report/briefing
// surfaces must be tagged with exactly one of these, and every module below
// is required to import and use IntelligenceStatement rather than returning
// a bare number/string.
//
// Definitions (deliberately mechanical, matching the discipline
// core/research/groundingValidator.ts and core/crm/qualification.ts already
// established - never a vibe-based label):
//   FACT           - directly read from a real, current CRM/DB row (e.g. "12
//                    leads have status QUOTING right now"). No interpretation.
//   OBSERVATION    - a directly-read fact about a past/point-in-time event
//                    (e.g. "Lead X's last communication was 14 days ago").
//   CALCULATION    - a deterministic arithmetic/aggregation over FACTs (e.g.
//                    "conversion rate from QUALIFIED to WON this month is
//                    18%"). Always reproducible from the same inputs.
//   FORECAST       - a deterministic projection based on historical
//                    CALCULATIONs, always carrying an explicit confidence
//                    label (never a bare number) - see forecasting.ts.
//   INFERENCE      - a non-deterministic (LLM-assisted) interpretation of
//                    FACTs/CALCULATIONs - e.g. "this lead appears to be
//                    stalling". MUST carry grounding evidence (the input
//                    statement ids it was derived from) - see synthesis.ts.
//   RECOMMENDATION - a suggested next action, never auto-executed - see
//                    recommendations.ts. Always carries evidence + reasoning
//                    + a priority level, never a bare instruction.
//   UNKNOWN        - explicitly: data needed to answer this is missing or
//                    insufficient. Used INSTEAD OF a fabricated zero/guess
//                    (section 59) - e.g. missing revenue data returns
//                    UNKNOWN, never "0".
export const STATEMENT_TYPES = [
  "FACT",
  "OBSERVATION",
  "CALCULATION",
  "FORECAST",
  "INFERENCE",
  "RECOMMENDATION",
  "UNKNOWN",
] as const;

export type StatementType = (typeof STATEMENT_TYPES)[number];

export function isValidStatementType(value: unknown): value is StatementType {
  return typeof value === "string" && (STATEMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Provenance for a computed metric/statement (sections 5-7): what real
 * records it came from, the date range considered, and the calculation
 * method - so a number is never presented with no lineage. `sourceIds` are
 * real DB row ids (Lead/Communication/Company/etc) - never invented.
 */
export interface Provenance {
  sourceIds: string[];
  sourceModel?: string;
  dateRangeStart?: string; // ISO
  dateRangeEnd?: string; // ISO
  calculationMethod: string;
}

/**
 * The shared output shape for every BI metric/finding. `value` is `null`
 * when `type` is "UNKNOWN" (insufficient data) - callers must check `type`
 * before trusting `value`.
 */
export interface IntelligenceStatement<T = unknown> {
  id: string;
  type: StatementType;
  label: string;
  value: T | null;
  /** Human-readable rendering, hedged appropriately for the type (e.g. FORECAST/INFERENCE never phrased as certainty). */
  narrative: string;
  provenance: Provenance;
  /** Only meaningful for FORECAST/INFERENCE - explicit confidence, never implied by tone alone. */
  confidence?: "LOW" | "MEDIUM" | "HIGH";
}

/**
 * Generic in `T` so it can be returned directly wherever an
 * `IntelligenceStatement<T>` is expected (the "UNKNOWN" branch of a function
 * that otherwise returns a typed value) - `value` is always genuinely
 * `null` at runtime when `type` is "UNKNOWN"; callers must check `type`
 * before trusting `value`, exactly as this file's header documents.
 */
export function unknownStatement<T = unknown>(id: string, label: string, reason: string): IntelligenceStatement<T> {
  return {
    id,
    type: "UNKNOWN",
    label,
    value: null,
    narrative: `${label}: UNKNOWN - ${reason}`,
    provenance: { sourceIds: [], calculationMethod: "none - insufficient data" },
  };
}

export type Priority = "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH";

export function isValidPriority(value: unknown): value is Priority {
  return value === "INFORMATIONAL" || value === "LOW" || value === "MEDIUM" || value === "HIGH";
}

/**
 * Sections 35-37: a structured, evidence-backed recommendation. Never
 * auto-executed by anything in this module - see
 * core/business/intelligence/recommendations.ts's file header for the
 * explicit "no execution path" guarantee.
 */
export interface Recommendation {
  id: string;
  recommendation: string;
  evidence: IntelligenceStatement[];
  reason: string;
  expectedImpact: string;
  risks: string[];
  requiredInfo: string[];
  confidence: "LOW" | "MEDIUM" | "HIGH";
  priority: Priority;
  actionType: string; // e.g. "FOLLOW_UP" | "REVIEW_PRICING" | "DATA_CLEANUP" | "ESCALATE" - descriptive only, never a direct tool name
}
