// core/business/emailClassification.ts - inbound email classification
// (Phase 7, item 13). Deterministic, keyword-based, cheap (no LLM cost) by
// default. Classification NEVER itself triggers an irreversible action - it
// is only a label + reasons, consumed by callers (e.g. to route a task,
// suggest a draft) that go through the normal enforcement/policy/approval
// path for anything that actually acts.
export type EmailCategory =
  | "NEW_INQUIRY"
  | "PRICING_REQUEST"
  | "SAMPLE_REQUEST"
  | "ORDER_FOLLOW_UP"
  | "COMPLAINT"
  | "UNSUBSCRIBE_REQUEST"
  | "SPAM_OR_IRRELEVANT"
  | "GENERAL_REPLY";

export interface ClassificationResult {
  category: EmailCategory;
  reasons: string[];
  confidence: number; // 0-1, always attached, never implied
}

// DATA-driven keyword rules - a plain lookup table, never eval'd or dynamic.
const RULES: Array<{ category: EmailCategory; keywords: string[] }> = [
  { category: "UNSUBSCRIBE_REQUEST", keywords: ["unsubscribe", "remove me from", "stop emailing", "opt out"] },
  { category: "COMPLAINT", keywords: ["complaint", "disappointed", "unacceptable", "refund", "not happy", "terrible service"] },
  { category: "SAMPLE_REQUEST", keywords: ["send a sample", "sample request", "can we get a sample", "product sample"] },
  { category: "PRICING_REQUEST", keywords: ["quote", "quotation", "price list", "how much does", "pricing for", "cost of"] },
  { category: "ORDER_FOLLOW_UP", keywords: ["order status", "my order", "shipment", "tracking number", "when will it arrive"] },
  { category: "NEW_INQUIRY", keywords: ["interested in", "looking for a supplier", "new inquiry", "would like to know more"] },
];

const SPAM_SIGNALS = ["unsubscribe from this list is not affiliated", "viagra", "lottery winner", "click here to claim"];

/**
 * Deterministic pre-classification. `text` should already have been passed
 * through core/research/trustBoundary.wrapExternalEmailContent() if it is
 * ever ALSO going to be interpolated into an LLM prompt - this function
 * itself does plain string matching, not an LLM call, so it has no prompt-
 * injection surface at all (the untrusted text is only ever scanned with a
 * fixed regex/substring rule table, never executed or interpreted).
 */
export function classifyEmailDeterministic(subject: string, body: string): ClassificationResult {
  const text = `${subject}\n${body}`.toLowerCase();
  const reasons: string[] = [];

  if (SPAM_SIGNALS.some((s) => text.includes(s))) {
    return { category: "SPAM_OR_IRRELEVANT", reasons: ["Matched known spam-signal phrase."], confidence: 0.9 };
  }

  for (const rule of RULES) {
    const hit = rule.keywords.find((kw) => text.includes(kw));
    if (hit) {
      reasons.push(`Matched keyword "${hit}" for category ${rule.category}.`);
      return { category: rule.category, reasons, confidence: 0.75 };
    }
  }

  reasons.push("No specific keyword rule matched; treated as a general reply.");
  return { category: "GENERAL_REPLY", reasons, confidence: 0.4 };
}
