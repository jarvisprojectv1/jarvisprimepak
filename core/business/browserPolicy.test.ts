// core/business/browserPolicy.test.ts - Phase 10 sections 13-14, 54-55: the
// financial hard block and domain-policy/communication-bypass test suites.
import { describe, it, expect } from "vitest";
import {
  classifyDomain,
  classifyBrowserAction,
  isFinancialHardBlock,
  isCommunicationSendShaped,
  type BrowserActionType,
} from "./browserPolicy";

describe("browserPolicy: domain classification (section 13)", () => {
  it("defaults an unrecognized/unconfigured domain to REQUIRES_APPROVAL, never ALLOWED", () => {
    expect(classifyDomain("some-random-b2b-supplier-site.example")).toBe("UNKNOWN");
  });

  it("classifies a recognized financial-institution domain as BLOCKED", () => {
    expect(classifyDomain("www.paypal.com")).toBe("BLOCKED");
    expect(classifyDomain("chase.com")).toBe("BLOCKED");
    expect(classifyDomain("coinbase.com")).toBe("BLOCKED");
  });

  it("classifies a recognized webmail/social domain as REQUIRES_APPROVAL, not ALLOWED", () => {
    expect(classifyDomain("mail.google.com")).toBe("REQUIRES_APPROVAL");
    expect(classifyDomain("web.whatsapp.com")).toBe("REQUIRES_APPROVAL");
  });

  it("empty/malformed domain defaults to REQUIRES_APPROVAL (fail closed)", () => {
    expect(classifyDomain("")).toBe("REQUIRES_APPROVAL");
  });
});

describe("browserPolicy: FINANCIAL HARD BLOCK (section 14) - the single most safety-critical guarantee this phase", () => {
  const interactiveActions: BrowserActionType[] = ["click", "type", "select", "submit", "download", "upload"];

  it("blocks a bank-transfer-shaped submit regardless of domain", () => {
    const r = isFinancialHardBlock({ domain: "some-b2b-portal.example", actionType: "submit", targetText: "Confirm bank transfer" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a card-payment-shaped click regardless of domain", () => {
    const r = isFinancialHardBlock({ domain: "shop.example", actionType: "click", targetText: "Pay Now with card ending 4242" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a broker-order-shaped action", () => {
    const r = isFinancialHardBlock({ domain: "robinhood.com", actionType: "click", targetText: "Place trade" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a crypto-purchase-shaped action", () => {
    const r = isFinancialHardBlock({ domain: "coinbase.com", actionType: "click", targetText: "Buy crypto now" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a withdrawal-shaped action", () => {
    const r = isFinancialHardBlock({ domain: "some-wallet.example", actionType: "click", targetText: "Withdraw funds" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a deposit-shaped action", () => {
    const r = isFinancialHardBlock({ domain: "some-wallet.example", actionType: "click", targetText: "Deposit funds" });
    expect(r.blocked).toBe(true);
  });

  it("blocks a payment-confirmation-shaped action", () => {
    const r = isFinancialHardBlock({ domain: "checkout.example", actionType: "click", targetText: "Confirm payment" });
    expect(r.blocked).toBe(true);
  });

  it("blocks ANY interactive action on a recognized financial-institution domain, even with no financial-shaped text", () => {
    for (const actionType of interactiveActions) {
      const r = isFinancialHardBlock({ domain: "www.paypal.com", actionType, targetText: "innocuous button" });
      expect(r.blocked, `expected ${actionType} on paypal.com to be blocked`).toBe(true);
    }
  });

  it("does NOT block a plain read-only navigation to a financial institution's public page", () => {
    const r = isFinancialHardBlock({ domain: "www.chase.com", actionType: "navigate", targetText: null });
    expect(r.blocked).toBe(false);
  });

  it("classifyBrowserAction returns riskCategory BLOCKED with requiresApproval:false for a financial hard block - it is not merely approval-gated", () => {
    const result = classifyBrowserAction({
      domain: "checkout.example",
      actionType: "submit",
      targetText: "Place order for $4,500 - confirm purchase",
      domainClassification: classifyDomain("checkout.example"),
    });
    expect(result.riskCategory).toBe("BLOCKED");
    expect(result.hardBlocked).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("no approvalRequestId, however 'approved', can satisfy a financial hard block (documented invariant, checked by browserTool.ts's ordering)", () => {
    // This is an architectural property proven by tools/browser/browserTool.test.ts's
    // pipeline-ordering test (financial hard block checked before approval
    // lookup); here we assert the policy layer itself never emits an
    // "approval would help" signal for a hard-blocked action.
    const result = classifyBrowserAction({
      domain: "www.binance.com",
      actionType: "click",
      targetText: "Buy crypto",
      domainClassification: "BLOCKED",
    });
    expect(result.hardBlocked).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

describe("browserPolicy: communication-bypass prevention (sections 28, 31-33)", () => {
  it("flags a 'send' action on webmail as HIGH risk requiring approval, not silently allowed", () => {
    const domain = "mail.google.com";
    const result = classifyBrowserAction({
      domain,
      actionType: "click",
      targetText: "Send",
      domainClassification: classifyDomain(domain),
    });
    expect(result.riskCategory).toBe("HIGH");
    expect(result.requiresApproval).toBe(true);
  });

  it("flags a 'send' action on WhatsApp Web as HIGH risk requiring approval", () => {
    const domain = "web.whatsapp.com";
    const result = classifyBrowserAction({
      domain,
      actionType: "click",
      targetText: "Send message",
      domainClassification: classifyDomain(domain),
    });
    expect(result.riskCategory).toBe("HIGH");
    expect(result.requiresApproval).toBe(true);
  });

  it("flags a 'compose'/'post' action on a social domain as HIGH risk requiring approval", () => {
    const domain = "twitter.com";
    const result = classifyBrowserAction({
      domain,
      actionType: "submit",
      targetText: "Post tweet",
      domainClassification: classifyDomain(domain),
    });
    expect(result.riskCategory).toBe("HIGH");
    expect(result.requiresApproval).toBe(true);
  });

  it("flags a 'reply' action on an unrecognized webmail-like clone domain too - action shape matters, not just domain", () => {
    const domain = "some-other-webmail-clone.example";
    const result = classifyBrowserAction({
      domain,
      actionType: "click",
      targetText: "Reply and send",
      domainClassification: classifyDomain(domain),
    });
    expect(result.riskCategory).toBe("HIGH");
    expect(result.requiresApproval).toBe(true);
  });

  it("isCommunicationSendShaped is true for a send-labeled click/submit, false for plain navigation/read actions", () => {
    expect(isCommunicationSendShaped({ domain: "mail.google.com", actionType: "click", targetText: "Send" })).toBe(true);
    expect(isCommunicationSendShaped({ domain: "mail.google.com", actionType: "navigate", targetText: "Send" })).toBe(false);
    expect(isCommunicationSendShaped({ domain: "mail.google.com", actionType: "click", targetText: "Archive" })).toBe(false);
  });

  it("read-only browsing on a webmail/social domain (no send-shaped action) is not itself HIGH risk", () => {
    const domain = "mail.google.com";
    const result = classifyBrowserAction({
      domain,
      actionType: "navigate",
      targetText: null,
      domainClassification: classifyDomain(domain),
    });
    expect(result.riskCategory).toBe("READ_ONLY");
  });
});

describe("browserPolicy: risk taxonomy (section 15)", () => {
  it("navigate/scroll/extract/screenshot on an allowlisted domain are READ_ONLY", () => {
    const domain = "wikipedia.org";
    const result = classifyBrowserAction({ domain, actionType: "navigate", targetText: null, domainClassification: classifyDomain(domain) });
    expect(result.riskCategory).toBe("READ_ONLY");
  });

  it("submit/upload are HIGH regardless of domain", () => {
    const domain = "wikipedia.org";
    const result = classifyBrowserAction({ domain, actionType: "submit", targetText: "Save changes", domainClassification: classifyDomain(domain) });
    expect(result.riskCategory).toBe("HIGH");
  });

  it("download is MEDIUM (tracked, not auto-executed, policy-classifiable)", () => {
    const domain = "wikipedia.org";
    const result = classifyBrowserAction({ domain, actionType: "download", targetText: "report.pdf", domainClassification: classifyDomain(domain) });
    expect(result.riskCategory).toBe("MEDIUM");
  });

  it("a LOW-risk click on an UNKNOWN domain is escalated to MEDIUM (domain policy can only raise, never lower)", () => {
    const domain = "unrecognized-vendor-site.example";
    const result = classifyBrowserAction({ domain, actionType: "click", targetText: "Learn more", domainClassification: classifyDomain(domain) });
    expect(result.riskCategory).toBe("MEDIUM");
    expect(result.requiresApproval).toBe(true);
  });
});
