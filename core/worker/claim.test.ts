import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { claimTask, releaseClaim, reclaimExpiredTasks } from "./claim";
import { setLimitsConfig, DEFAULT_LIMITS } from "../limits";

describe("core/worker/claim - DB-backed task claiming (#7)", () => {
  it("only one of two concurrent claim attempts on the same task succeeds", async () => {
    const task = await prisma.task.create({ data: { title: "race-task", status: "PENDING" } });

    const [a, b] = await Promise.all([
      claimTask(task.id, "worker-a", 60_000),
      claimTask(task.id, "worker-b", 60_000),
    ]);

    const claimedCount = [a, b].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.claimedBy).toBe(claimedCount === 1 && a.claimed ? "worker-a" : "worker-b");

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("a second claim attempt fails while the first claim is still valid", async () => {
    const task = await prisma.task.create({ data: { title: "held-task", status: "PENDING" } });
    const first = await claimTask(task.id, "worker-a", 60_000);
    expect(first.claimed).toBe(true);

    const second = await claimTask(task.id, "worker-b", 60_000);
    expect(second.claimed).toBe(false);

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("releaseClaim only releases the claim held by the same worker", async () => {
    const task = await prisma.task.create({ data: { title: "release-task", status: "PENDING" } });
    await claimTask(task.id, "worker-a", 60_000);

    await releaseClaim(task.id, "worker-b"); // wrong worker - no-op
    let row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.claimedBy).toBe("worker-a");

    await releaseClaim(task.id, "worker-a");
    row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.claimedBy).toBeNull();

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("a claim expiring while still PENDING/QUEUED/RETRYING (never reached IN_PROGRESS) is immediately reclaimable", async () => {
    // claimTask always moves the row to IN_PROGRESS as part of the same
    // write, so the only way claimedBy is set on a still-PENDING row is a
    // test fixture simulating a partial/inconsistent state - claimTask's
    // OR-expired clause still correctly reclaims it.
    const task = await prisma.task.create({
      data: { title: "expiring-task", status: "PENDING", claimedBy: "worker-a", claimExpiresAt: new Date(Date.now() - 5000) },
    });

    const reclaim = await claimTask(task.id, "worker-b", 60_000);
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.task?.claimedBy).toBe("worker-b");

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("#6 crash recovery: a task whose claim expired without completing is moved to RETRYING and its claim is cleared", async () => {
    await setLimitsConfig({ ...DEFAULT_LIMITS, retryLimit: 3 });
    // Simulate: task started -> claimed by a worker -> process terminated
    // (claim left in place, never released, and its expiry has passed).
    const task = await prisma.task.create({
      data: {
        title: "crashed-mid-flight",
        status: "IN_PROGRESS",
        claimedBy: "dead-worker",
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
        claimExpiresAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    // Simulate restart: a fresh call to the recovery function.
    const report = await reclaimExpiredTasks();
    expect(report.movedToRetrying).toContain(task.id);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("RETRYING");
    expect(updated.claimedBy).toBeNull();
    expect(updated.failureReason).toMatch(/dead-worker/);

    // Duplicate execution prevention: the recovered task can be claimed again
    // (its claim was genuinely cleared, not just its status).
    const reclaim = await claimTask(task.id, "worker-fresh", 60_000);
    expect(reclaim.claimed).toBe(true);

    await prisma.task.delete({ where: { id: task.id } });
  });
});
