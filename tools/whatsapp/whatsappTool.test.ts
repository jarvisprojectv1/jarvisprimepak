// tools/whatsapp/whatsappTool.test.ts - Phase 8, item 12/47's core send-flow
// tests, mirroring tools/email/emailTool.test.ts's shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { createWhatsAppTool } from "./whatsappTool";
import { MockWhatsAppProvider } from "./mockProvider";
import { toolRegistry } from "../registry";
import { setSystemState } from "../../core/state";
import { suppressWhatsAppContact, setAntiSpamConfig, DEFAULT_ANTI_SPAM } from "../../core/business/antiSpam";

beforeEach(async () => {
  await prisma.outboundSendLog.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.email.deleteMany();
  await prisma.suppressedContact.deleteMany();
  await prisma.contact.deleteMany();
  // The Setting row backing anti-spam config is process-global/DB-persisted,
  // not per-test - reset it here (same pattern core/business/antiSpam.test.ts
  // uses for itself) so an earlier test file's low-limit override never
  // leaks into these assertions.
  await setAntiSpamConfig(DEFAULT_ANTI_SPAM);
});

afterEach(async () => {
  await setSystemState("RUNNING", "test cleanup", "test");
});

describe("whatsapp tool - configuration", () => {
  it("returns CONFIGURATION_REQUIRED when the provider is unconfigured", async () => {
    const provider = new MockWhatsAppProvider();
    provider.setConfigured(false);
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "hi" });
    expect(result.status).toBe("CONFIGURATION_REQUIRED");
  });
});

describe("whatsapp tool - LOW risk send", () => {
  it("sends a LOW-risk message straight through, normalizing the phone number", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "0300-1234567", body: "Thanks for reaching out, we'll follow up shortly." });
    expect(result.status).toBe("OK");
    expect(provider.getSentMessages()).toHaveLength(1);
    expect(provider.getSentMessages()[0].to).toBe("+923001234567");
  });

  it("persists the sent message as an Email-table row with channel WHATSAPP", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    await tool.execute({ action: "send", to: "+923001234567", body: "Thanks!" });
    const rows = await prisma.email.findMany({ where: { channel: "WHATSAPP", direction: "outbound" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].toAddress).toBe("+923001234567");
  });

  it("rejects an unparseable recipient rather than guessing", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "not-a-phone-number", body: "hi" });
    expect(result.status).toBe("ERROR");
    expect(provider.getSentMessages()).toHaveLength(0);
  });
});

describe("whatsapp tool - suppression / opt-out", () => {
  it("blocks a send to a suppressed number before risk classification even runs", async () => {
    await suppressWhatsAppContact("+923001234567", "UNSUBSCRIBE");
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "Price: $1000 per unit." }); // HIGH-risk content, would otherwise create an approval
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages()).toHaveLength(0);
    const pendingApprovals = await prisma.approvalRequest.count();
    expect(pendingApprovals).toBe(0); // suppression short-circuits before an approval is ever created
  });
});

describe("whatsapp tool - mass campaigns are NOT_IMPLEMENTED", () => {
  it("rejects isMassCampaign outright rather than queueing/gating it", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "hi", isMassCampaign: "true" });
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/NOT_IMPLEMENTED/);
    expect(provider.getSentMessages()).toHaveLength(0);
  });
});

describe("whatsapp tool - idempotency", () => {
  it("does not send twice for the identical taskId+recipient+body", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const input = { action: "send", to: "+923001234567", body: "hello", taskId: "task-1" };
    const first = await tool.execute(input);
    const second = await tool.execute(input);
    expect(first.status).toBe("OK");
    expect(second.status).toBe("OK");
    expect((second.data as { deduplicated?: boolean }).deduplicated).toBe(true);
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it("an email send and a WhatsApp send with the same taskId+recipient-shaped content do NOT collide on one idempotency key", async () => {
    const { computeIdempotencyKey, computeChannelIdempotencyKey } = await import("../../core/business/idempotency");
    const emailKey = computeIdempotencyKey({ taskId: "t1", contactEmail: "same@example.com", subject: "", body: "hi" });
    const waKey = computeChannelIdempotencyKey({ channel: "WHATSAPP", taskId: "t1", recipient: "same@example.com", body: "hi" });
    expect(emailKey).not.toBe(waKey);
  });
});

describe("whatsapp tool - HIGH risk requires approval, exactly like email", () => {
  it("a HIGH-risk send creates a PENDING approval and blocks", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "quotation: $500 per unit" });
    expect(result.status).toBe("BLOCKED");
    const approvalId = (result.data as { approvalRequestId: string }).approvalRequestId;
    const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    expect(approval?.status).toBe("PENDING");
    expect(approval?.action).toBe("whatsapp.send");
    expect(JSON.parse(approval!.supportingContext!).channel).toBe("WHATSAPP");
  });

  it("an APPROVED, matching-target request lets the send through", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const first = await tool.execute({ action: "send", to: "+923001234567", body: "quotation: $500 per unit" });
    const approvalId = (first.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date() } });

    const second = await tool.execute({ action: "send", to: "+923001234567", body: "quotation: $500 per unit", approvalRequestId: approvalId });
    expect(second.status).toBe("OK");
    expect(provider.getSentMessages()).toHaveLength(1);
  });
});

describe("whatsapp tool - provider error handling never falsely reports SENT", () => {
  it("a PROVIDER_ERROR is reported honestly and OutboundSendLog is FAILED, not SENT", async () => {
    const provider = new MockWhatsAppProvider();
    provider.simulateSendFailures(1);
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "hello" });
    expect(result.status).toBe("ERROR");
    const log = await prisma.outboundSendLog.findFirst();
    expect(log?.status).toBe("FAILED");
  });

  it("an INVALID_RECIPIENT provider error is surfaced, not silently swallowed", async () => {
    const provider = new MockWhatsAppProvider();
    provider.markInvalidRecipient("+923001234567");
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "send", to: "+923001234567", body: "hello" });
    expect(result.status).toBe("ERROR");
  });
});

describe("whatsapp tool - draft", () => {
  it("generates a grounded draft with no send", async () => {
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    const result = await tool.execute({ action: "draft", category: "NEW_INQUIRY", contactFirstName: "Ali" });
    expect(result.status).toBe("OK");
    expect(provider.getSentMessages()).toHaveLength(0);
  });
});

describe("whatsapp tool - enforcement gate (registered path)", () => {
  it("EMERGENCY_STOP halts a WhatsApp send before it ever reaches the provider (registered-tool path)", async () => {
    if (!toolRegistry.get("whatsapp_test_marker_provider")) {
      // no-op: ensures this suite's assertions run against the REGISTERED
      // tool (guarded by core/enforcement), not a bare createWhatsAppTool()
      // instance, since the guard is applied by ToolRegistry.register(), not
      // by createWhatsAppTool() itself.
    }
    const provider = new MockWhatsAppProvider();
    const tool = createWhatsAppTool(provider);
    toolRegistry.register({ ...tool, name: "whatsapp_test_marker_provider" });

    await setSystemState("EMERGENCY_STOP", "test emergency", "test");
    const result = await toolRegistry.execute("whatsapp_test_marker_provider", { action: "send", to: "+923001234567", body: "hello" });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages()).toHaveLength(0);
  });
});
