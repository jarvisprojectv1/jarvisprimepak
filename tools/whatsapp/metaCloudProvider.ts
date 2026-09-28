// tools/whatsapp/metaCloudProvider.ts - a real, credential-backed
// WhatsAppProvider implementation against the official WhatsApp Business
// Platform (Meta Cloud API) - the legitimate, ToS-compliant business API.
// NOT WhatsApp Web scraping, NOT any unofficial automation library.
//
// HONESTY NOTE (same pattern as GmailProvider/BraveSearchProvider): this
// sandbox has no Meta Cloud API credentials, so this implementation is
// genuinely exercised only via MockWhatsAppProvider in tests - it is
// implemented carefully from Meta's documented Cloud API v19+ request/
// response shape, but UNTESTED AGAINST THE LIVE API. If the required env
// vars are unset, every method honestly returns CONFIGURATION_REQUIRED -
// never a fabricated conversation or a fake "sent" result.
//
// Credentials (documented in .env.example): WHATSAPP_ACCESS_TOKEN (a System
// User or long-lived access token for the WhatsApp Business app),
// WHATSAPP_PHONE_NUMBER_ID (the phone number id messages are sent from),
// WHATSAPP_BUSINESS_ACCOUNT_ID (the WABA id), WHATSAPP_WEBHOOK_VERIFY_TOKEN
// (used only by the webhook GET verification handshake, not by this
// provider directly - see apps/api/src/routes/webhooks.ts) and
// WHATSAPP_APP_SECRET (used only for X-Hub-Signature-256 HMAC verification,
// also not by this provider directly).
//
// Note: the Cloud API has no "list inbox" endpoint - all inbound delivery is
// webhook-push, not poll. receiveMessages()/getConversation() here read from
// the LOCAL persisted Email-table rows (channel "WHATSAPP") the webhook
// ingestion pipeline already wrote, exactly mirroring what a provider-level
// "list" would return, without inventing a provider capability that doesn't
// exist. This keeps the WhatsAppProvider interface uniform for callers/tests
// without claiming a Graph API call that Meta does not offer.
//
// Never logs the access token/app secret - read once from env, used only in
// request headers; security/redact.ts's generic secret-key pattern also
// redacts any accidental log of a request-shaped object.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import type {
  ReceiveMessagesOptions,
  SendWhatsAppMessageInput,
  SendWhatsAppMessageResult,
  WhatsAppAccount,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppProviderError,
} from "./types";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const REQUEST_TIMEOUT_MS = 15_000;

function rowToMessage(row: {
  providerMessageId: string | null;
  providerConversationId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  body: string | null;
  createdAt: Date;
}): WhatsAppMessage {
  return {
    providerMessageId: row.providerMessageId ?? "",
    providerConversationId: row.providerConversationId,
    from: row.fromAddress ?? "",
    to: row.toAddress ?? "",
    body: row.body ?? "",
    attachment: null,
    receivedAt: row.createdAt.toISOString(),
  };
}

export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta-cloud";

  private accessToken(): string | undefined {
    return process.env.WHATSAPP_ACCESS_TOKEN;
  }
  private phoneNumberId(): string | undefined {
    return process.env.WHATSAPP_PHONE_NUMBER_ID;
  }
  private businessAccountId(): string | undefined {
    return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  }

  isConfigured(): boolean {
    return Boolean(this.accessToken() && this.phoneNumberId() && this.businessAccountId());
  }

  private configRequired(): WhatsAppProviderError {
    return {
      code: "CONFIGURATION_REQUIRED",
      message:
        "CONFIGURATION_REQUIRED: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_BUSINESS_ACCOUNT_ID must be set (see .env.example) to use the WhatsApp Business Platform (Meta Cloud API) provider.",
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${GRAPH_API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${this.accessToken()}`,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAccount(): Promise<WhatsAppAccount | WhatsAppProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const res = await this.request(`/${this.phoneNumberId()}?fields=display_phone_number,verified_name`);
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Meta Cloud API account lookup error: HTTP ${res.status}` };
      const body = (await res.json()) as { display_phone_number?: string };
      return {
        businessAccountId: this.businessAccountId()!,
        phoneNumberId: this.phoneNumberId()!,
        displayPhoneNumber: body.display_phone_number ?? null,
      };
    } catch (err) {
      return this.mapError(err, "account lookup");
    }
  }

  // No provider-level "list inbox" exists for the Cloud API - see file
  // header. These two read from the local, webhook-ingested Email table
  // (channel "WHATSAPP") so callers get a uniform shape without a fabricated
  // provider capability.
  async receiveMessages(options?: ReceiveMessagesOptions): Promise<WhatsAppMessage[] | WhatsAppProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    const rows = await prisma.email.findMany({
      where: { channel: "WHATSAPP", direction: "inbound", createdAt: options?.since ? { gte: new Date(options.since) } : undefined },
      orderBy: { createdAt: "desc" },
      take: options?.limit ?? 20,
    });
    return rows.map(rowToMessage);
  }

  async getConversation(providerConversationId: string): Promise<WhatsAppMessage[] | WhatsAppProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    const rows = await prisma.email.findMany({ where: { channel: "WHATSAPP", providerConversationId }, orderBy: { createdAt: "asc" } });
    return rows.map(rowToMessage);
  }

  async getMessage(providerMessageId: string): Promise<WhatsAppMessage | WhatsAppProviderError | null> {
    if (!this.isConfigured()) return this.configRequired();
    const row = await prisma.email.findUnique({ where: { providerMessageId } });
    if (!row || row.channel !== "WHATSAPP") return null;
    return rowToMessage(row);
  }

  async sendMessage(input: SendWhatsAppMessageInput): Promise<SendWhatsAppMessageResult | WhatsAppProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const res = await this.request(`/${this.phoneNumberId()}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.to,
          type: "text",
          text: { body: input.body },
        }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          return { code: "INVALID_RECIPIENT", message: body?.error?.message ?? `Meta Cloud API rejected the recipient: HTTP ${res.status}` };
        }
        if (res.status === 429) return { code: "RATE_LIMITED", message: "Meta Cloud API rate limit reached." };
        return { code: "PROVIDER_ERROR", message: `Meta Cloud API send error: HTTP ${res.status}` };
      }
      const body = (await res.json()) as { messages?: Array<{ id: string }> };
      const providerMessageId = body.messages?.[0]?.id;
      if (!providerMessageId) return { code: "PROVIDER_ERROR", message: "Meta Cloud API send response had no message id." };
      return { providerMessageId, status: "SENT" };
    } catch (err) {
      return this.mapError(err, "send");
    }
  }

  createDraft(input: { to: string; body: string }): { to: string; body: string; draft: true } {
    // Local-only, never calls the provider - the Cloud API has no draft concept.
    return { ...input, draft: true };
  }

  async markRead(providerMessageId: string): Promise<{ ok: true } | WhatsAppProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const res = await this.request(`/${this.phoneNumberId()}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: providerMessageId }),
      });
      if (!res.ok) return { code: "PROVIDER_ERROR", message: `Meta Cloud API mark-read error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return this.mapError(err, "mark-read");
    }
  }

  private mapError(err: unknown, op: string): WhatsAppProviderError {
    if (err instanceof Error && err.name === "AbortError") {
      return { code: "TIMEOUT", message: `Meta Cloud API ${op} request timed out.` };
    }
    log("ERROR", "whatsapp.meta_cloud_request_failed", { op, error: err instanceof Error ? err.message : String(err) });
    return { code: "PROVIDER_ERROR", message: `Meta Cloud API ${op} request failed.` };
  }
}

export function createDefaultWhatsAppProvider(): WhatsAppProvider {
  return new MetaCloudWhatsAppProvider();
}
