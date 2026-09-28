// core/voice/subscriber.ts - wires the voice webhook route to real ingestion
// through the existing Event Bus (Phase 9, item 5's "creates a task/event
// through the existing event system rather than processing synchronously
// inline"). Mirrors core/whatsapp/subscriber.ts exactly: the HTTP handler
// only verifies the signature and publishes one typed "VOICE.call_event"
// event, then returns 200 - all real processing (identity resolution,
// classification, persistence, CRM activity) happens here.
import { subscribe } from "../events";
import { ingestInboundCallEvent } from "./ingest";
import { log } from "../../security/logger";
import type { NormalizedInboundVoiceEvent } from "./webhook";

let registered = false;

export function registerVoiceSubscriber(): void {
  if (registered) return;
  subscribe("VOICE.call_event", async (event) => {
    const payload = event.payload as NormalizedInboundVoiceEvent | undefined;
    if (!payload || typeof payload.providerCallId !== "string") {
      log("WARNING", "voice.subscriber_malformed_event", { eventId: event.id });
      return;
    }
    try {
      await ingestInboundCallEvent(payload);
    } catch (err) {
      log("ERROR", "voice.ingest_failed", { providerCallId: payload.providerCallId, error: err instanceof Error ? err.message : String(err) });
    }
  });
  registered = true;
}
