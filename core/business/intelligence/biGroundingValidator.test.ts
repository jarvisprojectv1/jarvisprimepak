// core/business/intelligence/biGroundingValidator.test.ts - Phase 11,
// section 50: the sibling grounding validator's mechanical rules, mirroring
// core/research/groundingValidator.test.ts's own coverage.
import { describe, it, expect } from "vitest";
import { validateBiGrounding, type BiClaim, type BiGroundingValidSet } from "./biGroundingValidator";

const validSet: BiGroundingValidSet = { statementIds: new Set(["s1", "s2"]) };

describe("validateBiGrounding", () => {
  it("rejects a claim with empty statementIds", () => {
    const claim: BiClaim = { id: "c1", statement: "Something happened.", statementIds: [] };
    const result = validateBiGrounding([claim], validSet);
    expect(result.claims.length).toBe(0);
    expect(result.rejected[0].reason).toMatch(/empty statementIds/);
  });

  it("rejects the WHOLE claim if it cites even one unknown statementId (all-or-nothing)", () => {
    const claim: BiClaim = { id: "c2", statement: "X and Y.", statementIds: ["s1", "s99-invented"] };
    const result = validateBiGrounding([claim], validSet);
    expect(result.claims.length).toBe(0);
    expect(result.rejected[0].reason).toMatch(/unknown statementId/);
  });

  it("keeps a claim citing only real, valid statement ids", () => {
    const claim: BiClaim = { id: "c3", statement: "Grounded claim.", statementIds: ["s1", "s2"] };
    const result = validateBiGrounding([claim], validSet);
    expect(result.claims.length).toBe(1);
    expect(result.rejected.length).toBe(0);
  });
});
