// tools/email/mockProvider.ts - a pure in-memory EmailProvider test double.
// NEVER imported by production wiring (tools/index.ts) - only by tests and
// by anything explicitly constructed with `new MockEmailProvider()`. Per the
// Production Safety non-negotiable, this is the ONLY provider the automated
// test suite ever exercises a "send" against - there is no live send
// capability anywhere in `npm test`.
import type {
  EmailMessage,
  EmailProvider,
  EmailProviderError,
  ListMessagesOptions,
  SendEmailInput,
  SendEmailResult,
} from "./types";

let counter = 0;

export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  private inbox: EmailMessage[] = [];
  private sent: Array<SendEmailInput & { providerMessageId: string }> = [];
  private configured = true;
  private timeoutNext = false;
  private failNextSends = 0;

  isConfigured(): boolean {
    return this.configured;
  }

  /** Test helper: simulate an unconfigured provider (item B). */
  setConfigured(value: boolean): void {
    this.configured = value;
  }

  /** Test helper: seed an inbound message (item C). */
  seedInboundMessage(msg: Partial<EmailMessage> & { subject: string; body: string; from: string }): EmailMessage {
    const full: EmailMessage = {
      providerMessageId: msg.providerMessageId ?? `mock-msg-${++counter}`,
      threadId: msg.threadId ?? null,
      from: msg.from,
      to: msg.to ?? ["sales@primepakpackages.example"],
      subject: msg.subject,
      body: msg.body,
      receivedAt: msg.receivedAt ?? new Date().toISOString(),
    };
    this.inbox.push(full);
    return full;
  }

  /** Test helper: simulate a provider-level timeout on the NEXT call only (item V). */
  simulateTimeoutOnce(): void {
    this.timeoutNext = true;
  }

  /** Test helper: simulate N consecutive send failures, then succeed (item W - retry). */
  simulateSendFailures(n: number): void {
    this.failNextSends = n;
  }

  async listMessages(options?: ListMessagesOptions): Promise<EmailMessage[] | EmailProviderError> {
    if (!this.configured) {
      return { code: "CONFIGURATION_REQUIRED", message: "Mock provider explicitly unconfigured for this test." };
    }
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

  async getMessage(providerMessageId: string): Promise<EmailMessage | EmailProviderError | null> {
    if (!this.configured) {
      return { code: "CONFIGURATION_REQUIRED", message: "Mock provider explicitly unconfigured for this test." };
    }
    return this.inbox.find((m) => m.providerMessageId === providerMessageId) ?? null;
  }

  async sendMessage(input: SendEmailInput): Promise<SendEmailResult | EmailProviderError> {
    if (!this.configured) {
      return { code: "CONFIGURATION_REQUIRED", message: "Mock provider explicitly unconfigured for this test." };
    }
    if (this.timeoutNext) {
      this.timeoutNext = false;
      return { code: "TIMEOUT", message: "Simulated provider timeout." };
    }
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      return { code: "PROVIDER_ERROR", message: "Simulated transient provider failure." };
    }
    const providerMessageId = `mock-sent-${++counter}`;
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId, status: "SENT" };
  }

  /** Test helper: read what was actually "sent" through this provider. */
  getSentMessages(): Array<SendEmailInput & { providerMessageId: string }> {
    return [...this.sent];
  }
}
