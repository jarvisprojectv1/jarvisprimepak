import { describe, it, expect, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../database/client";
import { setLimitsConfig, DEFAULT_LIMITS } from "../limits";
import { recoverUnfinishedTasks } from "./index";

describe("core/tasks - recoverUnfinishedTasks", () => {
  afterEach(async () => {
    await setLimitsConfig({ ...DEFAULT_LIMITS });
  });

  it("persists a task across a simulated restart (fresh Prisma client)", async () => {
    const created = await prisma.task.create({
      data: { title: "survive-restart-task", status: "IN_PROGRESS" },
    });

    // Simulate a crashed-and-restarted process: a brand new PrismaClient
    // instance, not the cached singleton, reading the same SQLite file.
    const freshClient = new PrismaClient();
    try {
      const reread = await freshClient.task.findUnique({ where: { id: created.id } });
      expect(reread).not.toBeNull();
      expect(reread?.status).toBe("IN_PROGRESS");
    } finally {
      await freshClient.$disconnect();
    }

    await prisma.task.delete({ where: { id: created.id } });
  });

  it("moves a stuck IN_PROGRESS task to RETRYING when under the retry limit", async () => {
    await setLimitsConfig({ retryLimit: 3 });
    const task = await prisma.task.create({
      data: { title: "stuck-task", status: "IN_PROGRESS", retryCount: 0 },
    });

    const report = await recoverUnfinishedTasks();
    expect(report.movedToRetrying).toContain(task.id);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("RETRYING");
    expect(updated.retryCount).toBe(1);

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("moves a stuck IN_PROGRESS task to FAILED once the retry limit is reached", async () => {
    await setLimitsConfig({ retryLimit: 1 });
    const task = await prisma.task.create({
      data: { title: "exhausted-task", status: "IN_PROGRESS", retryCount: 0 },
    });

    const report = await recoverUnfinishedTasks();
    expect(report.movedToFailed).toContain(task.id);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("FAILED");

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("leaves tasks in other statuses untouched", async () => {
    const task = await prisma.task.create({ data: { title: "pending-task", status: "PENDING" } });
    await recoverUnfinishedTasks();
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("PENDING");
    await prisma.task.delete({ where: { id: task.id } });
  });
});
