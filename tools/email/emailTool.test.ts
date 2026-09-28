// tools/email/emailTool.test.ts - items A, B, C, O, P, S, T, U, V, W, X.
// Every test here uses MockEmailProvider ONLY - no live send capability is
// ever exercised (Production Safety, section 30).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { createEmailTool } from "./emailTool";
import { MockEmailProvider } from "./mockProvider";
import { suppressContact, setAntiSpamConfig, DEFAULT_ANTI_SPAM } from "../../core/business/antiSpam";
import { setLimitsConfig, __resetLimitsForTests } from "../../core/limits";
import { getSystemState, setSystemState } from "../../core/state";

async function resetDb() {
  await prisma.outboundSendLog.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.email.deleteMany();
  await prisma.suppressedContact.deleteMany();
  await prisma.contact.deleteMany();
}

beforeEach(async () => {
  await resetDb();
  await setAntiSpamConfig(DEFAULT_ANTI_SPAM);
  __resetLimitsForTests();
  const state = await getSystemState();
  if (state.state !== "RUNNING") await setSystemState("RUNNING", "test setup", "test");
});

describe("A: email provider abstraction", () => {
  it("registers a Tool with list/send/draft actions, wired through a swappable EmailProvider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    expect(tool.name).toBe("email");
    const result = await tool.execute({ action: "draft", category: "GENERAL_REPLY" });
    expect(result.status).toBe("OK");
  });
});

describe("B: missing email credentials", () => {
  it("returns CONFIGURATION_REQUIRED for every action when the provider is unconfigured", async () => {
    const provider = new MockEmailProvider();
    provider.setConfigured(false);
    const tool = createEmailTool(provider);
    const listResult = await tool.execute({ action: "list" });
    expect(listResult.status).toBe("CONFIGURATION_REQUIRED");
    const sendResult = await tool.execute({ action: "send", to: "x@example.com", subject: "hi", body: "hi" });
    expect(sendResult.status).toBe("CONFIGURATION_REQUIRED");
  });
});

describe("C: email retrieval", () => {
  it("lists and idempotently ingests inbound messages", async () => {
    const provider = new MockEmailProvider();
    provider.seedInboundMessage({ from: "buyer@brand.example", subject: "Interested in your packaging", body: "We would like to know more about corrugated boxes." });
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "list" });
    expect(result.status).toBe("OK");
    const data = result.data as { ingested: Array<{ isNew: boolean }> };
    expect(data.ingested.length).toBe(1);
    expect(data.ingested[0].isNew).toBe(true);

    // Retry: same provider message id must not duplicate the Email row.
    const second = await tool.execute({ action: "list" });
    const data2 = second.data as { ingested: Array<{ isNew: boolean }> };
    expect(data2.ingested[0].isNew).toBe(false);
    const count = await prisma.email.count();
    expect(count).toBe(1);
  });
});

describe("O: high-risk outbound email is blocked, never autonomously sent", () => {
  it("never calls provider.sendMessage for a HIGH-RISK email; creates a PENDING approval instead", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation for your order", body: "Here is our quote: $5000 for the full order." });
    expect(result.status).toBe("BLOCKED");
    const data = result.data as { approvalRequestId: string; riskCategory: string };
    expect(data.riskCategory).toBe("HIGH");
    expect(provider.getSentMessages().length).toBe(0);

    const approval = await prisma.approvalRequest.findUnique({ where: { id: data.approvalRequestId } });
    expect(approval?.status).toBe("PENDING");
    expect(approval?.riskClassification).toBe("HIGH");
  });

  it("sends only after the matching ApprovalRequest is APPROVED, and only via the mock provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const blocked = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000." });
    const approvalId = (blocked.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date() } });

    const sent = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000.", approvalRequestId: approvalId });
    expect(sent.status).toBe("OK");
    expect(provider.getSentMessages().length).toBe(1);
  });
});

describe("P: normal low-risk workflow sends without approval", () => {
  it("sends a LOW-risk email directly through the provider", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Nice to meet you", body: "Thanks for reaching out, happy to help." });
    expect(result.status).toBe("OK");
    expect(provider.getSentMessages().length).toBe(1);
  });
});

describe("S: outbound cooldown", () => {
  it("blocks a second send to the same contact within the cooldown window", async () => {
    await setAntiSpamConfig({ perContactCooldownHours: 24 });
    const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane@brand.example", normalizedEmail: "jane@brand.example" } });
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const first = await tool.execute({ action: "send", to: "jane@brand.example", subject: "Hello", body: "Nice to meet you.", contactId: contact.id });
    expect(first.status).toBe("OK");
    const second = await tool.execute({ action: "send", to: "jane@brand.example", subject: "Hello again", body: "Following up.", contactId: contact.id });
    expect(second.status).toBe("BLOCKED");
    expect(second.message).toMatch(/cooldown/i);
  });
});

describe("T: suppression / unsubscribe", () => {
  it("hard-blocks any send to a suppressed contact, even a LOW-risk one, BEFORE risk classification", async () => {
    await suppressContact("unsub@brand.example", "UNSUBSCRIBE");
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "send", to: "unsub@brand.example", subject: "Hi", body: "Just checking in." });
    expect(result.status).toBe("BLOCKED");
    expect(result.message).toMatch(/suppression/i);
    expect(provider.getSentMessages().length).toBe(0);
  });
});

describe("U: duplicate outbound prevention / X: idempotent send", () => {
  it("does not send the exact same content twice for the same task - the second attempt short-circuits before hitting the provider again", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const input = { action: "send", to: "buyer@brand.example", subject: "Hello", body: "Nice to meet you.", taskId: "task-123" };
    const first = await tool.execute(input);
    expect(first.status).toBe("OK");
    const second = await tool.execute(input);
    expect(second.status).toBe("OK");
    const data = second.data as { deduplicated?: boolean };
    expect(data.deduplicated).toBe(true);
    expect(provider.getSentMessages().length).toBe(1); // provider only ever saw ONE real send
  });
});

describe("V: provider timeout / W: provider retry", () => {
  it("surfaces a provider timeout as ERROR without recording a false SENT log", async () => {
    const provider = new MockEmailProvider();
    provider.simulateTimeoutOnce();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Hi", body: "Following up." });
    expect(result.status).toBe("ERROR");
    const log = await prisma.outboundSendLog.findFirst();
    expect(log?.status).toBe("FAILED");
  });

  it("a transient failure followed by a manual retry with the SAME idempotency key eventually succeeds exactly once", async () => {
    const provider = new MockEmailProvider();
    provider.simulateSendFailures(1);
    const tool = createEmailTool(provider);
    const input = { action: "send", to: "buyer@brand.example", subject: "Hi", body: "Following up.", taskId: "task-retry-1" };
    const first = await tool.execute(input);
    expect(first.status).toBe("ERROR");
    const retry = await tool.execute(input);
    expect(retry.status).toBe("OK");
    expect(provider.getSentMessages().length).toBe(1);
  });
});
