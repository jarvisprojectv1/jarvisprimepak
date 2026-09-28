import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { decideRestart, giveUpPermanently, __resetWatchdogForTests, runWatchdogChecks } from "./watchdog";
import { initHeartbeat, beat, getHeartbeat } from "./heartbeat";
import { identityToActorString, WORKER_IDENTITY } from "../auth/identity";

const config = { maxRestartAttempts: 3, restartWindowMs: 60_000, restartBackoffBaseMs: 1 };

describe("core/worker/watchdog (#5, #15 loop protection)", () => {
  beforeEach(() => {
    __resetWatchdogForTests();
  });

  it("allows restart attempts up to the cap, then gives up (never an infinite restart loop)", () => {
    const workerId = "watchdog-worker";
    const decisions = [];
    const base = Date.now();
    for (let i = 0; i < config.maxRestartAttempts + 2; i++) {
      // Spaced enough to clear the (tiny) exponential backoff, but well
      // within restartWindowMs so all attempts still count toward the cap.
      decisions.push(decideRestart(workerId, config, base + i * 50));
    }
    const restarts = decisions.filter((d) => d.shouldRestart).length;
    const giveUps = decisions.filter((d) => d.giveUp).length;
    expect(restarts).toBe(config.maxRestartAttempts);
    expect(giveUps).toBeGreaterThan(0);
  });

  it("backs off between attempts instead of restarting immediately again", () => {
    const workerId = "watchdog-worker-backoff";
    const now = Date.now();
    const first = decideRestart(workerId, { ...config, restartBackoffBaseMs: 10_000 }, now);
    expect(first.shouldRestart).toBe(true);
    const second = decideRestart(workerId, { ...config, restartBackoffBaseMs: 10_000 }, now + 100); // too soon
    expect(second.shouldRestart).toBe(false);
    expect(second.giveUp).toBe(false);
  });

  it("giving up permanently marks the heartbeat CRASHED, writes a CRITICAL notification, and an audit log entry (#15)", async () => {
    const workerId = "watchdog-giveup-worker";
    await initHeartbeat(workerId);

    const notificationsBefore = await prisma.notification.count({ where: { type: "CRITICAL" } });
    const auditBefore = await prisma.auditLog.count({ where: { action: "worker.watchdog_gave_up" } });

    await giveUpPermanently(workerId, "test: hard cap reached");

    const hb = await getHeartbeat(workerId);
    expect(hb?.status).toBe("CRASHED");

    const notificationsAfter = await prisma.notification.count({ where: { type: "CRITICAL" } });
    expect(notificationsAfter).toBeGreaterThan(notificationsBefore);

    const auditAfter = await prisma.auditLog.count({
      where: { action: "worker.watchdog_gave_up", actor: identityToActorString(WORKER_IDENTITY) },
    });
    expect(auditAfter).toBeGreaterThan(auditBefore);
  });

  it("runWatchdogChecks flags a stale/missing heartbeat", async () => {
    const findings = await runWatchdogChecks("never-started-worker-xyz");
    expect(findings.some((f) => f.kind === "HEARTBEAT_TIMEOUT")).toBe(true);
  });

  it("runWatchdogChecks flags excessive retries", async () => {
    const task = await prisma.task.create({ data: { title: "near-limit", status: "RETRYING", retryCount: 3 } });
    const findings = await runWatchdogChecks("some-worker");
    expect(findings.some((f) => f.kind === "EXCESSIVE_RETRIES")).toBe(true);
    await prisma.task.delete({ where: { id: task.id } });
  });
});
