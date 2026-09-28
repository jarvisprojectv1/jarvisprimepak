// core/whatsapp/subscriber.ts - wires the webhook route to real ingestion
// through the existing Event Bus (Phase 8, item 5's "creates a task/event
// through the existing task/event system rather than processing
// synchronously inline"). The HTTP handler (apps/api/src/routes/webhooks.ts)
// only verifies the signature and publishes one typed "WHATSAPP.message_received"
// event per inbound message, then returns 200 - all real processing
// (contact resolution, classification, persistence, CRM activity) happens
// here, in a subscribed handler, exactly like core/events/index.ts's
// existing EVENT -> DECISION default subscriber pattern.
import { subscribe } from "../events";
import { ingestInboundWhatsAppMessage } from "./ingest";
import { log } from "../../security/logger";
import type { WhatsAppMessage } from "../../tools/whatsapp/types";

export interface WhatsAppMessageReceivedPayload {
  businessAccountId: string;
  providerMessageId: string;
  providerConversationId: string | null;
  from: string;
  to: string;
  body: string;
  receivedAt: string;
}

let registered = false;

export function registerWhatsAppSubscriber(): void {
  if (registered) return;
  subscribe("WHATSAPP.message_received", async (event) => {
    const payload = event.payload as WhatsAppMessageReceivedPayload | undefined;
    if (!payload || typeof payload.providerMessageId !== "string") {
      log("WARNING", "whatsapp.subscriber_malformed_event", { eventId: event.id });
      return;
    }
    const msg: WhatsAppMessage = {
      providerMessageId: payload.providerMessageId,
      providerConversationId: payload.providerConversationId,
      from: payload.from,
      to: payload.to,
      body: payload.body,
      attachment: null,
      receivedAt: payload.receivedAt,
    };
    try {
      await ingestInboundWhatsAppMessage(msg, { businessAccountId: payload.businessAccountId });
    } catch (err) {
      log("ERROR", "whatsapp.ingest_failed", { providerMessageId: payload.providerMessageId, error: err instanceof Error ? err.message : String(err) });
    }
  });
  registered = true;
}
