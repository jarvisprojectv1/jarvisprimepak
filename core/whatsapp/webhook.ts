// core/whatsapp/webhook.ts - webhook signature verification + payload
// normalization for the WhatsApp Business Platform (Meta Cloud API) webhook
// (Phase 8, item 5). Kept separate from the Express route itself
// (apps/api/src/routes/webhooks.ts) so the crypto/parsing logic is unit-
// testable without spinning up a real HTTP server.
import crypto from "node:crypto";
import { log } from "../../security/logger";

/**
 * Verifies the Meta Cloud API's X-Hub-Signature-256 header: HMAC-SHA256 of
 * the RAW request body bytes, keyed by the app secret, hex-encoded and
 * prefixed "sha256=". Uses a constant-time comparison
 * (crypto.timingSafeEqual) so this check itself cannot be used as a timing
 * oracle. NEVER logs the signature header or the app secret - only whether
 * verification passed.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const providedHex = signatureHeader.slice(expectedPrefix.length);
  const expectedHex = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

export interface NormalizedInboundWhatsAppMessage {
  businessAccountId: string;
  providerMessageId: string;
  providerConversationId: string | null;
  from: string;
  to: string;
  body: string;
  attachment: { type: string; mimeType?: string; sizeBytes?: number; filename?: string } | null;
  receivedAt: string;
}

/**
 * Normalizes the Meta Cloud API's webhook event shape
 * ({ entry: [{ id, changes: [{ value: { messages, contacts, metadata } }] }] })
 * into this system's internal message shape. Malformed/unrecognized shapes
 * are simply skipped (not thrown) - a webhook handler must never 500 on a
 * shape it doesn't recognize, only decline to process what it can't parse.
 * Attachment content is NEVER fetched here - only type/size/filename
 * metadata the payload itself already carries (item 26).
 */
export function normalizeInboundWebhookPayload(payload: unknown): NormalizedInboundWhatsAppMessage[] {
  const out: NormalizedInboundWhatsAppMessage[] = [];
  if (!payload || typeof payload !== "object") return out;
  const entries = (payload as { entry?: unknown[] }).entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const businessAccountId = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : "unknown";
    const changes = (entry as { changes?: unknown[] }).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: unknown })?.value;
      if (!value || typeof value !== "object") continue;
      const messages = (value as { messages?: unknown[] }).messages;
      const metadata = (value as { metadata?: { display_phone_number?: string } }).metadata;
      if (!Array.isArray(messages)) continue;

      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const raw = m as Record<string, unknown>;
        const providerMessageId = typeof raw.id === "string" ? raw.id : null;
        const from = typeof raw.from === "string" ? raw.from : null;
        if (!providerMessageId || !from) {
          log("WARNING", "whatsapp.webhook_malformed_message", { hasId: Boolean(providerMessageId), hasFrom: Boolean(from) });
          continue;
        }
        const type = typeof raw.type === "string" ? raw.type : "unknown";
        let body = "";
        let attachment: NormalizedInboundWhatsAppMessage["attachment"] = null;
        if (type === "text" && raw.text && typeof raw.text === "object") {
          body = typeof (raw.text as { body?: unknown }).body === "string" ? (raw.text as { body: string }).body : "";
        } else if (["image", "video", "document", "audio", "sticker"].includes(type)) {
          const media = raw[type] as { mime_type?: string; filename?: string; sha256?: string } | undefined;
          attachment = { type, mimeType: media?.mime_type, filename: media?.filename };
          body = `[${type} attachment received - metadata only, content not fetched/processed]`;
        } else {
          body = `[unsupported message type: ${type}]`;
        }

        out.push({
          businessAccountId,
          providerMessageId,
          providerConversationId: null, // the Cloud API does not send a distinct conversation id on the message event itself
          from,
          to: metadata?.display_phone_number ?? "",
          body,
          attachment,
          receivedAt: typeof raw.timestamp === "string" ? new Date(Number(raw.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  return out;
}
