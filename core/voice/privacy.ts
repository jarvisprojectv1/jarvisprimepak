// core/voice/privacy.ts - the caller-identity access-control boundary
// (Phase 9, item 19 - "genuinely new, important requirement not present in
// Phase 7/8", per the brief; treated with the same weight as the outbound
// safety pipeline).
//
// RULE: an unresolved or low-confidence caller must NEVER receive any
// CRM-data-bearing response (a quote, an order status, a customer-specific
// fact) over the phone. When identity is uncertain, the only safe response
// is a template routing to a human callback - never "let me check your
// account" followed by a guess. This is enforced as an explicit, narrow,
// testable function - not folded into the intent classifier or left as an
// implicit assumption in a prompt.
import { normalizePhone } from "../crm/dedup";
import { prisma } from "../../database/client";

export type CallerAccessLevel = "FULL" | "RESTRICTED";

export interface CallerResolution {
  outcome: "RESOLVED" | "UNRESOLVED";
  contactId: string | null;
  /** True when the matched Contact carries core/crm/dedup.ts's possibleDuplicate flag - an ambiguous match is treated as NOT confidently resolved. */
  possibleDuplicate: boolean;
  reason: string;
}

/**
 * Resolves an inbound caller's number to a Contact with the SAME "no fuzzy
 * matching" discipline core/crm/dedup.ts already applies elsewhere: an exact
 * normalizedPhone match is RESOLVED; anything else (unparseable number, no
 * match, or a match flagged possibleDuplicate) is UNRESOLVED. This function
 * NEVER creates a Contact (unlike core/whatsapp/conversation.ts's
 * resolveWhatsAppContact()) - identity resolution for the purpose of
 * deciding what to DISCLOSE must be strictly read-only and conservative;
 * contact creation (if ever wanted for an unknown caller) is a separate,
 * explicit decision made elsewhere, never implied by this check.
 */
export async function resolveCallerIdentity(rawPhone: string | null | undefined): Promise<CallerResolution> {
  if (!rawPhone) return { outcome: "UNRESOLVED", contactId: null, possibleDuplicate: false, reason: "No caller number provided." };
  const { normalized, valid, reason } = normalizePhone(rawPhone);
  if (!valid || !normalized) {
    return { outcome: "UNRESOLVED", contactId: null, possibleDuplicate: false, reason: `Caller number could not be reliably normalized: ${reason}` };
  }
  const contact = await prisma.contact.findFirst({ where: { normalizedPhone: normalized } });
  if (!contact) {
    return { outcome: "UNRESOLVED", contactId: null, possibleDuplicate: false, reason: `No existing contact matches normalized phone "${normalized}".` };
  }
  if (contact.possibleDuplicate) {
    return { outcome: "UNRESOLVED", contactId: contact.id, possibleDuplicate: true, reason: `Matched contact ${contact.id} is flagged possibleDuplicate - not treated as a confident identity match.` };
  }
  return { outcome: "RESOLVED", contactId: contact.id, possibleDuplicate: false, reason: `Matched existing contact by normalized phone "${normalized}".` };
}

/** The single access-control decision this module exists for (item 19). */
export function accessLevelFor(resolution: CallerResolution): CallerAccessLevel {
  return resolution.outcome === "RESOLVED" ? "FULL" : "RESTRICTED";
}

/**
 * The one function every CRM-data-bearing voice response path must call
 * before disclosing anything - defaults SAFE (RESTRICTED/false) on any
 * uncertainty, never on the optimistic branch. Callers should treat a
 * `false` result as: "do not read out a quote/order-status/customer fact;
 * use the safe template response instead" (see
 * SAFE_UNRESOLVED_RESPONSE_TEMPLATE below).
 */
export function canDiscloseCrmData(resolution: CallerResolution): boolean {
  return accessLevelFor(resolution) === "FULL";
}

/**
 * The deterministic, non-AI-generated template response for an unresolved/
 * low-confidence caller asking for CRM-data-bearing information (item 20's
 * "template string, doesn't need to be AI-generated" allowance, reused here
 * for the privacy-safe fallback too).
 */
export const SAFE_UNRESOLVED_RESPONSE_TEMPLATE =
  "I'm not able to confirm your account details over the phone right now. I'll have someone from our team call you back to help with that.";
