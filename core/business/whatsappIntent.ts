// core/business/whatsappIntent.ts - deterministic WhatsApp intent
// classification (Phase 8, item 17).
//
// Deliberately NOT a second keyword-rule engine: this is a thin adapter over
// core/business/emailClassification.ts's classifyEmailDeterministic(), which
// is already generic (it takes plain subject+body text, has no email-shaped
// assumption in its matching logic). The one genuine difference WhatsApp
// needs is the "UNKNOWN as a valid, expected outcome" requirement (item 17) -
// classifyEmailDeterministic() always returns a category, defaulting
// low-confidence text to GENERAL_REPLY, which is the right default for a
// reply thread but not honest for a short WhatsApp message with no
// specific-enough signal. This module maps that specific low-confidence
// default to UNKNOWN, without touching or duplicating the underlying rules.
import { classifyEmailDeterministic, type EmailCategory } from "./emailClassification";

export type WhatsAppIntent = Exclude<EmailCategory, "GENERAL_REPLY"> | "UNKNOWN";

export interface WhatsAppIntentResult {
  intent: WhatsAppIntent;
  reasons: string[];
  confidence: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Classifies an inbound WhatsApp message body into a deterministic intent, never force-classifying below the confidence threshold. */
export function classifyWhatsAppIntent(body: string): WhatsAppIntentResult {
  const result = classifyEmailDeterministic("", body);
  if (result.category === "GENERAL_REPLY" || result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { intent: "UNKNOWN", reasons: [...result.reasons, "Confidence below threshold for a specific intent - classified UNKNOWN rather than guessed."], confidence: result.confidence };
  }
  return { intent: result.category, reasons: result.reasons, confidence: result.confidence };
}
