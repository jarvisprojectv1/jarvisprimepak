// tools/email/types.ts - the Email Provider abstraction (Phase 7, item 2).
// Same shape/philosophy as tools/web/types.ts's SearchProvider: a real
// implementation calls an external API from real credentials; a mock/local
// test double is used for every automated test (per the Production Safety
// section - no live send capability is ever exercised by the test suite).

export interface EmailMessage {
  /** The provider's own message id - the natural key for idempotent upsert (item 5). */
  providerMessageId: string;
  threadId: string | null;
  from: string;
  to: string[];
  subject: string;
  /** Plain-text body. HTML bodies are stripped to text at the provider boundary - no HTML ever reaches a prompt. */
  body: string;
  receivedAt: string; // ISO timestamp
}

export interface SendEmailInput {
  to: string[];
  subject: string;
  body: string;
  /** RFC "In-Reply-To"/thread linkage, if replying to an existing thread. */
  threadId?: string;
  /** Idempotency key (item 18) - the provider is asked to honor it when it can; the tool layer ALSO checks it locally regardless. */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  providerMessageId: string;
  status: "SENT";
}

export interface EmailProviderError {
  code: "CONFIGURATION_REQUIRED" | "TIMEOUT" | "PROVIDER_ERROR" | "RATE_LIMITED";
  message: string;
}

export function isEmailProviderError<T>(value: T | EmailProviderError): value is EmailProviderError {
  return Boolean(value) && typeof value === "object" && "code" in (value as Record<string, unknown>);
}

export interface ListMessagesOptions {
  /** Max messages to return. */
  limit?: number;
  /** Only messages received after this ISO timestamp. */
  since?: string;
}

/**
 * An email provider. Real implementations (see gmailProvider.ts) read
 * credentials from env and honestly return CONFIGURATION_REQUIRED with none
 * configured - never a fabricated inbox. MockEmailProvider (see
 * mockProvider.ts) is a pure in-memory double used by every automated test.
 */
export interface EmailProvider {
  readonly name: string;
  isConfigured(): boolean;
  listMessages(options?: ListMessagesOptions): Promise<EmailMessage[] | EmailProviderError>;
  getMessage(providerMessageId: string): Promise<EmailMessage | EmailProviderError | null>;
  sendMessage(input: SendEmailInput): Promise<SendEmailResult | EmailProviderError>;
}
