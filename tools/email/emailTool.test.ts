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

describe("Phase 7.1 item 6: approval edge cases", () => {
  it("an APPROVED approval for a DIFFERENT target is rejected, not treated as authorizing this send", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const blocked = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000." });
    const approvalId = (blocked.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date() } });

    // Same approval id, but a DIFFERENT recipient/content than what was approved.
    const result = await tool.execute({ action: "send", to: "someone-else@brand.example", subject: "Quotation", body: "Quote: $9999.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("an APPROVED approval past its expiresAt is treated as expired AT SEND TIME, not just at decision time", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const blocked = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000." });
    const approvalId = (blocked.data as { approvalRequestId: string }).approvalRequestId;
    // Approve it, but backdate expiresAt into the past (simulating a real
    // approval that sat unused past its expiry before a retry).
    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date(), expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
    const row = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    expect(row?.status).toBe("EXPIRED");
  });

  it("a REVOKED approval (APPROVED, then revoked before retry) never reaches the provider", async () => {
    const { revokeRequest } = await import("../../core/approvals");
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const blocked = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000." });
    const approvalId = (blocked.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date() } });
    await revokeRequest(approvalId, "owner:test", "changed my mind");

    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("a forged caller-supplied 'approved' flag on the input is ignored - only the DB row's status matters", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({
      action: "send",
      to: "buyer@brand.example",
      subject: "Quotation",
      body: "Quote: $5000.",
      approved: true,
      skipApproval: true,
      forceSend: true,
      adminOverride: true,
    } as Record<string, unknown>);
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
  });

  it("suppression added AFTER approval but BEFORE the (re)send still hard-blocks", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const blocked = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000." });
    const approvalId = (blocked.data as { approvalRequestId: string }).approvalRequestId;
    await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status: "APPROVED", decidedBy: "owner:test", decidedAt: new Date() } });
    await suppressContact("buyer@brand.example", "UNSUBSCRIBE");

    const result = await tool.execute({ action: "send", to: "buyer@brand.example", subject: "Quotation", body: "Quote: $5000.", approvalRequestId: approvalId });
    expect(result.status).toBe("BLOCKED");
    expect(result.message).toMatch(/suppression/i);
    expect(provider.getSentMessages().length).toBe(0);
  });
});

describe("Phase 7.1 item 7/8: concurrency and suppression case sweep", () => {
  it("two concurrent execute() calls with the identical idempotency key result in exactly one real provider call", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const input = { action: "send", to: "buyer@brand.example", subject: "Hello", body: "Nice to meet you.", taskId: "task-concurrent-1" };

    const [a, b] = await Promise.all([tool.execute(input), tool.execute(input)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["OK", "OK"]);
    // At least one of the two responses reports the idempotent short-circuit.
    const anyDeduplicated = [a, b].some((r) => (r.data as { deduplicated?: boolean } | undefined)?.deduplicated === true);
    expect(anyDeduplicated).toBe(true);
    expect(provider.getSentMessages().length).toBe(1);
    // Both attempts are reconcilable via the OutboundSendLog's unique-keyed row.
    const logs = await prisma.outboundSendLog.findMany();
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe("SENT");
  });

  it("suppression case sweep: normalized-casing/whitespace, duplicate suppression insertion, retry-time suppression - all zero provider calls", async () => {
    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);

    // Different casing/whitespace than how it was suppressed.
    await suppressContact("Case.Test@Brand.example", "UNSUBSCRIBE");
    const r1 = await tool.execute({ action: "send", to: "  case.test@brand.example  ", subject: "Hi", body: "Hi." });
    expect(r1.status).toBe("BLOCKED");

    // Duplicate suppression insertion must not create two rows or break the check.
    await suppressContact("case.test@brand.example", "COMPLAINT");
    const count = await prisma.suppressedContact.count({ where: { normalizedEmail: "case.test@brand.example" } });
    expect(count).toBe(1);
    const r2 = await tool.execute({ action: "send", to: "case.test@brand.example", subject: "Hi", body: "Hi." });
    expect(r2.status).toBe("BLOCKED");

    // Suppression added mid-retry: first attempt blocked by HIGH risk/approval,
    // contact suppressed before the retry - retry must still hard-block.
    const first = await tool.execute({ action: "send", to: "retry-target@brand.example", subject: "Quote", body: "Price: $500." });
    expect(first.status).toBe("BLOCKED"); // HIGH-risk pending approval
    await suppressContact("retry-target@brand.example", "MANUAL");
    const retry = await tool.execute({ action: "send", to: "retry-target@brand.example", subject: "Quote", body: "Price: $500." });
    expect(retry.status).toBe("BLOCKED");
    expect(retry.message).toMatch(/suppression/i);

    expect(provider.getSentMessages().length).toBe(0);
  });
});

describe("Phase 7.1 items 2-3: follow-up dispatch integration (through the SAME email tool, no second sender)", () => {
  async function resetFollowUps() {
    await prisma.followUp.deleteMany();
    await prisma.task.deleteMany();
    await prisma.lead.deleteMany();
  }

  it("a due, allowed follow-up sends exactly once through provider.sendMessage and is marked EXECUTED", async () => {
    await resetFollowUps();
    const { scheduleFollowUp, scheduleDueFollowUps } = await import("../../core/business/followUp");
    const contact = await prisma.contact.create({ data: { firstName: "Ada", email: "ada@brand.example", normalizedEmail: "ada@brand.example" } });
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "CONTACTED" } });
    const fu = await scheduleFollowUp({
      leadId: lead.id,
      contactId: contact.id,
      sequenceStep: 1,
      subject: "Just checking in",
      body: "Following up on our earlier conversation.",
      scheduledFor: new Date(Date.now() - 1000),
    });
    await scheduleDueFollowUps();

    const dispatched = await prisma.followUp.findUnique({ where: { id: fu.id } });
    expect(dispatched?.taskId).toBeTruthy();

    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ taskId: dispatched!.taskId! });
    expect(result.status).toBe("OK");
    expect(provider.getSentMessages().length).toBe(1);

    const after = await prisma.followUp.findUnique({ where: { id: fu.id } });
    expect(after?.status).toBe("EXECUTED");
  });

  it("a follow-up is CANCELLED (never sent) when the lead has since gone WON", async () => {
    await resetFollowUps();
    const { scheduleFollowUp, scheduleDueFollowUps } = await import("../../core/business/followUp");
    const contact = await prisma.contact.create({ data: { firstName: "Bo", email: "bo@brand.example", normalizedEmail: "bo@brand.example" } });
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "CONTACTED" } });
    const fu = await scheduleFollowUp({
      leadId: lead.id,
      contactId: contact.id,
      sequenceStep: 1,
      subject: "Just checking in",
      body: "Following up.",
      scheduledFor: new Date(Date.now() - 1000),
    });
    await scheduleDueFollowUps();
    const dispatched = await prisma.followUp.findUnique({ where: { id: fu.id } });

    await prisma.lead.update({ where: { id: lead.id }, data: { status: "WON" } });

    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ taskId: dispatched!.taskId! });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);

    const after = await prisma.followUp.findUnique({ where: { id: fu.id } });
    expect(after?.status).toBe("CANCELLED");
    expect(after?.cancelReason).toMatch(/WON/);
  });

  it("a follow-up is CANCELLED when the customer replied since scheduling", async () => {
    await resetFollowUps();
    await prisma.communication.deleteMany();
    const { scheduleFollowUp, scheduleDueFollowUps } = await import("../../core/business/followUp");
    const contact = await prisma.contact.create({ data: { firstName: "Cy", email: "cy@brand.example", normalizedEmail: "cy@brand.example" } });
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "CONTACTED" } });
    const fu = await scheduleFollowUp({
      leadId: lead.id,
      contactId: contact.id,
      sequenceStep: 1,
      subject: "Just checking in",
      body: "Following up.",
      scheduledFor: new Date(Date.now() - 1000),
    });
    await scheduleDueFollowUps();
    const dispatched = await prisma.followUp.findUnique({ where: { id: fu.id } });
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "inbound", summary: "customer replied" } });

    const provider = new MockEmailProvider();
    const tool = createEmailTool(provider);
    const result = await tool.execute({ taskId: dispatched!.taskId! });
    expect(result.status).toBe("BLOCKED");
    expect(provider.getSentMessages().length).toBe(0);
    const after = await prisma.followUp.findUnique({ where: { id: fu.id } });
    expect(after?.status).toBe("CANCELLED");
  });

  it("scheduling twice for the same lead+sequenceStep reuses the same FollowUp row (item 4 idempotency)", async () => {
    await resetFollowUps();
    const { scheduleFollowUp } = await import("../../core/business/followUp");
    const lead = await prisma.lead.create({ data: { status: "CONTACTED" } });
    const first = await scheduleFollowUp({ leadId: lead.id, sequenceStep: 1, subject: "s", body: "b", scheduledFor: new Date() });
    const second = await scheduleFollowUp({ leadId: lead.id, sequenceStep: 1, subject: "s2", body: "b2", scheduledFor: new Date() });
    expect(second.id).toBe(first.id);
    const count = await prisma.followUp.count({ where: { leadId: lead.id, sequenceStep: 1 } });
    expect(count).toBe(1);
  });

  it("scheduler duplicate fire: two overlapping dispatch passes for the same due FollowUp create only ONE Task row", async () => {
    await resetFollowUps();
    const { scheduleFollowUp, scheduleDueFollowUps } = await import("../../core/business/followUp");
    const lead = await prisma.lead.create({ data: { status: "CONTACTED" } });
    await scheduleFollowUp({ leadId: lead.id, sequenceStep: 1, subject: "s", body: "b", scheduledFor: new Date(Date.now() - 1000) });

    await Promise.all([scheduleDueFollowUps(), scheduleDueFollowUps()]);

    const rows = await prisma.followUp.findMany({ where: { leadId: lead.id, sequenceStep: 1 } });
    expect(rows.length).toBe(1);
    expect(rows[0].taskId).toBeTruthy();
    const tasksLinked = await prisma.task.count({ where: { id: rows[0].taskId! } });
    expect(tasksLinked).toBe(1);
    // No orphan second Task was left claiming the same follow-up.
    const allFollowUpTasks = await prisma.task.count({ where: { toolName: "email", title: { contains: "Follow-up" } } });
    expect(allFollowUpTasks).toBe(1);
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
