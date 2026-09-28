// core/whatsapp/conversation.ts - deterministic conversation identity +
// contact resolution (Phase 8, items 7-8).
//
// Conversation identity: derived from (WhatsApp business account +
// provider conversation/thread id + contact phone) - never guessed. Where
// the provider gives no conversation id (not every inbound webhook event
// carries one), identity falls back to (businessAccountId + normalized
// contact phone), which is still deterministic and unambiguous for a 1:1
// WhatsApp chat (there is no group-chat concept implemented this phase -
// see docs/PHASE8_WHATSAPP.md's NOT_IMPLEMENTED list).
//
// Contact resolution preference order (per the brief): provider contact id
// (the Cloud API does not expose a stable contact id distinct from the
// phone number itself, so this tier is a no-op in practice for this
// provider) -> normalized phone -> existing CRM mapping. Below
// "insufficient confidence" threshold, this returns an UNRESOLVED_CONTACT
// resolution rather than guessing - mirrors the "no fuzzy email matching"
// discipline core/crm/dedup.ts already has for email.
import { findOrCreateContactByPhone, normalizePhone } from "../crm/dedup";
import { log } from "../../security/logger";

export interface ConversationIdentity {
  businessAccountId: string;
  /** The provider's own conversation id, if the event carried one. */
  providerConversationId: string | null;
  /** The deterministic, stable key this system uses to group messages - see file header. */
  conversationKey: string;
  normalizedContactPhone: string | null;
}

export function resolveConversationIdentity(input: {
  businessAccountId: string;
  providerConversationId?: string | null;
  rawContactPhone: string;
}): ConversationIdentity {
  const { normalized } = normalizePhone(input.rawContactPhone);
  const conversationKey = input.providerConversationId
    ? `${input.businessAccountId}:conv:${input.providerConversationId}`
    : `${input.businessAccountId}:phone:${normalized ?? input.rawContactPhone}`;
  return {
    businessAccountId: input.businessAccountId,
    providerConversationId: input.providerConversationId ?? null,
    conversationKey,
    normalizedContactPhone: normalized,
  };
}

export type ContactResolutionResult =
  | { outcome: "RESOLVED"; contactId: string; isNew: boolean; matchReason: string }
  | { outcome: "UNRESOLVED_CONTACT"; reason: string };

/**
 * Resolves (or creates) the Contact a given inbound WhatsApp message belongs
 * to. Never guess-attaches to the wrong contact: an unparseable phone number
 * returns UNRESOLVED_CONTACT, which the caller must route to a human-review
 * state (see core/whatsapp/ingest.ts) rather than silently dropping the
 * message or attaching it to an arbitrary contact.
 */
export async function resolveWhatsAppContact(input: { rawPhone: string; displayName?: string | null }): Promise<ContactResolutionResult> {
  const [firstName, ...rest] = (input.displayName ?? "WhatsApp Contact").trim().split(/\s+/);
  const resolution = await findOrCreateContactByPhone({
    firstName: firstName || "WhatsApp Contact",
    lastName: rest.length ? rest.join(" ") : null,
    rawPhone: input.rawPhone,
  });
  if (resolution.outcome === "UNRESOLVED") {
    log("SECURITY", "whatsapp.contact_unresolved", { reason: resolution.reason });
    return { outcome: "UNRESOLVED_CONTACT", reason: resolution.reason };
  }
  return { outcome: "RESOLVED", contactId: resolution.record.id, isNew: resolution.isNew, matchReason: resolution.matchReason };
}
