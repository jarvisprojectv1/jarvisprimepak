// core/business/intelligence/biGroundingValidator.ts - Phase 11, section 50.
//
// A structurally identical sibling of core/research/groundingValidator.ts
// (Phase 6.1), adapted from "a finding must cite real ResearchEvidence ids"
// to "a narrative claim must cite real, already-computed
// IntelligenceStatement ids". Same mechanical, non-semantic rule set:
//   1. A claim with an empty `statementIds` array is unsupported - REJECTED.
//   2. Every id in `statementIds` must be one of the ids in the bounded set
//      of statements actually handed to the LLM for this call - ANY unknown
//      id rejects the WHOLE claim (not just that id), same all-or-nothing
//      discipline as the research validator (a model citing one real id and
//      one invented one is still fabricating).
// There is no FACT/SOURCE_CLAIM corroboration-count rule here (unlike the
// research validator) because BI inputs are already-computed deterministic
// statements, not raw multi-source web evidence - corroboration doesn't
// apply the same way. Everything else about the shape is intentionally the
// same so the two validators read as one family, not two divergent designs.
export interface BiClaim {
  id: string;
  statement: string;
  statementIds: string[];
}

export interface BiGroundingValidSet {
  statementIds: Set<string>;
}

export interface BiGroundingRejection {
  claim: BiClaim;
  reason: string;
}

export interface BiGroundingResult {
  claims: BiClaim[];
  rejected: BiGroundingRejection[];
}

export function validateBiGrounding(claims: BiClaim[], valid: BiGroundingValidSet): BiGroundingResult {
  const kept: BiClaim[] = [];
  const rejected: BiGroundingRejection[] = [];

  for (const claim of claims) {
    if (!Array.isArray(claim.statementIds) || claim.statementIds.length === 0) {
      rejected.push({ claim, reason: "empty statementIds - unsupported claim." });
      continue;
    }
    const unknown = claim.statementIds.filter((id) => !valid.statementIds.has(id));
    if (unknown.length > 0) {
      rejected.push({ claim, reason: `references unknown statementId(s): ${unknown.join(", ")}` });
      continue;
    }
    kept.push(claim);
  }

  return { claims: kept, rejected };
}
