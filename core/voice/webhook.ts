// core/voice/webhook.ts - Twilio Programmable Voice webhook signature
// verification + payload normalization (Phase 9, item 5). Kept separate from
// the Express route (apps/api/src/routes/webhooks.ts) so the crypto/parsing
// logic is unit-testable without spinning up a real HTTP server - mirrors
// core/whatsapp/webhook.ts's split exactly.
//
// Twilio's request-validation algorithm (documented at
// https://www.twilio.com/docs/usage/security#validating-requests, implemented
// here per that spec, not guessed):
//   1. Take the full URL Twilio requested (scheme + host + path + query
//      string, EXACTLY as configured in the Twilio console/TwiML - this must
//      be the externally-visible URL, not req.originalUrl behind a proxy).
//   2. For a POST request (Twilio always POSTs voice webhooks as
//      application/x-www-form-urlencoded), sort the POST parameters by key
//      (byte/alphabetical order) and append each "key"+"value" pair (no
//      delimiter between key and value, no delimiter between pairs) directly
//      onto the end of the URL string.
//   3. HMAC-SHA1 the resulting string, keyed by the Twilio Auth Token.
//   4. Base64-encode the digest.
//   5. Compare (constant-time) to the X-Twilio-Signature header.
// NEVER logs the signature header or the auth token - only whether
// verification passed, exactly like core/whatsapp/webhook.ts's
// verifyWebhookSignature().
import crypto from "node:crypto";

/**
 * Builds the exact string Twilio signs: url + sorted "key"+"value" pairs of
 * every POST param, concatenated with no delimiters (per the algorithm
 * above). `params` should be the parsed application/x-www-form-urlencoded
 * body - every value must be a plain string (Twilio's own params are always
 * single-valued).
 */
export function buildTwilioSignedPayload(fullUrl: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let payload = fullUrl;
  for (const key of sortedKeys) {
    payload += key + params[key];
  }
  return payload;
}

/**
 * Verifies Twilio's X-Twilio-Signature header. `fullUrl` MUST be the exact,
 * externally-visible URL Twilio was configured to POST to (including query
 * string) - the caller (the Express route) is responsible for constructing
 * this correctly (e.g. from a configured public base URL, not a
 * proxy-rewritten req.originalUrl), since a mismatched URL here fails
 * verification even for a genuine Twilio request (fail closed, not fail
 * open, on a misconfiguration).
 */
export function verifyTwilioSignature(fullUrl: string, params: Record<string, string>, signatureHeader: string | undefined, authToken: string | undefined): boolean {
  if (!signatureHeader || !authToken) return false;
  const payload = buildTwilioSignedPayload(fullUrl, params);
  const expectedB64 = crypto.createHmac("sha1", authToken).update(payload, "utf-8").digest("base64");

  const provided = Buffer.from(signatureHeader);
  const expected = Buffer.from(expectedB64);
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

export interface NormalizedInboundVoiceEvent {
  provider: "twilio";
  providerCallId: string;
  callStatus: string; // Twilio's CallStatus: queued | ringing | in-progress | completed | busy | failed | no-answer | canceled
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  /** Twilio's own eventual RecordingUrl/TranscriptionText, when this event carries one - never fetched/interpreted here, metadata only. */
  transcriptionText: string | null;
  receivedAt: string;
}

/**
 * Normalizes a Twilio voice webhook's application/x-www-form-urlencoded body
 * (already parsed into a plain object by Express) into this system's
 * internal shape. Malformed/unrecognized payloads are simply skipped (return
 * null), never thrown - a webhook handler must never 500 on a shape it
 * doesn't recognize, only decline to process what it can't parse (same
 * discipline as core/whatsapp/webhook.ts's normalizeInboundWebhookPayload()).
 */
export function normalizeInboundVoiceWebhook(params: Record<string, unknown>): NormalizedInboundVoiceEvent | null {
  const callSid = typeof params.CallSid === "string" ? params.CallSid : null;
  const from = typeof params.From === "string" ? params.From : null;
  const to = typeof params.To === "string" ? params.To : null;
  if (!callSid || !from || !to) return null;

  const callStatus = typeof params.CallStatus === "string" ? params.CallStatus : "unknown";
  const directionRaw = typeof params.Direction === "string" ? params.Direction : "";
  const direction: "inbound" | "outbound" = directionRaw.startsWith("outbound") ? "outbound" : "inbound";
  const transcriptionText = typeof params.TranscriptionText === "string" ? params.TranscriptionText : null;

  return {
    provider: "twilio",
    providerCallId: callSid,
    callStatus,
    direction,
    from,
    to,
    transcriptionText,
    receivedAt: new Date().toISOString(),
  };
}
