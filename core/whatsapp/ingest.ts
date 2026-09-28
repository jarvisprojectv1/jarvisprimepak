// core/whatsapp/ingest.ts - inbound WhatsApp message ingestion (Phase 8,
// items 5-9, 18, 22).
//
// Mirrors core/email/ingest.ts's shape and discipline exactly:
//   - Idempotent upsert-by-provider-id: Email.providerMessageId's DB unique
//     constraint (shared with email, since this is the SAME generalized
//     table - see database/schema.prisma) means processing the same
//     provider message twice never duplicates the row.
//   - Deterministic-only classification (core/business/whatsappIntent.ts) -
//     no LLM call, so no prompt-injection surface here at all.
//   - Only a durable, classification-derived FACT is written to Memory -
//     never the raw message body.
//   - The full message body IS stored in the Email row (its own reason to
//     exist), which also makes it visible to isFollowUpAllowed()'s existing
//     cross-channel "customer replied" check via the Communication row this
//     function also writes (item 22 - see recordActivity() call below; this
//     is the SAME query isFollowUpAllowed() already runs, now actually
//     populated for inbound messages on either channel).
//
// Called ONLY from the webhook route (apps/api/src/routes/webhooks.ts) after
// signature verification + task/event creation - never processes a request
// body synchronously inline in the HTTP handler itself.
import { prisma } from "../../database/client";
import { resolveConversationIdentity, resolveWhatsAppContact } from "./conversation";
import { classifyWhatsAppIntent } from "../business/whatsappIntent";
import { isOptOutMessage, suppressWhatsAppContact } from "../business/antiSpam";
import { logInjectionSignalsIfAny } from "../research/trustBoundary";
import { recordActivity } from "../crm/activity";
import { createMemory } from "../memory";
import { log } from "../../security/logger";
import type { WhatsAppMessage } from "../../tools/whatsapp/types";

export interface IngestedWhatsAppMessage {
  id: string;
  providerMessageId: string;
  isNew: boolean;
  intent: string;
  contactResolution: "RESOLVED" | "UNRESOLVED_CONTACT";
  optOut: boolean;
}

const DEDUP_LEAD_STATUSES = ["WON", "LOST"];

/** Deterministic lead-pipeline advancement (item 18) - only ever moves on EXPLICIT, high-confidence intent; ambiguous/UNKNOWN never advances anything. */
async function maybeAdvanceLeadForContact(contactId: string, intent: string): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { contactId, status: { notIn: DEDUP_LEAD_STATUSES } }, orderBy: { updatedAt: "desc" } });
  if (!lead) return;

  let nextStatus: string | null = null;
  if (intent === "SAMPLE_REQUEST") nextStatus = "SAMPLE_REQUESTED";
  else if (intent === "PRICING_REQUEST") nextStatus = "QUOTING";
  else if (intent === "COMPLAINT") nextStatus = "NURTURE"; // treated conservatively - a human should review, not autonomously push forward
  // UNSUBSCRIBE_REQUEST is handled by suppression, not a pipeline status.
  // UNKNOWN/NEW_INQUIRY/ORDER_FOLLOW_UP: ambiguous with respect to pipeline advancement - never changed here.

  if (nextStatus && nextStatus !== lead.status) {
    await prisma.lead.update({ where: { id: lead.id }, data: { status: nextStatus } });
    log("BUSINESS", "whatsapp.lead_advanced", { leadId: lead.id, from: lead.status, to: nextStatus, intent });
  }
}

export async function ingestInboundWhatsAppMessage(
  msg: WhatsAppMessage,
  context: { businessAccountId: string }
): Promise<IngestedWhatsAppMessage> {
  const identity = resolveConversationIdentity({
    businessAccountId: context.businessAccountId,
    providerConversationId: msg.providerConversationId,
    rawContactPhone: msg.from,
  });

  const contactResolution = await resolveWhatsAppContact({ rawPhone: msg.from });
  const contactId = contactResolution.outcome === "RESOLVED" ? contactResolution.contactId : null;

  const optOut = isOptOutMessage(msg.body);
  if (optOut) {
    await suppressWhatsAppContact(msg.from, "UNSUBSCRIBE", contactId ?? undefined);
    log("SECURITY", "whatsapp.opt_out_received", { from: msg.from, contactId });
  }

  const classification = classifyWhatsAppIntent(msg.body);

  // Best-effort, log-only signal scan - see trustBoundary.ts. Never blocks
  // ingestion; there is no LLM path this content reaches this phase (see
  // core/business/whatsappDraft.ts's header), so this is purely a forward-
  // looking audit signal, same honesty as email's equivalent call.
  logInjectionSignalsIfAny(msg.body, { url: `whatsapp:${msg.providerMessageId}` });

  const existing = await prisma.email.findUnique({ where: { providerMessageId: msg.providerMessageId } });
  const row = await prisma.email.upsert({
    where: { providerMessageId: msg.providerMessageId },
    update: {
      body: msg.body,
      fromAddress: msg.from,
      toAddress: msg.to,
      providerConversationId: identity.providerConversationId,
      classification: optOut ? "UNSUBSCRIBE_REQUEST" : classification.intent,
      classificationReasons: JSON.stringify(classification.reasons),
    },
    create: {
      contactId,
      direction: "inbound",
      channel: "WHATSAPP",
      body: msg.body,
      status: "RECEIVED",
      providerMessageId: msg.providerMessageId,
      providerConversationId: identity.providerConversationId,
      fromAddress: msg.from,
      toAddress: msg.to,
      classification: optOut ? "UNSUBSCRIBE_REQUEST" : classification.intent,
      classificationReasons: JSON.stringify(classification.reasons),
    },
  });

  if (!existing) {
    if (contactId) {
      // Item 22: this Communication row is what isFollowUpAllowed()'s existing
      // "customer replied since scheduling" check already queries - no change
      // needed there, this just actually populates it for WhatsApp (and,
      // incidentally, closes the same pre-existing gap for inbound email -
      // see tools/email... no, deliberately NOT touched here; email's own
      // ingestion path is Phase 7's, out of scope to silently modify beyond
      // what this phase's cross-channel requirement needs).
      await recordActivity({
        contactId,
        channel: "whatsapp",
        direction: "inbound",
        activityType: "WHATSAPP_RECEIVED",
        relatedEntityId: row.id,
        summary: optOut ? "Customer sent an opt-out request via WhatsApp." : `Inbound WhatsApp message classified as ${classification.intent}.`,
      });
      if (!optOut) await maybeAdvanceLeadForContact(contactId, classification.intent);
    }

    await createMemory({
      namespace: "CLIENT",
      key: `whatsapp:${row.id}:classification`,
      content: optOut
        ? `Inbound WhatsApp opt-out request from ${msg.from}.`
        : `Inbound WhatsApp message from ${msg.from} classified as ${classification.intent}.`,
      source: "whatsapp-ingest",
      confidence: classification.confidence,
      relatedEntity: row.id,
      metadata: { intent: classification.intent, reasons: classification.reasons, optOut },
    });
  }

  return {
    id: row.id,
    providerMessageId: row.providerMessageId!,
    isNew: !existing,
    intent: optOut ? "UNSUBSCRIBE_REQUEST" : classification.intent,
    contactResolution: contactResolution.outcome,
    optOut,
  };
}
