// core/production/duplicationPrevention.test.ts - Phase 12 (item 13):
// mandatory duplication-prevention proofs, each against the REAL, existing
// DB-atomic `updateMany` mechanism (core/worker/claim.ts's claimTask() /
// core/browser/session.ts's closeSession() / core/business/idempotency.ts's
// reserveIdempotencyKey()) - never a new mechanism, and never an in-memory
// mutex alone. Simulated "multi-worker race" = a real Promise.all of
// concurrent calls against the SAME row from what would, in a real
// multi-process deployment, be separate processes; the atomicity guarantee
// comes from the database's own conditional UPDATE, which does not care how
// many processes issue it, only that exactly one WHERE clause matches per
// row - the same guarantee holds whether the concurrent callers are two
// Promises in one process or two real processes.
import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { claimTask, releaseClaim } from "../worker/claim";
import { createIsolatedSession, closeSession, _shutdownForTests } from "../browser/session";
import { reserveIdempotencyKey } from "../business/idempotency";

describe("Phase 12 (item 13) - duplication prevention under simulated multi-worker races", () => {
  it("task claim (the scheduler-dispatch/worker-execution primitive): exactly one of N concurrent claimers wins", async () => {
    const task = await prisma.task.create({
      data: { title: "phase12-dup-test-task", status: "PENDING" },
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimTask(task.id, `simulated-worker-${i}`, 60_000))
    );

    const claimed = results.filter((r) => r.claimed);
    expect(claimed.length).toBe(1);

    // Confirm the DB row itself agrees - not just the in-memory results.
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.claimedBy).toMatch(/^simulated-worker-\d$/);

    await releaseClaim(task.id, row.claimedBy!);
  });

  it("a scheduled job's dispatch slot (modeled as a Task the way ConditionRule-created scheduler tasks are) is claimed exactly once under a burst of simultaneous fire attempts", async () => {
    // This models the exact shape morning-briefing/daily-report/weekly-review
    // use in production: SCHEDULE.fired -> a ConditionRule creates ONE Task
    // row -> workers race to claim it via claimTask(). The scheduler's own
    // in-process runningJobs Set (scheduler/index.ts) additionally prevents
    // a duplicate CRON FIRE within one process; this test proves the
    // downstream, process-count-independent guarantee: whichever/however
    // many processes see that one Task row, only one executes it.
    const task = await prisma.task.create({
      data: { title: "weekly-review", status: "PENDING", toolName: "business_intelligence" },
    });

    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimTask(task.id, `scheduler-worker-${i % 3}`, 60_000))
    );
    expect(attempts.filter((r) => r.claimed).length).toBe(1);
  });

  it("outbound message idempotency reservation: exactly one of N concurrent identical triggers reserves the key", async () => {
    const key = `phase12-dup-idempotency-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserveIdempotencyKey({ idempotencyKey: key, channel: "EMAIL", contactId: null })
      )
    );
    const reserved = results.filter((r) => r.reserved);
    expect(reserved.length).toBe(1);
  });

  it("browser session close is exclusive: exactly one of N concurrent close attempts performs the real provider close", async () => {
    const session = await createIsolatedSession({ createdBy: "test:phase12" });

    const results = await Promise.all(Array.from({ length: 5 }, () => closeSession(session.id, "phase12-dup-test")));
    const actuallyClosed = results.filter((r) => r.closed);
    expect(actuallyClosed.length).toBe(1);

    const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("CLOSED");

    await _shutdownForTests();
  }, 20_000);
});
