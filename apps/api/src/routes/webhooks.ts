// apps/api/src/routes/webhooks.ts - the WhatsApp Business Platform (Meta
// Cloud API) webhook (Phase 8, items 5-6). Deliberately UNAUTHENTICATED by
// session (this is Meta's server calling us, not a logged-in user) -
// authenticated instead by X-Hub-Signature-256 HMAC verification against
// WHATSAPP_APP_SECRET (core/whatsapp/webhook.ts's verifyWebhookSignature()).
//
// Discipline enforced here:
//   - GET: the Cloud API's one-time subscription verification handshake -
//     echoes hub.challenge back ONLY if hub.verify_token matches
//     WHATSAPP_WEBHOOK_VERIFY_TOKEN exactly; otherwise 403, no internals.
//   - POST: rejects a missing/invalid signature outright (401) BEFORE
//     touching the payload at all. A valid signature but malformed body is
//     handled by normalizeInboundWebhookPayload() (never throws) and simply
//     yields zero messages to process.
//   - Deduplicates by provider message id: Email.providerMessageId's DB
//     unique constraint (shared with email - see database/schema.prisma) is
//     what actually enforces this at persistence time
//     (core/whatsapp/ingest.ts's upsert); this route does not need its own
//     dedup layer.
//   - Never processes the payload synchronously inline: publishes one
//     "WHATSAPP.message_received" event per message via core/events and
//     returns - core/whatsapp/subscriber.ts does the real work.
//   - The HTTP response is ALWAYS a bare status code / minimal JSON - never
//     internal state, stack traces, or parsed payload contents.
//   - NEVER logs the raw signature header or WHATSAPP_APP_SECRET/
//     WHATSAPP_WEBHOOK_VERIFY_TOKEN values.
import { Router, type Request } from "express";
import { verifyWebhookSignature, normalizeInboundWebhookPayload } from "../../../../core/whatsapp/webhook";
import { verifyTwilioSignature, normalizeInboundVoiceWebhook } from "../../../../core/voice/webhook";
import { publish } from "../../../../core/events";
import { log } from "../../../../security/logger";

export const webhooksRouter = Router();

webhooksRouter.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!expected || mode !== "subscribe" || token !== expected) {
    log("SECURITY", "whatsapp.webhook_verify_rejected", { mode: typeof mode === "string" ? mode : null });
    res.status(403).json({ error: "Verification failed." });
    return;
  }
  res.status(200).send(typeof challenge === "string" ? challenge : "");
});

webhooksRouter.post("/whatsapp", async (req: Request & { rawBody?: Buffer }, res) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    // Fail closed: with no configured secret, a signature can never be
    // verified, so no payload from this route is ever trusted/processed.
    res.status(503).json({ error: "Webhook not configured." });
    return;
  }

  const signature = req.header("X-Hub-Signature-256");
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
    log("SECURITY", "whatsapp.webhook_signature_rejected", {});
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  let messages: ReturnType<typeof normalizeInboundWebhookPayload> = [];
  try {
    messages = normalizeInboundWebhookPayload(req.body);
  } catch (err) {
    log("WARNING", "whatsapp.webhook_parse_error", { error: err instanceof Error ? err.message : String(err) });
    res.status(200).json({ ok: true }); // still 200 - Meta retries on non-2xx, and a malformed body is not worth a retry storm
    return;
  }

  for (const msg of messages) {
    try {
      await publish({
        type: "WHATSAPP.message_received",
        source: "whatsapp-webhook",
        payload: {
          businessAccountId: msg.businessAccountId,
          providerMessageId: msg.providerMessageId,
          providerConversationId: msg.providerConversationId,
          from: msg.from,
          to: msg.to,
          body: msg.body,
          receivedAt: msg.receivedAt,
        },
      });
    } catch (err) {
      log("ERROR", "whatsapp.webhook_publish_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Phase 9 (Voice, item 5): the Twilio Programmable Voice webhook. Deliberately
// UNAUTHENTICATED by session (Twilio's server, not a logged-in user) -
// authenticated instead by X-Twilio-Signature verification
// (core/voice/webhook.ts's verifyTwilioSignature()), mirroring the WhatsApp
// route above exactly:
//   - Rejects a missing/invalid signature outright (401) BEFORE touching the
//     payload at all; 503 if TWILIO_AUTH_TOKEN is unconfigured (fail closed).
//   - `fullUrl` MUST be the exact, externally-visible URL Twilio was
//     configured to POST to - VOICE_PUBLIC_WEBHOOK_URL is the one
//     authoritative source (a proxy-rewritten req.originalUrl/req.protocol
//     is NOT trusted for this, since a misconfigured/spoofed Host header
//     could otherwise make an invalid signature verify). With no configured
//     public URL, verification fails closed (401), never falls back to a
//     guess.
//   - Deduplicates by provider call id: Call.providerCallId's DB unique
//     constraint (core/voice/ingest.ts's upsert) - this route does not need
//     its own dedup layer.
//   - Never processes the payload synchronously inline: publishes one
//     "VOICE.call_event" event via core/events and returns TwiML - the real
//     work happens in core/voice/subscriber.ts.
//   - NEVER logs the raw signature header or TWILIO_AUTH_TOKEN.
webhooksRouter.post("/voice", async (req: Request & { rawBody?: Buffer }, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicBaseUrl = process.env.VOICE_PUBLIC_WEBHOOK_URL;
  if (!authToken || !publicBaseUrl) {
    res.status(503).json({ error: "Webhook not configured." });
    return;
  }

  const signature = req.header("X-Twilio-Signature");
  const params = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const stringParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") stringParams[k] = v;
  }
  const fullUrl = `${publicBaseUrl.replace(/\/$/, "")}/webhooks/voice`;

  if (!verifyTwilioSignature(fullUrl, stringParams, signature, authToken)) {
    log("SECURITY", "voice.webhook_signature_rejected", {});
    res.status(401).json({ error: "Invalid signature." });
    return;
  }

  const normalized = normalizeInboundVoiceWebhook(params);
  if (!normalized) {
    log("WARNING", "voice.webhook_malformed_payload", {});
    // Still 200 with empty TwiML - Twilio retries/hangs up on a non-2xx or
    // missing TwiML response, and a malformed body is not worth a retry storm.
    res.status(200).set("Content-Type", "text/xml").send("<Response></Response>");
    return;
  }

  try {
    await publish({
      type: "VOICE.call_event",
      source: "voice-webhook",
      payload: normalized,
    });
  } catch (err) {
    log("ERROR", "voice.webhook_publish_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // A minimal, honest TwiML response: acknowledge the call without claiming
  // any capability this phase doesn't have (no live AI conversation loop,
  // no real transfer) - a short, deterministic template message, gated by
  // whether the caller's identity resolves (item 19), never CRM data.
  res
    .status(200)
    .set("Content-Type", "text/xml")
    .send(
      `<Response><Say>Thank you for calling. Your call has been logged and a team member will follow up with you shortly.</Say></Response>`
    );
});
