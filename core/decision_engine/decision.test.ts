import { describe, it, expect } from "vitest";
import { classify } from "./index";

describe("core/decision_engine classify()", () => {
  it("classifies a system failure as CRITICAL_SYSTEM_FAILURE", () => {
    const decision = classify({ systemFailure: true });
    expect(decision.category).toBe("CRITICAL_SYSTEM_FAILURE");
    expect(decision.requiresHumanApproval).toBe(true);
  });

  it("classifies missing required fields as INFORMATION_MISSING", () => {
    const decision = classify({ requiredFieldsMissing: ["clientEmail"] });
    expect(decision.category).toBe("INFORMATION_MISSING");
  });

  it("classifies missing third-party configuration as INFORMATION_MISSING", () => {
    const decision = classify({ configurationMissing: true });
    expect(decision.category).toBe("INFORMATION_MISSING");
  });

  it("classifies an irreversible action as HIGH_IMPACT", () => {
    const decision = classify({ irreversible: true, toolName: "email" });
    expect(decision.category).toBe("HIGH_IMPACT");
    expect(decision.requiresHumanApproval).toBe(true);
  });

  it("classifies a large monetary value as HIGH_IMPACT", () => {
    const decision = classify({ monetaryValue: 10000 }, 500);
    expect(decision.category).toBe("HIGH_IMPACT");
  });

  it("classifies a pre-approved action as ROUTINE", () => {
    const decision = classify({
      actionName: "log-daily-summary",
      autoApprovedActions: ["log-daily-summary"],
    });
    expect(decision.category).toBe("ROUTINE");
    expect(decision.requiresHumanApproval).toBe(false);
  });

  it("classifies a normal tool call within bounds as CONFIGURED_BUSINESS_ACTION", () => {
    const decision = classify({ toolName: "files", monetaryValue: 10 }, 500);
    expect(decision.category).toBe("CONFIGURED_BUSINESS_ACTION");
  });

  it("defaults to ROUTINE when no risk factors are present", () => {
    const decision = classify({});
    expect(decision.category).toBe("ROUTINE");
  });
});
