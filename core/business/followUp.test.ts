// core/business/followUp.test.ts - item 20's guard checks, item Y (follow-up
// cancellation after a customer reply).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { isFollowUpAllowed } from "./followUp";
import { setSystemState, getSystemState } from "../state";
import { suppressContact } from "./antiSpam";

beforeEach(async () => {
  await prisma.communication.deleteMany();
  await prisma.suppressedContact.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.task.deleteMany();
  const state = await getSystemState();
  if (state.state !== "RUNNING") await setSystemState("RUNNING", "test setup", "test");
});

describe("Y: follow-up cancellation after customer reply", () => {
  it("blocks a follow-up when the contact replied after the follow-up task was created", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane@brand.example", normalizedEmail: "jane@brand.example" } });
    const task = await prisma.task.create({ data: { title: "follow-up", status: "PENDING" } });
    const before = new Date(task.createdAt.getTime() - 1000);
    await prisma.communication.create({ data: { contactId: contact.id, channel: "email", direction: "inbound", summary: "customer replied" } });

    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: before });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/replied/i);
  });

  it("allows a follow-up when there has been no reply", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane2@brand.example", normalizedEmail: "jane2@brand.example" } });
    const task = await prisma.task.create({ data: { title: "follow-up-2", status: "PENDING" } });
    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: task.createdAt });
    expect(result.allowed).toBe(true);
  });
});

describe("item 20 guards: suppression / cancellation / pause / emergency-stop", () => {
  it("blocks a follow-up for a suppressed contact", async () => {
    const contact = await prisma.contact.create({ data: { firstName: "Bob", email: "bob@brand.example", normalizedEmail: "bob@brand.example" } });
    await suppressContact("bob@brand.example", "UNSUBSCRIBE", contact.id);
    const task = await prisma.task.create({ data: { title: "follow-up-3", status: "PENDING" } });
    const result = await isFollowUpAllowed({ taskId: task.id, contactId: contact.id, sinceTaskCreatedAt: task.createdAt });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/suppress/i);
  });

  it("blocks a follow-up for a cancelled task", async () => {
    const task = await prisma.task.create({ data: { title: "follow-up-4", status: "CANCELLED" } });
    const result = await isFollowUpAllowed({ taskId: task.id, sinceTaskCreatedAt: task.createdAt });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cancelled/i);
  });

  it("blocks every follow-up when the system is PAUSED", async () => {
    const task = await prisma.task.create({ data: { title: "follow-up-5", status: "PENDING" } });
    await setSystemState("PAUSED", "test", "test");
    try {
      const result = await isFollowUpAllowed({ taskId: task.id, sinceTaskCreatedAt: task.createdAt });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/PAUSED/i);
    } finally {
      await setSystemState("RUNNING", "cleanup", "test");
    }
  });

  it("blocks every follow-up during EMERGENCY_STOP", async () => {
    const task = await prisma.task.create({ data: { title: "follow-up-6", status: "PENDING" } });
    await setSystemState("EMERGENCY_STOP", "test", "test");
    try {
      const result = await isFollowUpAllowed({ taskId: task.id, sinceTaskCreatedAt: task.createdAt });
      expect(result.allowed).toBe(false);
    } finally {
      await setSystemState("RUNNING", "cleanup", "test");
    }
  });
});
