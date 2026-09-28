// core/voice/webhook.test.ts - Phase 9, item 5/39: Twilio signature
// verification + payload normalization, unit-tested without a real HTTP
// server, mirroring core/whatsapp/webhook.test.ts's shape.
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildTwilioSignedPayload, verifyTwilioSignature, normalizeInboundVoiceWebhook } from "./webhook";

const AUTH_TOKEN = "test-auth-token";
const URL = "https://myapp.example.com/webhooks/voice";

function signFor(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const payload = buildTwilioSignedPayload(url, params);
  return crypto.createHmac("sha1", token).update(payload, "utf-8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  it("accepts a correctly-computed signature", () => {
    const params = { CallSid: "CA123", From: "+15551234567", To: "+15557654321", CallStatus: "ringing" };
    const sig = signFor(URL, params);
    expect(verifyTwilioSignature(URL, params, sig, AUTH_TOKEN)).toBe(true);
  });

  it("sorts params alphabetically before signing - order of the input object must not matter", () => {
    const paramsA = { To: "+15557654321", CallSid: "CA123", From: "+15551234567" };
    const paramsB = { From: "+15551234567", CallSid: "CA123", To: "+15557654321" };
    const sig = signFor(URL, paramsA);
    expect(verifyTwilioSignature(URL, paramsB, sig, AUTH_TOKEN)).toBe(true);
  });

  it("rejects a tampered param (any single changed value invalidates the signature)", () => {
    const params = { CallSid: "CA123", From: "+15551234567" };
    const sig = signFor(URL, params);
    expect(verifyTwilioSignature(URL, { ...params, From: "+19999999999" }, sig, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a tampered URL", () => {
    const params = { CallSid: "CA123" };
    const sig = signFor(URL, params);
    expect(verifyTwilioSignature("https://attacker.example.com/webhooks/voice", params, sig, AUTH_TOKEN)).toBe(false);
  });

  it("rejects the wrong auth token entirely (a forged signature from a different secret)", () => {
    const params = { CallSid: "CA123" };
    const sig = signFor(URL, params, "wrong-token");
    expect(verifyTwilioSignature(URL, params, sig, AUTH_TOKEN)).toBe(false);
  });

  it("fails closed with a missing signature header", () => {
    expect(verifyTwilioSignature(URL, { CallSid: "CA123" }, undefined, AUTH_TOKEN)).toBe(false);
  });

  it("fails closed with no configured auth token", () => {
    const params = { CallSid: "CA123" };
    const sig = signFor(URL, params);
    expect(verifyTwilioSignature(URL, params, sig, undefined)).toBe(false);
  });

  it("rejects an empty-string signature", () => {
    expect(verifyTwilioSignature(URL, { CallSid: "CA123" }, "", AUTH_TOKEN)).toBe(false);
  });
});

describe("normalizeInboundVoiceWebhook", () => {
  it("normalizes a well-formed Twilio status-callback payload", () => {
    const result = normalizeInboundVoiceWebhook({ CallSid: "CA123", From: "+15551234567", To: "+15557654321", CallStatus: "completed", Direction: "inbound" });
    expect(result).toEqual({
      provider: "twilio",
      providerCallId: "CA123",
      callStatus: "completed",
      direction: "inbound",
      from: "+15551234567",
      to: "+15557654321",
      transcriptionText: null,
      receivedAt: expect.any(String),
    });
  });

  it("returns null for a payload missing CallSid/From/To rather than throwing", () => {
    expect(normalizeInboundVoiceWebhook({ CallStatus: "ringing" })).toBeNull();
    expect(normalizeInboundVoiceWebhook({})).toBeNull();
  });

  it("classifies an outbound-api Direction correctly", () => {
    const result = normalizeInboundVoiceWebhook({ CallSid: "CA1", From: "+1", To: "+2", CallStatus: "completed", Direction: "outbound-api" });
    expect(result?.direction).toBe("outbound");
  });

  it("carries TranscriptionText through when present", () => {
    const result = normalizeInboundVoiceWebhook({ CallSid: "CA1", From: "+1", To: "+2", CallStatus: "completed", TranscriptionText: "call me back tomorrow" });
    expect(result?.transcriptionText).toBe("call me back tomorrow");
  });
});
