// core/research/groundingValidator.ts - Evidence-Grounding Validation
// (Phase 6.1, item 10). Runs AFTER the LLM's structured synthesis output has
// been parsed and schema-validated (core/research/synthesis.ts), and BEFORE
// any of it is trusted (surfaced to a caller, or written to Memory).
//
// The rule set is deliberately small and mechanical - no semantic judgment,
// just referential integrity + one corroboration rule:
//
//   1. A finding with an empty `evidenceIds` array is an unsupported claim -
//      REJECTED outright (never "supported by nothing").
//   2. Every id in `evidenceIds` must be a real ResearchEvidence id belonging
//      to THIS research run (the caller passes in the exact set collected
//      for the run - never "any evidence id that ever existed"). Any unknown
//      id REJECTS the whole finding (not just that one id) - a model citing
//      one real id and one invented one is still fabricating, so the whole
//      finding is untrustworthy.
//   3. Every id in `sourceIds` must likewise be a real ResearchSource id for
//      this run. Same all-or-nothing rejection rule as #2.
//   4. Classification discipline: a finding classified "FACT" must be
//      corroborated by at least 2 DISTINCT valid source ids. If it has fewer,
//      it is not rejected - it is DOWNGRADED to "SOURCE_CLAIM" (a single
//      source's assertion is never a FACT; this is the exact rule the task
//      spec asked to be documented). "SOURCE_CLAIM"/"ANALYSIS"/"UNCERTAINTY"
//      findings are left as classified.
//   5. `contradictions[].conflictingSourceIds` are filtered down to only
//      valid source ids for this run; a contradiction left with fewer than 2
//      surviving ids is dropped (a "contradiction" needs at least two real
//      sides).
//
// If, after all of this, zero findings survive: the caller must treat the
// whole synthesis as insufficient evidence, never return a fabricated
// result (see core/research/synthesis.ts's NO_VALID_FINDINGS outcome).
import type { ResearchFinding, ResearchContradiction } from "./synthesisTypes";

export interface GroundingValidSet {
  evidenceIds: Set<string>;
  sourceIds: Set<string>;
}

export interface GroundingRejection {
  finding: ResearchFinding;
  reason: string;
}

export interface GroundingResult {
  findings: ResearchFinding[];
  rejected: GroundingRejection[];
  contradictions: ResearchContradiction[];
}

export function validateGrounding(
  findings: ResearchFinding[],
  contradictions: ResearchContradiction[],
  valid: GroundingValidSet
): GroundingResult {
  const kept: ResearchFinding[] = [];
  const rejected: GroundingRejection[] = [];

  for (const finding of findings) {
    if (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0) {
      rejected.push({ finding, reason: "empty evidenceIds - unsupported claim." });
      continue;
    }
    const unknownEvidence = finding.evidenceIds.filter((id) => !valid.evidenceIds.has(id));
    if (unknownEvidence.length > 0) {
      rejected.push({ finding, reason: `references unknown evidenceId(s): ${unknownEvidence.join(", ")}` });
      continue;
    }
    const sourceIds = Array.isArray(finding.sourceIds) ? finding.sourceIds : [];
    const unknownSources = sourceIds.filter((id) => !valid.sourceIds.has(id));
    if (unknownSources.length > 0) {
      rejected.push({ finding, reason: `references unknown sourceId(s): ${unknownSources.join(", ")}` });
      continue;
    }

    const distinctSourceCount = new Set(sourceIds).size;
    let classification = finding.classification;
    if (classification === "FACT" && distinctSourceCount < 2) {
      // Rule #4: a FACT must be corroborated by >=2 independent sources.
      // Not rejected - downgraded, since the claim itself is still grounded
      // in real evidence, just not corroborated enough to call it a FACT.
      classification = "SOURCE_CLAIM";
    }

    kept.push({ ...finding, classification, sourceIds });
  }

  const validContradictions: ResearchContradiction[] = [];
  for (const c of contradictions) {
    const survivors = (c.conflictingSourceIds ?? []).filter((id) => valid.sourceIds.has(id));
    if (survivors.length >= 2) {
      validContradictions.push({ ...c, conflictingSourceIds: survivors });
    }
  }

  return { findings: kept, rejected, contradictions: validContradictions };
}
