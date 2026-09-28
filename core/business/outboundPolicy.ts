// core/business/outboundPolicy.ts - Outbound Risk Policy (Phase 7, item 16,
// THE MOST CRITICAL MODULE THIS PHASE).
//
// EXACT WIRING INTO core/policy (documented per the brief's requirement):
// this module does NOT invent a second, disconnected enforcement path. It:
//
//   1. Classifies outbound content into a risk category using fixed,
//      DATA-DRIVEN rules (keyword/shape matching against configured
//      categories below - never eval'd, never free-form code, same
//      no-eval discipline as core/conditions).
//   2. Feeds that classification into core/decision_engine's existing
//      DecisionInput shape (`irreversible: true` for HIGH risk, plus
//      `monetaryValue` when a price is present) - the EXACT fields
//      classify() already understands - so core/policy.evaluatePolicy()
//      (called unmodified, inside the UNMODIFIED core/enforcement gate every
//      tool call already goes through) reaches HIGH_IMPACT/NOTIFY for a
//      HIGH-RISK send, exactly like any other high-impact action. No new
//      PolicyLevel/DecisionCategory was invented; no existing mapping in
//      core/policy or core/decision_engine was changed.
//   3. BUT: core/enforcement's NOTIFY level still EXECUTES the tool (it only
//      creates a Notification) - by itself that is NOT the "always stops at
//      WAITING/REQUIRES_APPROVAL" guarantee item 16 demands. So the actual,
//      non-bypassable stop is enforced ONE LAYER DEEPER, inside the email
//      tool's own execute() body (tools/email/emailTool.ts) - the ONLY place
//      a real provider.sendMessage() call can ever happen (per item 1's
//      "no direct fetch/SMTP call outside a registered Tool's execute()").
//      That function calls classifyOutboundEmail() (this file) BEFORE ever
//      calling provider.sendMessage(), and for HIGH risk: (a) creates a
//      PENDING ApprovalRequest if one doesn't already exist for this exact
//      idempotency key, and (b) returns WAITING/BLOCKED without ever
//      touching the provider - regardless of what PolicyLevel core/policy
//      returned. This means EVEN IF the enforcement gate's NOTIFY level
//      allowed the tool call through (which it always does, by design), the
//      tool itself still cannot complete a HIGH-RISK send without a prior,
//      separately-audited OWNER approval. There is no code path that skips
//      this check: it is unconditional, at the top of emailTool's "send"
//      action, before any provider call.
//
// See agents/no-autonomous-highrisk-send.test.ts for the architectural proof
// (greps tools/email/emailTool.ts to confirm provider.sendMessage() is only
// ever reached after this gate, and exercises the actual runtime behavior).
import { classify } from "../decision_engine";
import { evaluatePolicy, type PolicyResult } from "../policy";

export type OutboundRiskCategory = "LOW" | "HIGH";

export interface OutboundRiskResult {
  riskCategory: OutboundRiskCategory;
  reasons: string[];
  policy: PolicyResult;
}

// Data-driven keyword categories. Each list is DATA (a plain array), never
// executable logic - matching itself is a fixed, auditable substring/regex
// scan, same discipline as core/policy's own BLOCKED_KEYWORDS.
const HIGH_RISK_KEYWORD_GROUPS: Record<string, string[]> = {
  pricing_or_quotation: ["quote", "quotation", "price", "pricing", "cost per unit", "unit price", "invoice"],
  contractual_commitment: ["agreement", "contract", "terms and conditions", "binding", "we commit", "guarantee delivery"],
  payment_instructions: ["wire transfer", "bank account", "swift code", "iban", "payment link", "pay now", "remit payment"],
  refunds: ["refund", "chargeback", "money back"],
  legal_statements: ["liability", "indemnify", "legal action", "warranty claim", "lawsuit"],
  sensitive_customer_data: ["ssn", "passport number", "credit card", "date of birth"],
};

export interface OutboundEmailContext {
  subject: string;
  body: string;
  /** True when this send targets more than one recipient / is a batch campaign, per item 16's "mass campaigns". */
  isMassCampaign?: boolean;
  /** A monetary value explicitly attached to this send (e.g. a quote total), if known. */
  monetaryValue?: number;
}

function matchedKeywordGroups(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const [group, keywords] of Object.entries(HIGH_RISK_KEYWORD_GROUPS)) {
    if (keywords.some((kw) => lower.includes(kw))) matched.push(group);
  }
  return matched;
}

/**
 * Classifies an outbound email's risk category from its own content plus
 * explicit context flags - deterministic, no LLM call (classification must
 * never itself be probabilistic for something this safety-critical).
 */
export function classifyOutboundEmail(ctx: OutboundEmailContext): OutboundRiskResult {
  const reasons: string[] = [];
  const matchedGroups = matchedKeywordGroups(`${ctx.subject}\n${ctx.body}`);
  let riskCategory: OutboundRiskCategory = "LOW";

  if (matchedGroups.length > 0) {
    riskCategory = "HIGH";
    reasons.push(`Content matches high-risk categor${matchedGroups.length === 1 ? "y" : "ies"}: ${matchedGroups.join(", ")}.`);
  }
  if (ctx.isMassCampaign) {
    riskCategory = "HIGH";
    reasons.push("Marked as a mass campaign send.");
  }
  if (typeof ctx.monetaryValue === "number" && ctx.monetaryValue > 0) {
    riskCategory = "HIGH";
    reasons.push(`Carries an explicit monetary value (${ctx.monetaryValue}).`);
  }
  if (riskCategory === "LOW") {
    reasons.push("No high-risk category, mass-campaign flag, or monetary value detected.");
  }

  // Feed the classification into the EXISTING decision_engine/policy
  // machinery - additive input fields only, no new category invented.
  const decisionInput = {
    actionName: "email.send",
    toolName: "email",
    irreversible: riskCategory === "HIGH",
    monetaryValue: ctx.monetaryValue,
  };
  const policy = evaluatePolicy("email.send", decisionInput);
  // classify() is also called directly so tests/callers can assert the
  // underlying DecisionCategory without re-deriving evaluatePolicy's table
  // lookup - evaluatePolicy already calls classify() internally too; this
  // is not a second, divergent classification, it's the same pure function.
  void classify(decisionInput);

  return { riskCategory, reasons, policy };
}

// ---------------------------------------------------------------------------
// Phase 9 (Voice, item 9): classifyOutboundEmail() above is NOT modified -
// this is a thin voice-specific WRAPPER, not a second risk engine. Per the
// brief: an outbound PHONE CALL defaults to HIGH risk regardless of content,
// because unlike a written message a call cannot be reviewed before it
// "sends" (the human on the other end hears it live) and it is materially
// more intrusive/irreversible than an email or WhatsApp message. The ONE
// narrowly-defined LOW-risk exception, documented explicitly (per the
// brief's "document exactly what you classify LOW/MEDIUM" instruction): a
// pure CALLBACK_CONFIRMATION call - i.e. `purpose: "CALLBACK_CONFIRMATION"`
// explicitly set by the caller AND the underlying content still passes
// classifyOutboundEmail()'s own HIGH-risk keyword/mass-campaign/monetary
// checks (so a "callback confirmation" that happens to embed a quote/price/
// payment link is still HIGH, not silently downgraded by the label alone).
// No MEDIUM tier is defined this phase - only LOW/HIGH exist in
// OutboundRiskCategory, and inventing a third tier with no distinct handling
// anywhere else in the pipeline would be complexity with no real backing.
export type OutboundCallPurpose = "CALLBACK_CONFIRMATION" | "BUSINESS_OUTREACH" | "GENERAL";

export interface OutboundCallContext {
  body: string; // the intended talking points / script summary for this call, for content-based scanning
  purpose?: OutboundCallPurpose;
  isMassCampaign?: boolean;
  monetaryValue?: number;
}

export function classifyOutboundVoice(ctx: OutboundCallContext): OutboundRiskResult {
  const underlying = classifyOutboundEmail({ subject: "", body: ctx.body, isMassCampaign: ctx.isMassCampaign, monetaryValue: ctx.monetaryValue });

  const isNarrowLowCase = ctx.purpose === "CALLBACK_CONFIRMATION" && underlying.riskCategory === "LOW" && !ctx.isMassCampaign;

  if (isNarrowLowCase) {
    return { ...underlying, reasons: [...underlying.reasons, "Voice call classified LOW: an explicit CALLBACK_CONFIRMATION with no high-risk content, mass-campaign flag, or monetary value - the one narrow LOW-risk voice case (see core/business/outboundPolicy.ts's classifyOutboundVoice() header)."] };
  }

  if (underlying.riskCategory === "LOW") {
    // Every other voice call defaults to HIGH even when the content-only
    // scan came back LOW - a call is HIGH-risk by DEFAULT (see header).
    const decisionInput = { actionName: "voice.call", toolName: "voice", irreversible: true, monetaryValue: ctx.monetaryValue };
    const policy = evaluatePolicy("voice.call", decisionInput);
    void classify(decisionInput);
    return {
      riskCategory: "HIGH",
      reasons: ["Outbound phone calls default to HIGH risk regardless of content (live, unreviewable, more intrusive than a written message) - see core/business/outboundPolicy.ts's classifyOutboundVoice()."],
      policy,
    };
  }

  return underlying;
}
