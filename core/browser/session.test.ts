// core/browser/session.test.ts - Phase 10.1 (browser session cleanup
// hardening) tests. Uses REAL Playwright sessions (pre-installed in this
// sandbox, same pattern as tools/browser/browserTool.test.ts) - never a
// mock browser. Directly manipulates Task/WorkerHeartbeat rows via Prisma to
// simulate worker crashes and process restarts, exactly the same technique
// core/worker/claim.test.ts's "#6 crash recovery" test uses for task claims.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import {
  createIsolatedSession,
  closeSession,
  getLiveSession,
  reconcileBrowserSessions,
  _shutdownForTests,
  __injectCloseFailureForTests,
} from "./session";
import { runWatchdogChecks } from "../worker/watchdog";
import { initHeartbeat, beat } from "../worker/heartbeat";
import { identityToActorString, WORKER_IDENTITY } from "../auth/identity";

async function makeTask(status: string, claimedBy: string | null = null): Promise<string> {
  const task = await prisma.task.create({
    data: {
      title: "browser-session-test task",
      status,
      claimedBy,
      claimedAt: claimedBy ? new Date() : null,
      claimExpiresAt: claimedBy ? new Date(Date.now() + 5 * 60 * 1000) : null,
    },
  });
  return task.id;
}

async function staleHeartbeat(workerId: string): Promise<void> {
  await initHeartbeat(workerId);
  // Push lastHeartbeat far enough into the past to exceed the default
  // heartbeatTimeoutMs (30s) - directly, so this is deterministic and not
  // timer-dependent.
  await prisma.workerHeartbeat.update({
    where: { workerId },
    data: { lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000) },
  });
}

async function freshHeartbeat(workerId: string): Promise<void> {
  await initHeartbeat(workerId);
  await beat(workerId, { status: "RUNNING" });
}

afterAll(async () => {
  await _shutdownForTests();
});

beforeEach(async () => {
  await prisma.browserSession.deleteMany();
});

describe("core/browser/session - atomic concurrency-safe cleanup (sections 12-15, 33)", () => {
  it("closeSession is idempotent - closing an already-CLOSED session is a safe no-op, never an exception", async () => {
    const session = await createIsolatedSession({ createdBy: "test" });
    const first = await closeSession(session.id, "test");
    expect(first.closed).toBe(true);
    const second = await closeSession(session.id, "test-again");
    expect(second.closed).toBe(false);
    expect(second.alreadyClosedOrInProgress).toBe(true);
    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("CLOSED");
  });

  it("#39 concurrent closeSession callers: exactly one wins the atomic claim and calls the provider, the other observes CLEANING/CLOSED and exits", async () => {
    const session = await createIsolatedSession({ createdBy: "test" });
    const [a, b] = await Promise.all([closeSession(session.id, "concurrent-a"), closeSession(session.id, "concurrent-b")]);
    const winners = [a, b].filter((r) => r.closed);
    const losers = [a, b].filter((r) => !r.closed);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].alreadyClosedOrInProgress).toBe(true);
    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("CLOSED");
    expect(getLiveSession(session.id)).toBeNull();
  });
});

describe("core/browser/session - isolation (sections 21-24)", () => {
  it("#23/#24 cleaning up one task's session never touches another owner's session (ownership-scoped, not a global sweep)", async () => {
    const taskA = await makeTask("DONE");
    const taskB = await makeTask("PENDING");
    const sessionA = await createIsolatedSession({ taskId: taskA, createdBy: "owner-a" });
    const sessionB = await createIsolatedSession({ taskId: taskB, createdBy: "owner-b" });

    const result = await closeSession(sessionA.id, "task_a_cleanup");
    expect(result.closed).toBe(true);

    const rowA = await prisma.browserSession.findUnique({ where: { id: sessionA.id } });
    const rowB = await prisma.browserSession.findUnique({ where: { id: sessionB.id } });
    expect(rowA?.status).toBe("CLOSED");
    expect(rowB?.status).toBe("ACTIVE"); // untouched
    expect(getLiveSession(sessionB.id)).not.toBeNull();

    await closeSession(sessionB.id, "test_cleanup");
  });
});

describe("core/browser/session - active-task protection vs. orphan reaping (sections 8-9, #40)", () => {
  it("#40 does NOT reap a session whose owning task is still IN_PROGRESS with a fresh worker heartbeat (no false cleanup of an active session)", async () => {
    const workerId = "active-protect-worker";
    await freshHeartbeat(workerId);
    const taskId = await makeTask("IN_PROGRESS", workerId);
    const session = await createIsolatedSession({ taskId, createdBy: "owner" });

    const report = await reconcileBrowserSessions();
    expect(report.reasons.some((r) => r.includes(session.id))).toBe(false);

    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("ACTIVE");
    expect(getLiveSession(session.id)).not.toBeNull();

    await closeSession(session.id, "test_cleanup");
  });

  it("hard max lifetime is absolute - reaps an 'active' session (fresh heartbeat, in-progress task) once expiresAt has passed, overriding task/worker protection", async () => {
    const workerId = "active-protect-worker-2";
    await freshHeartbeat(workerId);
    const taskId = await makeTask("IN_PROGRESS", workerId);
    const session = await createIsolatedSession({ taskId, createdBy: "owner" });
    await prisma.browserSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const report = await reconcileBrowserSessions();
    // Reaped by the routine TTL-expiry pass (cleanupExpiredSessions, which
    // reconcileBrowserSessions calls first) - isSessionExpired() checks
    // expiresAt unconditionally, so the hard-lifetime override takes effect
    // even earlier than the dedicated orphan-detection pass, which is
    // exactly the "absolute, regardless of activity" behavior required.
    expect(report.closed).toBeGreaterThan(0);

    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("CLOSED");
    expect(row?.closeReason).toBe("expired_or_idle_timeout");
  });
});

describe("core/browser/session + core/worker/watchdog - end-to-end watchdog reconciliation (#38, the anchor test)", () => {
  it("create session -> owning worker's heartbeat goes stale -> the REAL runWatchdogChecks() detects the orphan, claims cleanup, closes the provider, sets the session CLOSED, and an audit event exists", async () => {
    const workerId = "crashed-worker-e2e";
    const taskId = await makeTask("IN_PROGRESS", workerId);
    const session = await createIsolatedSession({ taskId, createdBy: "owner" });
    expect(getLiveSession(session.id)).not.toBeNull();

    await staleHeartbeat(workerId);

    const auditBefore = await prisma.auditLog.count({
      where: { action: "browser.session_closed", target: session.id, actor: identityToActorString(WORKER_IDENTITY) },
    });

    // The REAL watchdog function - not a standalone cleanup-function unit
    // test - exactly as the brief requires.
    const findings = await runWatchdogChecks("crashed-worker-e2e-watchdog");
    expect(findings.some((f) => f.kind === "ORPHANED_BROWSER_SESSIONS")).toBe(true);

    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("CLOSED");
    expect(getLiveSession(session.id)).toBeNull(); // provider closed

    const auditAfter = await prisma.auditLog.count({
      where: { action: "browser.session_closed", target: session.id, actor: identityToActorString(WORKER_IDENTITY) },
    });
    expect(auditAfter).toBeGreaterThan(auditBefore);
  });
});

describe("core/browser/session - crash-recovery after process restart (section 10, section 18's provider-registry caveat)", () => {
  it("a BrowserSession row left ACTIVE with NO reachable in-process handle (simulated restart) is reconciled to CLOSED, never silently assumed still-active", async () => {
    // Simulates "after a process restart": a DB row exists but was never
    // created via createIsolatedSession() in THIS test process, so the
    // module's in-process liveSessions registry (a cache, never
    // authoritative - section 18) genuinely has no entry for it.
    const row = await prisma.browserSession.create({
      data: {
        provider: "playwright",
        status: "ACTIVE",
        isolationLevel: "CONTEXT",
        createdBy: "owner",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // not lifetime-expired
        lastActivityAt: new Date(), // not idle-timed-out either
      },
    });
    expect(getLiveSession(row.id)).toBeNull();

    const report = await reconcileBrowserSessions();
    expect(report.reasons.some((r) => r.includes(row.id))).toBe(true);

    const after = await prisma.browserSession.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("provider_crashed");
  });

  it("a row stuck CLEANING with no reachable handle (crash mid-cleanup) is resolved to CLOSED, per the provider/DB reconciliation matrix", async () => {
    const row = await prisma.browserSession.create({
      data: {
        provider: "playwright",
        status: "CLEANING",
        isolationLevel: "CONTEXT",
        createdBy: "owner",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    const report = await reconcileBrowserSessions();
    expect(report.staleCleaningResolved).toBeGreaterThan(0);
    const after = await prisma.browserSession.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("reconciled_stale_cleaning_no_live_handle");
  });
});

describe("core/browser/session - emergency stop / system pause interaction (sections 19-20)", () => {
  it("watchdog-triggered cleanup runs and closes an orphaned session even during EMERGENCY_STOP (only NEW browser actions are blocked, not cleanup)", async () => {
    const { setSystemState } = await import("../state");
    await setSystemState("EMERGENCY_STOP", "test: prove cleanup still runs", "test");
    try {
      const workerId = "crashed-worker-during-stop";
      const taskId = await makeTask("IN_PROGRESS", workerId);
      const session = await createIsolatedSession({ taskId, createdBy: "owner" });
      await staleHeartbeat(workerId);

      const findings = await runWatchdogChecks("watchdog-during-stop");
      expect(findings.some((f) => f.kind === "ORPHANED_BROWSER_SESSIONS")).toBe(true);

      const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
      expect(row?.status).toBe("CLOSED");
    } finally {
      await setSystemState("RUNNING", "test cleanup", "test");
    }
  });
});

describe("core/browser/session - bounded, persisted cleanup-failure retry (sections 29-30)", () => {
  it("a repeatedly-failing provider close is retried with backoff, persists attempt-count/error/next-retry, and finalizes to the terminal CLEANUP_FAILED status (never a false CLOSED)", async () => {
    const session = await createIsolatedSession({ createdBy: "test" });
    __injectCloseFailureForTests(session.id, "simulated provider close failure");

    const notificationsBefore = await prisma.notification.count({ where: { type: "CRITICAL" } });

    // DEFAULT_WORKER_CONFIG.maxRestartAttempts is 5 - drive it to the cap.
    let lastRow;
    for (let i = 0; i < 6; i++) {
      await closeSession(session.id, "retry-test");
      lastRow = await prisma.browserSession.findUnique({ where: { id: session.id } });
      if (lastRow?.status === "CLEANUP_FAILED") break;
    }

    expect(lastRow?.status).toBe("CLEANUP_FAILED");
    expect(lastRow?.cleanupAttempts).toBeGreaterThanOrEqual(5);
    expect(lastRow?.lastCleanupError).toContain("simulated provider close failure");
    expect(lastRow?.nextCleanupRetryAt).toBeNull(); // terminal - no further retry scheduled

    const notificationsAfter = await prisma.notification.count({ where: { type: "CRITICAL" } });
    expect(notificationsAfter).toBeGreaterThan(notificationsBefore);

    // Idempotent even from the terminal state: never re-attempts the provider close.
    const again = await closeSession(session.id, "post-terminal");
    expect(again.closed).toBe(false);
  });

  it("an intermediate failure reverts to ORPHANED (reclaimable) with a future nextCleanupRetryAt, not stuck in CLEANING", async () => {
    const session = await createIsolatedSession({ createdBy: "test" });
    __injectCloseFailureForTests(session.id, "one-off failure");
    await closeSession(session.id, "retry-test");
    const row = await prisma.browserSession.findUnique({ where: { id: session.id } });
    expect(row?.status).toBe("ORPHANED");
    expect(row?.cleanupAttempts).toBe(1);
    expect(row?.nextCleanupRetryAt).not.toBeNull();
    expect(row!.nextCleanupRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("core/browser/session - metrics are derived from authoritative DB state (section 26)", () => {
  it("session counts by status come from a live DB query, not an in-memory counter that could drift", async () => {
    const s1 = await createIsolatedSession({ createdBy: "test" });
    const s2 = await createIsolatedSession({ createdBy: "test" });
    await closeSession(s1.id, "test");

    const active = await prisma.browserSession.count({ where: { status: "ACTIVE" } });
    const closed = await prisma.browserSession.count({ where: { status: "CLOSED" } });
    expect(active).toBe(1);
    expect(closed).toBe(1);

    await closeSession(s2.id, "test_cleanup");
  });
});
