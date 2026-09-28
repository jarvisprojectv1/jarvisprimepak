// security/redactEmailCrm.test.ts - item AH (secret redaction), confirming
// Phase 7's new credential shapes (GMAIL_ACCESS_TOKEN) and any accidental
// logging of provider tokens/idempotency payloads are covered by the
// existing (untouched) redact() heuristic.
import { describe, it, expect } from "vitest";
import { redact } from "./redact";

describe("AH: secret redaction covers Phase 7 credential shapes", () => {
  it("redacts a GMAIL_ACCESS_TOKEN-shaped field by key", () => {
    const input = { GMAIL_ACCESS_TOKEN: "ya29.a0AfH6SMC_real_looking_token_value", other: "fine" };
    const result = redact(input) as Record<string, unknown>;
    expect(result.GMAIL_ACCESS_TOKEN).toBe("[REDACTED]");
    expect(result.other).toBe("fine");
  });

  it("redacts an Authorization header value even nested inside a logged request-shaped object", () => {
    const input = { headers: { Authorization: "Bearer ya29.a0AfH6SMC_real_looking_token_value" } };
    const result = redact(input) as { headers: Record<string, unknown> };
    expect(result.headers.Authorization).toBe("[REDACTED]");
  });

  it("never leaks a raw access token string even under an innocuous key name", () => {
    const input = { note: "using token ya29.a0AfH6SMCReallyLongOpaqueTokenValueHere1234567890" };
    const result = redact(input) as Record<string, unknown>;
    expect(String(result.note)).not.toContain("ya29.a0AfH6SMCReallyLongOpaqueTokenValueHere1234567890");
  });
});
