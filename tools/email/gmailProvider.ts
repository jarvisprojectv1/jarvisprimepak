// tools/email/gmailProvider.ts - a real, credential-backed EmailProvider
// implementation against the Gmail REST API (Phase 7, item 2).
//
// HONESTY NOTE (same pattern as Phase 6's BraveSearchProvider): this sandbox
// has no Gmail OAuth credentials, so this implementation is genuinely
// exercised only via MockEmailProvider in tests - it is implemented
// carefully from Google's documented Gmail API v1 request/response shape,
// but UNTESTED AGAINST THE LIVE API. If the required env vars are unset,
// every method honestly returns CONFIGURATION_REQUIRED - never a fabricated
// inbox or a fake "sent" result.
//
// Credentials (documented in .env.example): GMAIL_ACCESS_TOKEN (a valid
// OAuth2 access token for the mailbox - token refresh is intentionally out
// of scope for this phase, same "narrow, honest slice" choice Phase 6 made
// for its search provider) and GMAIL_USER_EMAIL (the mailbox address, used
// as the Gmail API's "me" identity and as the From header).
//
// Never logs the access token - it is read once from env and used only in
// the Authorization header of outgoing HTTPS requests; security/redact.ts's
// SECRET_KEY_PATTERN also matches "token"/"authorization" generically, so
// even an accidental log of a request-shaped object would redact it.
import { log } from "../../security/logger";
import type {
  EmailMessage,
  EmailProvider,
  EmailProviderError,
  ListMessagesOptions,
  SendEmailInput,
  SendEmailResult,
} from "./types";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 15_000;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

/** Extracts a header value from a Gmail API message resource's payload.headers array. */
function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Best-effort plain-text extraction from a Gmail message payload (walks multipart, prefers text/plain). */
function extractPlainText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
  if (p.mimeType === "text/plain" && p.body?.data) {
    try {
      return base64UrlDecode(p.body.data);
    } catch {
      return "";
    }
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  // Fall back to any body data present (e.g. text/html) - callers treat this
  // as untrusted text regardless, so a raw HTML fallback is acceptable data,
  // never executed/rendered.
  if (p.body?.data) {
    try {
      return base64UrlDecode(p.body.data);
    } catch {
      return "";
    }
  }
  return "";
}

export class GmailProvider implements EmailProvider {
  readonly name = "gmail";

  private accessToken(): string | undefined {
    return process.env.GMAIL_ACCESS_TOKEN;
  }

  private userEmail(): string | undefined {
    return process.env.GMAIL_USER_EMAIL;
  }

  isConfigured(): boolean {
    return Boolean(this.accessToken() && this.userEmail());
  }

  private configRequired(): EmailProviderError {
    return {
      code: "CONFIGURATION_REQUIRED",
      message:
        "CONFIGURATION_REQUIRED: GMAIL_ACCESS_TOKEN and GMAIL_USER_EMAIL must be set (see .env.example) to use the Gmail provider.",
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${GMAIL_API_BASE}${path}`, {
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

  async listMessages(options?: ListMessagesOptions): Promise<EmailMessage[] | EmailProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const maxResults = Math.min(Math.max(1, options?.limit ?? 10), 50);
      const query = options?.since ? `after:${Math.floor(new Date(options.since).getTime() / 1000)}` : "";
      const listRes = await this.request(`/messages?maxResults=${maxResults}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
      if (!listRes.ok) {
        return { code: "PROVIDER_ERROR", message: `Gmail API list error: HTTP ${listRes.status}` };
      }
      const listBody = (await listRes.json()) as { messages?: Array<{ id: string }> };
      const ids = listBody.messages ?? [];
      const messages: EmailMessage[] = [];
      for (const { id } of ids) {
        const one = await this.getMessage(id);
        if (one && !("code" in one)) messages.push(one);
      }
      return messages;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { code: "TIMEOUT", message: "Gmail API request timed out." };
      }
      log("ERROR", "email.gmail_list_failed", { error: err instanceof Error ? err.message : String(err) });
      return { code: "PROVIDER_ERROR", message: "Gmail API request failed." };
    }
  }

  async getMessage(providerMessageId: string): Promise<EmailMessage | EmailProviderError | null> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const res = await this.request(`/messages/${providerMessageId}?format=full`);
      if (res.status === 404) return null;
      if (!res.ok) {
        return { code: "PROVIDER_ERROR", message: `Gmail API get error: HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        id: string;
        threadId?: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }>; parts?: unknown[]; body?: { data?: string } };
      };
      const headers = body.payload?.headers;
      return {
        providerMessageId: body.id,
        threadId: body.threadId ?? null,
        from: headerValue(headers, "From"),
        to: headerValue(headers, "To").split(",").map((s) => s.trim()).filter(Boolean),
        subject: headerValue(headers, "Subject"),
        body: extractPlainText(body.payload),
        receivedAt: body.internalDate ? new Date(Number(body.internalDate)).toISOString() : new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { code: "TIMEOUT", message: "Gmail API request timed out." };
      }
      log("ERROR", "email.gmail_get_failed", { error: err instanceof Error ? err.message : String(err) });
      return { code: "PROVIDER_ERROR", message: "Gmail API request failed." };
    }
  }

  async sendMessage(input: SendEmailInput): Promise<SendEmailResult | EmailProviderError> {
    if (!this.isConfigured()) return this.configRequired();
    try {
      const raw = [
        `From: ${this.userEmail()}`,
        `To: ${input.to.join(", ")}`,
        `Subject: ${input.subject}`,
        input.threadId ? `In-Reply-To: ${input.threadId}` : null,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        input.body,
      ]
        .filter((line) => line !== null)
        .join("\r\n");

      const res = await this.request(`/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: base64UrlEncode(raw), threadId: input.threadId }),
      });
      if (!res.ok) {
        return { code: "PROVIDER_ERROR", message: `Gmail API send error: HTTP ${res.status}` };
      }
      const body = (await res.json()) as { id: string };
      return { providerMessageId: body.id, status: "SENT" };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { code: "TIMEOUT", message: "Gmail API request timed out." };
      }
      log("ERROR", "email.gmail_send_failed", { error: err instanceof Error ? err.message : String(err) });
      return { code: "PROVIDER_ERROR", message: "Gmail API request failed." };
    }
  }
}

export function createDefaultEmailProvider(): EmailProvider {
  return new GmailProvider();
}
