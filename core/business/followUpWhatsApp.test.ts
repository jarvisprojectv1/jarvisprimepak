// core/business/followUpWhatsApp.test.ts - Phase 8, items 20/22: the
// channel-generalized follow-up dispatch/guard, reusing the SAME
// scheduleDueFollowUps()/isFollowUpAllowed() email already has.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { scheduleFollowUp, scheduleDueFollowUps, isFollowUpAllowed } from "./followUp";
import { suppressWhatsAppContact } from "./antiSpam";
import { setSystemState, getSystemState } from "../state";

beforeEach(async () => {
  await prisma.communication.deleteMany();
  await prisma.suppressedContact.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.task.deleteMany();
  await prisma.lead.deleteMany();
  const state = await getSystemState();
  if (state.state !== "RUNNING") await setSystemState("RUNNING", "test setup", "test");
});

describe("Phase 8: channel-aware follow-up dispatch (item 20 - SAME dispatch pass, not a second scheduler)", () => {
  it("a WHATSAPP-channel follow-up dispatches a Task tagged toolName:'whatsapp'", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", phone: "+923001234567", normalizedPhone: "+923001234567" } });
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "CONTACTED" } });
    await scheduleFollowUp({ leadId: lead.id, contactId: contact.id, sequenceStep: 1, subject: "", body: "Following up", scheduledFor: new Date(Date.now() - 1000), channel: "WHATSAPP" });

    const { dispatched } = await scheduleDueFollowUps();
    expect(dispatched).toBe(1);

    const followUp = await prisma.followUp.findFirst({ where: { leadId: lead.id } });
    expect(followUp?.taskId).toBeTruthy();
    const task = await prisma.task.findUnique({ where: { id: followUp!.taskId! } });
    expect(task?.toolName).toBe("whatsapp");
  });

  it("an EMAIL-channel follow-up (unchanged default) still dispatches toolName:'email'", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane@brand.example", normalizedEmail: "jane@brand.example" } });
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "CONTACTED" } });
    await scheduleFollowUp({ leadId: lead.id, contactId: contact.id, sequenceStep: 1, subject: "Following up", body: "Following up", scheduledFor: new Date(Date.now() - 1000) });

    await scheduleDueFollowUps();
    const followUp = await prisma.followUp.findFirst({ where: { leadId: lead.id } });
    const task = await prisma.task.findUnique({ where: { id: followUp!.taskId! } });
    expect(task?.toolName).toBe("email");
  });
});

describe("Phase 8: WhatsApp-channel guard checks (item 20 - reusing isFollowUpAllowed)", () => {
  it("blocks a WhatsApp follow-up to a WhatsApp-suppressed contact", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", phone: "+923001234567", normalizedPhone: "+923001234567" } });
    await suppressWhatsAppContact("+923001234567", "UNSUBSCRIBE", contact.id);
    const task = await prisma.task.create({ data: { title: "follow-up", status: "PENDING" } });

    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: new Date(task.createdAt.getTime() - 1000), channel: "WHATSAPP" });
    expect(result.allowed).toBe(false);
  });

  it("item 22 (cross-channel duplicate protection): a WhatsApp follow-up is cancelled when the customer replied over EMAIL since scheduling", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", phone: "+923001234567", normalizedPhone: "+923001234567" } });
    const task = await prisma.task.create({ data: { title: "follow-up", status: "PENDING" } });
    const before = new Date(task.createdAt.getTime() - 1000);
    // The customer replied over EMAIL, not WhatsApp - the guard must still catch it.
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "inbound", summary: "customer replied by email" } });

    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: before, channel: "WHATSAPP" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/replied/i);
  });

  it("item 22, the other direction: an EMAIL follow-up is cancelled when the customer replied over WHATSAPP since scheduling", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Ali", email: "ali@brand.example", normalizedEmail: "ali@brand.example", phone: "+923001234567", normalizedPhone: "+923001234567" } });
    const task = await prisma.task.create({ data: { title: "follow-up", status: "PENDING" } });
    const before = new Date(task.createdAt.getTime() - 1000);
    await prisma.communication.create({ data: { contactId: contact.id, channel: "whatsapp", direction: "inbound", summary: "customer replied by whatsapp" } });

    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: before, channel: "EMAIL" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/replied/i);
  });
});
