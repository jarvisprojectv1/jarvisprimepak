// core/crm/qualification.test.ts - item L (deterministic lead qualification).
import { describe, it, expect } from "vitest";
import { qualifyLead } from "./qualification";

describe("L: lead qualification", () => {
  it("returns UNKNOWN with reasons when research hasn't run and there's no other verification", () => {
    const result = qualifyLead({ hasVerifiedCompany: false, hasNamedContact: false, researchCompleted: false });
    expect(result.qualified).toBe("UNKNOWN");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns false with reasons when disqualifying signals are present, regardless of other signals", () => {
    const result = qualifyLead({
      hasVerifiedCompany: true,
      hasNamedContact: true,
      researchCompleted: true,
      disqualifyingSignals: ["Explicitly stated they use a competitor exclusively."],
    });
    expect(result.qualified).toBe(false);
    expect(result.reasons.some((r) => r.includes("Disqualifying signal"))).toBe(true);
  });

  it("returns true with an explanatory reason chain when every positive signal is present", () => {
    const result = qualifyLead({
      hasVerifiedCompany: true,
      hasNamedContact: true,
      researchCompleted: true,
      industryMatchesProductLine: true,
      estimatedValue: 5000,
    });
    expect(result.qualified).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("returns UNKNOWN (never a guessed true/false) when the industry match can't be determined", () => {
    const result = qualifyLead({ hasVerifiedCompany: true, hasNamedContact: true, researchCompleted: true, industryMatchesProductLine: undefined });
    expect(result.qualified).toBe("UNKNOWN");
  });

  it("is a pure function - same input always yields the same output", () => {
    const input = { hasVerifiedCompany: true, hasNamedContact: false, researchCompleted: true } as const;
    const a = qualifyLead(input);
    const b = qualifyLead(input);
    expect(a.qualified).toBe(b.qualified);
    expect(a.reasons).toEqual(b.reasons);
  });

  it("never returns an opaque result - reasons[] is always non-empty", () => {
    const cases = [
      { hasVerifiedCompany: false, hasNamedContact: false, researchCompleted: true },
      { hasVerifiedCompany: true, hasNamedContact: false, researchCompleted: true },
    ];
    for (const c of cases) {
      expect(qualifyLead(c).reasons.length).toBeGreaterThan(0);
    }
  });
});
