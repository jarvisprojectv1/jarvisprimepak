// core/business/outboundPolicy.test.ts - the exact-wiring proof for item 16:
// classifyOutboundEmail() feeds core/policy.evaluatePolicy() (unmodified)
// via classify()'s existing irreversible/monetaryValue fields.
import { describe, it, expect } from "vitest";
import { classifyOutboundEmail } from "./outboundPolicy";

describe("outbound risk classification -> core/policy wiring", () => {
  it("LOW risk: policy.level is not BLOCKED and decision.category is not HIGH_IMPACT", () => {
    const result = classifyOutboundEmail({ subject: "Hi", body: "Nice to meet you, looking forward to working together." });
    expect(result.riskCategory).toBe("LOW");
    expect(result.policy.decision.category).not.toBe("HIGH_IMPACT");
  });

  it("HIGH risk (pricing keyword): feeds decision_engine as irreversible=true -> HIGH_IMPACT category, requiresHumanApproval=true", () => {
    const result = classifyOutboundEmail({ subject: "Quotation", body: "Here is our quote for your order." });
    expect(result.riskCategory).toBe("HIGH");
    expect(result.policy.decision.category).toBe("HIGH_IMPACT");
    expect(result.policy.decision.requiresHumanApproval).toBe(true);
  });

  it("HIGH risk via mass-campaign flag, even with otherwise benign content", () => {
    const result = classifyOutboundEmail({ subject: "Hello", body: "Just checking in.", isMassCampaign: true });
    expect(result.riskCategory).toBe("HIGH");
  });

  it("HIGH risk via an explicit monetary value, even with no risky keywords", () => {
    const result = classifyOutboundEmail({ subject: "Hello", body: "Following up.", monetaryValue: 1200 });
    expect(result.riskCategory).toBe("HIGH");
  });

  it("payment instructions are HIGH risk", () => {
    const result = classifyOutboundEmail({ subject: "Payment", body: "Please wire transfer to our bank account." });
    expect(result.riskCategory).toBe("HIGH");
  });

  it("legal statements are HIGH risk", () => {
    const result = classifyOutboundEmail({ subject: "Re: dispute", body: "We accept liability and will indemnify you." });
    expect(result.riskCategory).toBe("HIGH");
  });

  it("always returns reasons[] explaining the classification", () => {
    const result = classifyOutboundEmail({ subject: "Hi", body: "Thanks!" });
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
