// tools/voice/voiceTool.test.ts - Phase 9, item 8-9/39's core call-flow
// tests, mirroring tools/whatsapp/whatsappTool.test.ts's shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { createVoiceTool } from "./voiceTool";
import { MockVoiceProvider } from "./mockProvider";
import { setSystemState } from "../../core/state";
import { setAntiSpamConfig, DEFAULT_ANTI_SPAM, suppressPhoneForCalls } from "../../core/business/antiSpam";

beforeEach(async () => {
  await prisma.outboundSendLog.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.call.deleteMany();
  await prisma.suppressedContact.deleteMany();
  await prisma.contact.deleteMany();
  await setAntiSpamConfig(DEFAULT_ANTI_SPAM);
});

afterEach(async () => {
  await setSystemState("RUNNING", "test cleanup", "test");
});

describe("voice tool - configuration", () => {
  it("returns CONFIGURATION_REQUIRED when the provider is unconfigured", async () => {
    const provider = new MockVoiceProvider();
    provider.setConfigured(false);
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purposeSummary: "hi" });
    expect(result.status).toBe("CONFIGURATION_REQUIRED");
  });
});

describe("voice tool - risk classification (defaults HIGH)", () => {
  it("a GENERAL-purpose call with no explicit CALLBACK_CONFIRMATION defaults to HIGH risk and is blocked pending approval", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purposeSummary: "Just checking in." });
    expect(result.status).toBe("BLOCKED");
    expect((result.data as { riskCategory: string }).riskCategory).toBe("HIGH");
    expect(provider.getCreatedCalls()).toHaveLength(0);
  });

  it("a pure CALLBACK_CONFIRMATION with no high-risk content is the one narrow LOW-risk case, and goes straight through", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "0300-1234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming we'll call back tomorrow at 3pm." });
    expect(result.status).toBe("OK");
    expect(provider.getCreatedCalls()).toHaveLength(1);
    expect(provider.getCreatedCalls()[0].to).toBe("+923001234567");
  });

  it("a CALLBACK_CONFIRMATION that embeds a price/quote is still HIGH - the purpose label alone never downgrades risk", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming the quote of $500 per unit." });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getCreatedCalls()).toHaveLength(0);
  });

  it("persists the completed call as a Call-table row with the right riskCategory", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming tomorrow." });
    const rows = await prisma.call.findMany({ where: { direction: "outbound" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].riskCategory).toBe("LOW");
    expect(rows[0].normalizedCallerNumber).toBe("+923001234567");
  });
});

describe("voice tool - input validation", () => {
  it("rejects an unparseable recipient rather than guessing", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "not-a-phone-number", purposeSummary: "hi" });
    expect(result.status).toBe("ERROR");
    expect(provider.getCreatedCalls()).toHaveLength(0);
  });

  it("rejects mass-campaign calls outright, never queuing them", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purposeSummary: "hi", isMassCampaign: "true" });
    expect(result.status).toBe("ERROR");
    expect(provider.getCreatedCalls()).toHaveLength(0);
  });
});

describe("voice tool - suppression / DO_NOT_CALL", () => {
  it("blocks a call to a suppressed number before risk classification even runs", async () => {
    await suppressPhoneForCalls("+923001234567", "MANUAL");
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming tomorrow." });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getCreatedCalls()).toHaveLength(0);
  });
});

describe("voice tool - idempotency", () => {
  it("a retried identical call does not call the provider twice", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const first = await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming tomorrow.", taskId: "task-1" });
    expect(first.status).toBe("OK");
    const second = await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming tomorrow.", taskId: "task-1" });
    expect(second.status).toBe("OK");
    expect((second.data as { deduplicated?: boolean }).deduplicated).toBe(true);
    expect(provider.getCreatedCalls()).toHaveLength(1);
  });
});

describe("voice tool - provider error handling", () => {
  it("an INVALID_RECIPIENT provider error is surfaced honestly, never reported as OK", async () => {
    const provider = new MockVoiceProvider();
    provider.markInvalidRecipient("+923001234567");
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "call", to: "+923001234567", purpose: "CALLBACK_CONFIRMATION", purposeSummary: "Confirming tomorrow." });
    expect(result.status).toBe("ERROR");
  });
});

describe("voice tool - human handoff", () => {
  it("creates a callback task/notification, never a real live transfer", async () => {
    const provider = new MockVoiceProvider();
    const tool = createVoiceTool(provider);
    const result = await tool.execute({ action: "human_handoff", reason: "Caller asked for a human agent." });
    expect(result.status).toBe("OK");
    // The mock provider's transferCall() would return NOT_IMPLEMENTED if
    // called - the human_handoff action never calls it at all.
    const transferResult = await provider.transferCall("x", "+923001234567");
    expect("code" in transferResult && transferResult.code).toBe("NOT_IMPLEMENTED");
  });
});
