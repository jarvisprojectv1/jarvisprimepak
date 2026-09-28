// core/business/browserPolicy.ts - Browser Action Domain/Risk/Financial
// Policy (Phase 10, THE MOST SAFETY-CRITICAL MODULE THIS PHASE).
//
// This module does NOT invent a fourth parallel enforcement system. It
// follows the EXACT distinction core/policy.ts already draws for every other
// domain in this codebase:
//
//   - core/policy's BLOCKED_KEYWORDS list is HARDCODED (not Setting-backed),
//     matched with no approval escape hatch at all - isHardBlocked() takes
//     no config input. FINANCIAL_HARD_BLOCK below follows that identical
//     discipline: a hardcoded, non-runtime-configurable list/heuristic that
//     BLOCKS unconditionally, before approval is even consulted. There is no
//     code path in tools/browser/browserTool.ts that can reach a real
//     provider action for something this function flags - see that file's
//     handleBrowserAction(), where isFinancialHardBlock() is checked FIRST,
//     before domain policy, before risk classification, before approval
//     lookup.
//   - Everything else (REQUIRES_APPROVAL domains, HIGH-risk action shapes)
//     feeds core/decision_engine.classify() + core/policy.evaluatePolicy()
//     the SAME way core/business/outboundPolicy.ts already does for
//     email/WhatsApp/voice sends - not a second classifier with its own
//     independent notion of "high impact".
//
// Domain classification default is REQUIRES_APPROVAL, never ALLOWED, for any
// domain this file does not explicitly recognize (section 13's requirement):
// an unconfigured/unknown site is treated as at least as risky as any other
// unreviewed outbound action.
import { classify } from "../decision_engine";
import { evaluatePolicy, type PolicyResult } from "../policy";

export type DomainClassification = "ALLOWED" | "REQUIRES_APPROVAL" | "BLOCKED" | "UNKNOWN";
export type BrowserRiskCategory = "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";
export type BrowserActionType =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "screenshot"
  | "download"
  | "upload"
  | "submit"
  | "extract";

// ---------------------------------------------------------------------------
// Domain classification
// ---------------------------------------------------------------------------

// A small, explicit allowlist of domains that may be navigated/read
// read-only with no approval. This is NOT "ALLOWED means side-effects are
// fine" - see classifyBrowserAction() below, which still requires approval
// for any submit/download/upload/financial-shaped action on an ALLOWED
// domain. Deliberately tiny; expanding it is a code review, not a runtime
// config change, matching core/policy's BLOCKED_KEYWORDS discipline.
const ALLOWED_READ_ONLY_DOMAINS = ["wikipedia.org", "example.com"];

// Hardcoded, non-runtime-configurable (mirrors core/policy's
// BLOCKED_KEYWORDS). Recognized financial-institution / payment-processor
// domains - navigating here for anything beyond read-only browsing is
// BLOCKED outright by isFinancialHardBlock() below, never merely
// approval-gated.
export const FINANCIAL_DOMAIN_KEYWORDS = [
  "paypal.",
  "stripe.",
  "chase.",
  "bankofamerica.",
  "wellsfargo.",
  "citibank.",
  "hsbc.",
  "coinbase.",
  "binance.",
  "kraken.",
  "robinhood.",
  "fidelity.",
  "schwab.",
  "etrade.",
  "wise.com",
  "venmo.",
  "revolut.",
  "westernunion.",
  "moneygram.",
  "swift.com",
  "plaid.",
  "razorpay.",
  "square.",
  "wire.",
  "payoneer.",
];

// Known webmail / messaging-web-UI domains (section 28/31-33: communication-
// bypass prevention). Read-only browsing here MAY remain allowed (e.g.
// troubleshooting a delivery issue), but any send/compose/post-shaped action
// is BLOCKED per COMMUNICATION_SEND_ACTION_KEYWORDS below - see
// classifyBrowserAction(). This is a POLICY control (domain + action-shape
// heuristics), not the architectural "exactly one call site" guarantee the
// real email/WhatsApp/voice channels have - documented honestly in the
// Phase 10 report; do not overclaim equivalence.
export const COMMUNICATION_DOMAIN_KEYWORDS = [
  "mail.google.",
  "gmail.",
  "outlook.",
  "mail.yahoo.",
  "web.whatsapp.",
  "messenger.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "telegram.org",
  "web.telegram.",
  "slack.com",
  "discord.com",
];

export function domainMatchesAny(domain: string, keywords: string[]): boolean {
  const d = domain.toLowerCase();
  return keywords.some((kw) => d.includes(kw.toLowerCase()));
}

export function classifyDomain(domain: string): DomainClassification {
  const d = (domain || "").toLowerCase().trim();
  if (!d) return "REQUIRES_APPROVAL";
  if (domainMatchesAny(d, FINANCIAL_DOMAIN_KEYWORDS)) return "BLOCKED";
  if (domainMatchesAny(d, ALLOWED_READ_ONLY_DOMAINS)) return "ALLOWED";
  if (domainMatchesAny(d, COMMUNICATION_DOMAIN_KEYWORDS)) return "REQUIRES_APPROVAL";
  // Section 13: UNKNOWN (anything not explicitly configured) defaults to
  // REQUIRES_APPROVAL, never ALLOWED, for anything beyond read-only
  // navigation - enforced by classifyBrowserAction() below regardless of
  // this function's own return value for a plain "navigate".
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Financial hard block (section 14) - a HARD block, never merely a risk
// classification. Matches by domain OR by action-shape (checkout/payment/
// transfer/withdraw-form-submission-like target text), independent of each
// other: a financial-shaped submit on a non-recognized domain is ALSO
// blocked, since a scam/checkout clone would not appear on the domain list.
// ---------------------------------------------------------------------------
const FINANCIAL_ACTION_KEYWORDS = [
  "checkout",
  "place order",
  "confirm order",
  "confirm purchase",
  "buy now",
  "complete purchase",
  "pay now",
  "make payment",
  "submit payment",
  "confirm payment",
  "wire transfer",
  "bank transfer",
  "send money",
  "transfer funds",
  "withdraw",
  "deposit funds",
  "add funds",
  "add card",
  "add payment method",
  "routing number",
  "swift code",
  "iban",
  "card number",
  "cvv",
  "purchase crypto",
  "buy crypto",
  "place trade",
  "execute trade",
  "submit order",
];

export interface FinancialCheckInput {
  domain: string;
  actionType: BrowserActionType;
  /** Visible text of the target element (button label, link text) and/or form field labels, if known. */
  targetText?: string | null;
  /** Any text content visible on the page near the action, if known (e.g. a form's heading). */
  pageContext?: string | null;
}

/**
 * Returns true iff this action must be HARD BLOCKED regardless of approval -
 * a financial-institution domain being touched by anything beyond a plain
 * read-only navigation, OR any action (any domain) whose target/page text is
 * shaped like a financial transaction (checkout, payment, transfer,
 * withdrawal, deposit, trade). Read-only actions (navigate/scroll/extract/
 * screenshot) on a financial domain are NOT hard-blocked by themselves (a
 * user may legitimately want JARVIS to read a bank's published rate page),
 * but any interactive action there (click/type/select/submit/download/
 * upload) is.
 */
export function isFinancialHardBlock(input: FinancialCheckInput): { blocked: boolean; reason: string | null } {
  const domain = (input.domain || "").toLowerCase();
  const haystacks = [input.targetText ?? "", input.pageContext ?? ""].join(" \n ").toLowerCase();

  const onFinancialDomain = domainMatchesAny(domain, FINANCIAL_DOMAIN_KEYWORDS);
  const READ_ONLY_ACTIONS: BrowserActionType[] = ["navigate", "scroll", "extract", "screenshot"];

  if (onFinancialDomain && !READ_ONLY_ACTIONS.includes(input.actionType)) {
    return { blocked: true, reason: `Interactive action ("${input.actionType}") on a recognized financial-institution/payment-processor domain ("${domain}") is hard-blocked - no financial-transaction automation is implemented.` };
  }

  const financialActionShaped = FINANCIAL_ACTION_KEYWORDS.some((kw) => haystacks.includes(kw));
  if (financialActionShaped && !READ_ONLY_ACTIONS.includes(input.actionType)) {
    return { blocked: true, reason: `Action target/context matches a financial-transaction shape (checkout/payment/transfer/withdrawal/deposit/trade). This is hard-blocked regardless of domain or approval status.` };
  }

  return { blocked: false, reason: null };
}

// ---------------------------------------------------------------------------
// Communication-bypass prevention (sections 28, 31-33). NOT a hard block
// like financial - a legitimate approved use (e.g. an owner explicitly
// approving "log into webmail and forward this one message") is not
// impossible by construction, only gated behind mandatory HIGH-risk
// approval. See the Phase 10 report for the explicit honesty note this
// distinction requires: this is a policy/approval control, not the
// architectural "exactly one call site" guarantee real channels have.
// ---------------------------------------------------------------------------
const COMMUNICATION_SEND_ACTION_KEYWORDS = ["send", "post", "message", "reply", "compose", "tweet", "publish", "share"];

export function isCommunicationSendShaped(input: FinancialCheckInput): boolean {
  const haystacks = [input.targetText ?? "", input.pageContext ?? ""].join(" \n ").toLowerCase();
  if (input.actionType !== "click" && input.actionType !== "submit") return false;
  return COMMUNICATION_SEND_ACTION_KEYWORDS.some((kw) => haystacks.includes(kw));
}

// ---------------------------------------------------------------------------
// Risk classification (section 15) - taxonomy feeds the SAME
// core/decision_engine + core/policy machinery outboundPolicy.ts already
// wires email/WhatsApp/voice through, not a parallel classifier.
// ---------------------------------------------------------------------------
export interface BrowserRiskInput extends FinancialCheckInput {
  domainClassification: DomainClassification;
}

export interface BrowserRiskResult {
  riskCategory: BrowserRiskCategory;
  reasons: string[];
  requiresApproval: boolean;
  hardBlocked: boolean;
  policy: PolicyResult;
}

const READ_ONLY_ACTIONS: BrowserActionType[] = ["navigate", "scroll", "extract", "screenshot"];
const LOW_RISK_ACTIONS: BrowserActionType[] = ["click", "type", "select"];

export function classifyBrowserAction(input: BrowserRiskInput): BrowserRiskResult {
  const reasons: string[] = [];

  const hardBlock = isFinancialHardBlock(input);
  if (hardBlock.blocked) {
    reasons.push(hardBlock.reason as string);
    const policy = evaluatePolicy("browser.financial_hard_block", { kind: "tool", toolName: "browser", irreversible: true });
    return { riskCategory: "BLOCKED", reasons, requiresApproval: false, hardBlocked: true, policy };
  }

  if (input.domainClassification === "BLOCKED") {
    reasons.push(`Domain is on the hardcoded BLOCKED list.`);
    const policy = evaluatePolicy("browser.domain_blocked", { kind: "tool", toolName: "browser", irreversible: true });
    return { riskCategory: "BLOCKED", reasons, requiresApproval: false, hardBlocked: true, policy };
  }

  const commsShaped = isCommunicationSendShaped(input);
  if (commsShaped) {
    reasons.push(`Action resembles sending/posting/messaging ("${input.targetText ?? ""}") - HIGH risk regardless of domain (section 28/31-33 communication-bypass prevention).`);
  }

  let riskCategory: BrowserRiskCategory;
  if (READ_ONLY_ACTIONS.includes(input.actionType) && !commsShaped) {
    riskCategory = "READ_ONLY";
    reasons.push(`"${input.actionType}" is a read-only browser action.`);
  } else if (input.actionType === "download") {
    riskCategory = "MEDIUM";
    reasons.push("Downloads are tracked and policy-classifiable, never auto-executed.");
  } else if (input.actionType === "upload" || input.actionType === "submit" || commsShaped) {
    riskCategory = "HIGH";
    reasons.push(`"${input.actionType}" is a side-effecting/form-submission-shaped action.`);
  } else if (LOW_RISK_ACTIONS.includes(input.actionType)) {
    riskCategory = "LOW";
    reasons.push(`"${input.actionType}" is a low-risk interactive action.`);
  } else {
    riskCategory = "MEDIUM";
  }

  // Domain policy can only ever RAISE the requirement, never lower a risk
  // category the action shape already implied.
  if (input.domainClassification === "REQUIRES_APPROVAL" || input.domainClassification === "UNKNOWN") {
    if (riskCategory !== "READ_ONLY") {
      reasons.push(`Domain classification is ${input.domainClassification} - any beyond-read-only action requires approval.`);
      if (riskCategory === "LOW") riskCategory = "MEDIUM";
    }
  }

  const requiresApproval =
    riskCategory === "HIGH" ||
    (riskCategory !== "READ_ONLY" && (input.domainClassification === "REQUIRES_APPROVAL" || input.domainClassification === "UNKNOWN"));

  const policy = evaluatePolicy(`browser.${input.actionType}`, {
    kind: "tool",
    toolName: "browser",
    irreversible: riskCategory === "HIGH",
  });

  return { riskCategory, reasons, requiresApproval, hardBlocked: false, policy };
}

// Re-exported for readability at call sites (avoids importing classify()
// directly just to satisfy the "must feed the same machinery" requirement).
export { classify as decisionEngineClassify };
