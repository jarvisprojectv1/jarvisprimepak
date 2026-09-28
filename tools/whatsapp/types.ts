// tools/whatsapp/types.ts - the WhatsApp Provider abstraction (Phase 8,
// items 3-4). Same shape/philosophy as tools/email/types.ts's EmailProvider:
// a real implementation calls the official WhatsApp Business Platform (Meta
// Cloud API) from real credentials; a mock/local test double is used for
// every automated test (no live send capability is ever exercised by the
// test suite - see mockProvider.ts).
//
// Only what a real provider genuinely supports is modeled here:
// getAccount/receiveMessages/getConversation/getMessage/sendMessage/
// createDraft/markRead. "Draft" for WhatsApp is NOT a provider-side concept
// the Cloud API exposes (unlike Gmail) - createDraft() below is therefore a
// LOCAL, non-sending operation (returns a would-be message shape without
// ever touching the provider), not a faked provider call.

export interface WhatsAppAccount {
  /** The WhatsApp Business Account id. */
  businessAccountId: string;
  /** The phone number id sends originate from. */
  phoneNumberId: string;
  /** The E.164 display phone number, if known. */
  displayPhoneNumber: string | null;
}

export interface WhatsAppMessage {
  /** The provider's own message id - the natural key for idempotent upsert (mirrors Email.providerMessageId). */
  providerMessageId: string;
  /** The provider's conversation id, when the platform assigns one. */
  providerConversationId: string | null;
  /** Sender's phone number, E.164-ish as the provider sent it (normalized separately by core/crm/dedup.ts). */
  from: string;
  to: string;
  /** Plain text body. Non-text message types (media/voice/location) surface only metadata - see `attachment`. */
  body: string;
  /** Attachment METADATA only (type/size/filename) - content is never fetched or interpreted (item 26). */
  attachment?: { type: string; mimeType?: string; sizeBytes?: number; filename?: string } | null;
  receivedAt: string; // ISO timestamp
}

export interface SendWhatsAppMessageInput {
  to: string;
  body: string;
  /** Idempotency key - the tool layer ALSO checks it locally regardless (same discipline as SendEmailInput). */
  idempotencyKey?: string;
}

export interface SendWhatsAppMessageResult {
  providerMessageId: string;
  status: "SENT";
}

export interface WhatsAppProviderError {
  code: "CONFIGURATION_REQUIRED" | "TIMEOUT" | "PROVIDER_ERROR" | "RATE_LIMITED" | "INVALID_RECIPIENT";
  message: string;
}

export function isWhatsAppProviderError<T>(value: T | WhatsAppProviderError): value is WhatsAppProviderError {
  return Boolean(value) && typeof value === "object" && "code" in (value as Record<string, unknown>);
}

export interface ReceiveMessagesOptions {
  limit?: number;
  since?: string;
}

/**
 * A WhatsApp provider. Real implementations (see metaCloudProvider.ts) read
 * credentials from env and honestly return CONFIGURATION_REQUIRED with none
 * configured - never a fabricated conversation. MockWhatsAppProvider (see
 * mockProvider.ts) is a pure in-memory double used by every automated test.
 */
export interface WhatsAppProvider {
  readonly name: string;
  isConfigured(): boolean;
  getAccount(): Promise<WhatsAppAccount | WhatsAppProviderError>;
  /** Polls/lists inbound messages available to this account (used by any non-webhook ingestion path/tests). */
  receiveMessages(options?: ReceiveMessagesOptions): Promise<WhatsAppMessage[] | WhatsAppProviderError>;
  getConversation(providerConversationId: string): Promise<WhatsAppMessage[] | WhatsAppProviderError>;
  getMessage(providerMessageId: string): Promise<WhatsAppMessage | WhatsAppProviderError | null>;
  sendMessage(input: SendWhatsAppMessageInput): Promise<SendWhatsAppMessageResult | WhatsAppProviderError>;
  /** Local-only: composes a draft message shape without sending. Never calls the provider. */
  createDraft(input: { to: string; body: string }): { to: string; body: string; draft: true };
  markRead(providerMessageId: string): Promise<{ ok: true } | WhatsAppProviderError>;
}
