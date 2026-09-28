import { describe, it, expect } from "vitest";
import { validateGrounding } from "./groundingValidator";
import type { ResearchFinding, ResearchContradiction } from "./synthesisTypes";

function finding(overrides: Partial<ResearchFinding>): ResearchFinding {
  return {
    id: "f1",
    statement: "Something happened.",
    classification: "SOURCE_CLAIM",
    evidenceIds: [],
    sourceIds: [],
    ...overrides,
  };
}

describe("core/research/groundingValidator - Phase 6.1 item 10", () => {
  const valid = { evidenceIds: new Set(["e1", "e2"]), sourceIds: new Set(["s1", "s2"]) };

  it("D: a finding whose evidenceIds/sourceIds all exist is kept as-is", () => {
    const f = finding({ evidenceIds: ["e1"], sourceIds: ["s1"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("E: a finding with an empty evidenceIds array is rejected as an unsupported claim", () => {
    const f = finding({ evidenceIds: [], sourceIds: ["s1"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/unsupported/i);
  });

  it("E: a finding citing an unknown (fabricated) evidenceId is rejected outright, not partially trusted", () => {
    const f = finding({ evidenceIds: ["e1", "e999-fabricated"], sourceIds: ["s1"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/unknown evidenceId/i);
  });

  it("a finding citing an unknown sourceId is rejected outright", () => {
    const f = finding({ evidenceIds: ["e1"], sourceIds: ["s1", "s999-fabricated"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/unknown sourceId/i);
  });

  it("a FACT classification with only one valid distinct source is downgraded to SOURCE_CLAIM, not rejected", () => {
    const f = finding({ classification: "FACT", evidenceIds: ["e1"], sourceIds: ["s1"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].classification).toBe("SOURCE_CLAIM");
  });

  it("a FACT classification corroborated by 2 distinct valid sources is kept as FACT", () => {
    const f = finding({ classification: "FACT", evidenceIds: ["e1", "e2"], sourceIds: ["s1", "s2"] });
    const result = validateGrounding([f], [], valid);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].classification).toBe("FACT");
  });

  it("contradictions with fewer than 2 surviving valid sourceIds are dropped", () => {
    const contradictions: ResearchContradiction[] = [
      { description: "conflict A", conflictingSourceIds: ["s1", "s999-fake"] },
      { description: "conflict B", conflictingSourceIds: ["s1", "s2"] },
    ];
    const result = validateGrounding([], contradictions, valid);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].description).toBe("conflict B");
  });

  it("zero findings survive when every finding is unsupported or fabricated - callers must treat this as insufficient evidence", () => {
    const findings = [finding({ evidenceIds: [] }), finding({ id: "f2", evidenceIds: ["bad"] })];
    const result = validateGrounding(findings, [], valid);
    expect(result.findings).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
  });
});
