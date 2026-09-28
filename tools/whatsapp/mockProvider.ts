// tools/whatsapp/mockProvider.ts - a pure in-memory WhatsAppProvider test
// double. NEVER imported by production wiring (tools/index.ts) - only by
// tests and by anything explicitly constructed with `new
// MockWhatsAppProvider()`. Per the Production Safety non-negotiable, this is
// the ONLY provider the automated test suite ever exercises a "send"
// against - there is no live WhatsApp send capability anywhere in `npm test`.
import type {
  ReceiveMessagesOptions,
  SendWhatsAppMessageInput,
  SendWhatsAppMessageResult,
  WhatsAppAccount,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppProviderError,
} from "./types";

let counter = 0;

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = "mock";
  private inbox: WhatsAppMessage[] = [];
  private sent: Array<SendWhatsAppMessageInput & { providerMessageId: string }> = [];
  private configured = true;
  private timeoutNext = false;
  private failNextSends = 0;
  private invalidRecipients = new Set<string>();

  isConfigured(): boolean {
    return this.configured;
  }

  /** Test helper: simulate an unconfigured provider. */
  setConfigured(value: boolean): void {
    this.configured = value;
  }

  /** Test helper: seed an inbound message. */
  seedInboundMessage(msg: Partial<WhatsAppMessage> & { from: string; body: string }): WhatsAppMessage {
    const full: WhatsAppMessage = {
      providerMessageId: msg.providerMessageId ?? `mock-wa-msg-${++counter}`,
      providerConversationId: msg.providerConversationId ?? `mock-wa-conv-${msg.from}`,
      from: msg.from,
      to: msg.to ?? "+920000000000",
      body: msg.body,
      attachment: msg.attachment ?? null,
      receivedAt: msg.receivedAt ?? new Date().toISOString(),
    };
    this.inbox.push(full);
    return full;
  }

  /** Test helper: simulate a provider-level timeout on the NEXT call only. */
  simulateTimeoutOnce(): void {
    this.timeoutNext = true;
  }

  /** Test helper: simulate N consecutive send failures, then succeed. */
  simulateSendFailures(n: number): void {
    this.failNextSends = n;
  }

  /** Test helper: make the next send to this exact recipient fail as INVALID_RECIPIENT. */
  markInvalidRecipient(to: string): void {
    this.invalidRecipients.add(to);
  }

  async getAccount(): Promise<WhatsAppAccount | WhatsAppProviderError> {
    if (!this.configured) return this.configRequired();
    return { businessAccountId: "mock-waba-1", phoneNumberId: "mock-phone-1", displayPhoneNumber: "+920000000000" };
  }

  async receiveMessages(options?: ReceiveMessagesOptions): Promise<WhatsAppMessage[] | WhatsAppProviderError> {
    if (!this.configured) return this.configRequired();
    if (this.timeoutNext) {
      this.timeoutNext = false;
      return { code: "TIMEOUT", message: "Simulated provider timeout." };
    }
    let messages = [...this.inbox];
    if (options?.since) {
      const since = new Date(options.since).getTime();
      messages = messages.filter((m) => new Date(m.receivedAt).getTime() >= since);
    }
    if (options?.limit) messages = messages.slice(0, options.limit);
    return messages;
  }

  async getConversation(providerConversationId: string): Promise<WhatsAppMessage[] | WhatsAppProviderError> {
    if (!this.configured) return this.configRequired();
    return this.inbox.filter((m) => m.providerConversationId === providerConversationId);
  }

  async getMessage(providerMessageId: string): Promise<WhatsAppMessage | WhatsAppProviderError | null> {
    if (!this.configured) return this.configRequired();
    return this.inbox.find((m) => m.providerMessageId === providerMessageId) ?? null;
  }

  async sendMessage(input: SendWhatsAppMessageInput): Promise<SendWhatsAppMessageResult | WhatsAppProviderError> {
    if (!this.configured) return this.configRequired();
    if (this.timeoutNext) {
      this.timeoutNext = false;
      return { code: "TIMEOUT", message: "Simulated provider timeout." };
    }
    if (this.invalidRecipients.has(input.to)) {
      this.invalidRecipients.delete(input.to);
      return { code: "INVALID_RECIPIENT", message: `Simulated invalid recipient: ${input.to}` };
    }
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      return { code: "PROVIDER_ERROR", message: "Simulated transient provider failure." };
    }
    const providerMessageId = `mock-wa-sent-${++counter}`;
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId, status: "SENT" };
  }

  createDraft(input: { to: string; body: string }): { to: string; body: string; draft: true } {
    return { ...input, draft: true };
  }

  async markRead(providerMessageId: string): Promise<{ ok: true } | WhatsAppProviderError> {
    if (!this.configured) return this.configRequired();
    return { ok: true };
  }

  /** Test helper: read what was actually "sent" through this provider. */
  getSentMessages(): Array<SendWhatsAppMessageInput & { providerMessageId: string }> {
    return [...this.sent];
  }

  private configRequired(): WhatsAppProviderError {
    return { code: "CONFIGURATION_REQUIRED", message: "Mock provider explicitly unconfigured for this test." };
  }
}
