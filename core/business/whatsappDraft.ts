// core/business/whatsappDraft.ts - WhatsApp reply drafting (Phase 8, item
// 16).
//
// Deliberately NOT a second draft generator: this is a thin adapter over
// core/business/emailDraft.ts's generateDraft()/validateDraftGrounding() -
// the SAME deterministic, template-based, configured-facts-only generator
// email drafting already uses (per the brief's explicit instruction to
// START with deterministic templates, matching Phase 7's own precedent).
// The only WhatsApp-specific difference is shape: a WhatsApp message has no
// subject line, so this drops it and folds the (short) greeting into a
// single message body suitable for a chat bubble rather than an email.
//
// No AI-assisted drafting is implemented this phase - see
// docs/PHASE8_WHATSAPP.md's REAL/CONFIGURATION_REQUIRED/NOT_IMPLEMENTED
// table. If one is added later, it MUST go through the exact Phase 6.1
// pattern (core/ai/costControl.ts, the four-zone trust-boundary prompt via
// core/research/trustBoundary.wrapExternalWhatsAppContent(), grounding
// validation) - never a second, ungoverned LLM call path.
import { generateDraft, validateDraftGrounding, type DraftContext, type GroundingCheckResult } from "./emailDraft";

export interface WhatsAppDraftResult {
  body: string;
  citedFacts: string[];
  placeholders: string[];
}

export function generateWhatsAppDraft(ctx: DraftContext): WhatsAppDraftResult {
  const { body, citedFacts, placeholders } = generateDraft(ctx);
  return { body, citedFacts, placeholders };
}

export function validateWhatsAppDraftGrounding(body: string, citedFacts: string[]): GroundingCheckResult {
  return validateDraftGrounding(body, citedFacts);
}
