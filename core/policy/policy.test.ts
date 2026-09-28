import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "./index";

describe("core/policy - evaluatePolicy", () => {
  it("allows a known-safe action autonomously", () => {
    const result = evaluatePolicy("research", {});
    expect(result.level).toBe("AUTONOMOUS");
    expect(result.allowed).toBe(true);
  });

  it("allows CRM read/update actions autonomously", () => {
    const result = evaluatePolicy("crm", {});
    expect(result.level).toBe("AUTONOMOUS");
    expect(result.allowed).toBe(true);
  });

  it("flags an external-communication tool as NOTIFY, still allowed", () => {
    const result = evaluatePolicy("email", {});
    expect(result.level).toBe("NOTIFY");
    expect(result.allowed).toBe(true);
  });

  it("flags a high-impact/irreversible action as NOTIFY, still allowed", () => {
    const result = evaluatePolicy("place-order", { irreversible: true });
    expect(result.level).toBe("NOTIFY");
    expect(result.allowed).toBe(true);
    expect(result.decision.category).toBe("HIGH_IMPACT");
  });

  it("flags information-missing actions as NOTIFY", () => {
    const result = evaluatePolicy("draft-quote", { requiredFieldsMissing: ["clientId"] });
    expect(result.level).toBe("NOTIFY");
    expect(result.decision.category).toBe("INFORMATION_MISSING");
  });

  for (const blocked of [
    "financial.transaction",
    "trading.execute",
    "security.password",
    "data.delete",
    "legal.commit",
    "account.delete",
    "security.bypass",
  ]) {
    it(`hard-blocks "${blocked}" regardless of decision category`, () => {
      const result = evaluatePolicy(blocked, {});
      expect(result.level).toBe("BLOCKED");
      expect(result.allowed).toBe(false);
    });
  }

  it("cannot be overridden into AUTONOMOUS by autoApprovedActions", () => {
    // Even if a (hypothetical, bad) settings row pre-approved this action
    // name, the hardcoded block must still win.
    const result = evaluatePolicy("data.delete", {
      autoApprovedActions: ["data.delete"],
    });
    expect(result.level).toBe("BLOCKED");
    expect(result.allowed).toBe(false);
  });
});
