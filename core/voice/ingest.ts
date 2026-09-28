// core/voice/ingest.ts - inbound call event ingestion (Phase 9, items 5-6,
// 16-22). Mirrors core/whatsapp/ingest.ts's shape and discipline:
//   - Idempotent upsert-by-provider-id: Call.providerCallId's DB unique
//     constraint means processing the same Twilio CallSid's status-change
//     webhooks (Twilio fires one per state transition: ringing, in-progress,
//     completed, ...) never duplicates the row - each event UPDATES the same
//     Call row in place.
//   - Deterministic-only classification (core/business/voiceIntent.ts) - no
//     LLM call, so no prompt-injection surface here at all.
//   - PRIVACY (item 19): caller identity is resolved READ-ONLY via
//     core/voice/privacy.ts's resolveCallerIdentity() - this function NEVER
//     auto-creates a Contact from an inbound call (deliberately more
//     conservative than core/whatsapp/conversation.ts's
//     resolveWhatsAppContact(), which does create one - a phone call's
//     caller-ID is easier to spoof than a WhatsApp session, and the
//     consequence of over-trusting it is CRM data disclosure, not just
//     mis-filed history). An unresolved caller's Call row is still persisted
//     with `contactId: null` for later manual linking.
//   - Only a durable, classification-derived FACT is written to Memory -
//     never the raw transcript.
//
// Called from the webhook route after signature verification + event
// publish - never processes a request body synchronously inline (item 5).
import { prisma } from "../../database/client";
import type { NormalizedInboundVoiceEvent } from "./webhook";
import { resolveCallerIdentity, accessLevelFor } from "./privacy";
import { classifyVoiceIntentDeterministic } from "../business/voiceIntent";
import { isDoNotCall, suppressPhoneForCalls } from "../business/antiSpam";
import { normalizePhone } from "../crm/dedup";
import { logInjectionSignalsIfAny } from "../research/trustBoundary";
import { isTranscriptOversized } from "../business/voiceLimits";
import { recordActivity } from "../crm/activity";
import { createMemory } from "../memory";
import { log } from "../../security/logger";

const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export interface IngestedCallEvent {
  id: string;
  providerCallId: string;
  isNew: boolean;
  status: string;
  intent: string | null;
  contactResolution: "RESOLVED" | "UNRESOLVED";
  doNotCall: boolean;
}

export async function ingestInboundCallEvent(event: NormalizedInboundVoiceEvent): Promise<IngestedCallEvent> {
  const { normalized: normalizedCallerNumber } = normalizePhone(event.direction === "inbound" ? event.from : event.to);

  const identity = await resolveCallerIdentity(event.direction === "inbound" ? event.from : event.to);
  const contactId = identity.outcome === "RESOLVED" ? identity.contactId : null;
  const accessLevel = accessLevelFor(identity);

  let doNotCall = await isDoNotCall(event.direction === "inbound" ? event.from : event.to);

  let intent: string | null = null;
  let optOut = false;
  if (event.transcriptionText) {
    // Best-effort, log-only signal scan on the transcript - see
    // core/research/trustBoundary.ts. Never blocks ingestion; there is no
    // LLM path this content reaches this phase.
    logInjectionSignalsIfAny(event.transcriptionText, { url: `voice:${event.providerCallId}` });
    if (await isTranscriptOversized(event.transcriptionText)) {
      log("WARNING", "voice.transcript_oversized", { providerCallId: event.providerCallId, chars: event.transcriptionText.length });
    }

    const classification = classifyVoiceIntentDeterministic(event.transcriptionText, identity.outcome === "RESOLVED" ? "RESOLVED" : "UNRESOLVED");
    intent = classification.intent;
    optOut = classification.intent === "DO_NOT_CALL";
    if (optOut) {
      await suppressPhoneForCalls(event.direction === "inbound" ? event.from : event.to, "UNSUBSCRIBE", contactId ?? undefined);
      doNotCall = true;
      log("SECURITY", "voice.do_not_call_received", { providerCallId: event.providerCallId });
    }
  }

  const outcome = TERMINAL_STATUSES.has(event.callStatus) ? mapOutcome(event.callStatus, intent) : null;

  const existing = await prisma.call.findUnique({ where: { providerCallId: event.providerCallId } });
  const row = await prisma.call.upsert({
    where: { providerCallId: event.providerCallId },
    update: {
      status: event.callStatus,
      contactId: contactId ?? existing?.contactId ?? null,
      normalizedCallerNumber: normalizedCallerNumber ?? existing?.normalizedCallerNumber ?? null,
      callerNumber: event.direction === "inbound" ? event.from : event.to,
      transcript: event.transcriptionText ?? existing?.transcript ?? null,
      intent: intent ?? existing?.intent ?? null,
      outcome: outcome ?? existing?.outcome ?? null,
      endedAt: TERMINAL_STATUSES.has(event.callStatus) ? new Date() : existing?.endedAt ?? null,
    },
    create: {
      provider: event.provider,
      providerCallId: event.providerCallId,
      direction: event.direction,
      contactId,
      callerNumber: event.direction === "inbound" ? event.from : event.to,
      normalizedCallerNumber,
      status: event.callStatus,
      transcript: event.transcriptionText,
      intent,
      outcome,
      startedAt: new Date(),
    },
  });

  if (!existing && contactId) {
    await recordActivity({
      contactId,
      channel: "call",
      direction: event.direction,
      activityType: event.direction === "inbound" ? "CALL_INBOUND" : "CALL_OUTBOUND",
      relatedEntityId: row.id,
      summary: `${event.direction === "inbound" ? "Inbound" : "Outbound"} call (${event.callStatus}).`,
    });
  }

  if (!existing) {
    await createMemory({
      namespace: "CLIENT",
      key: `voice:${row.id}:classification`,
      content: `${event.direction === "inbound" ? "Inbound" : "Outbound"} call from ${normalizedCallerNumber ?? "an unresolved number"}${intent ? `, classified as ${intent}` : ""}. Caller access level: ${accessLevel}.`,
      source: "voice-ingest",
      confidence: identity.outcome === "RESOLVED" ? 0.9 : 0.2,
      relatedEntity: row.id,
      metadata: { intent, outcome, accessLevel, doNotCall },
    });
  }

  return {
    id: row.id,
    providerCallId: row.providerCallId!,
    isNew: !existing,
    status: row.status,
    intent,
    contactResolution: identity.outcome,
    doNotCall,
  };
}

function mapOutcome(callStatus: string, intent: string | null): string {
  if (intent === "HUMAN_AGENT_REQUEST") return "HUMAN_HANDOFF";
  if (intent === "CALLBACK_REQUEST") return "CALLBACK_SCHEDULED";
  if (callStatus === "completed") return "COMPLETED";
  if (callStatus === "no-answer") return "NO_ANSWER";
  return callStatus.toUpperCase();
}
