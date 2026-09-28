// core/browser/session.ts - Browser Session Model & Isolation (Phase 10,
// sections 6-7).
//
// Each JARVIS "browser session" is backed by a genuinely isolated Playwright
// BrowserContext: one shared Chromium `Browser` process is launched lazily
// (real OS-level launch is expensive; contexts are cheap and this is
// Playwright's own recommended pattern), but every session gets its OWN
// `browser.newContext()` - a fresh, empty cookie jar/localStorage/cache with
// nothing shared across sessions or tasks. A context is closed and disposed
// on session end (closeSession) or expiry (cleanupExpiredSessions), never
// reused for a different session. This is Playwright's own, real isolation
// guarantee, used correctly - not a fabricated one.
//
// The live Playwright objects (Browser/BrowserContext/Page) are ONLY ever
// held in this module's in-memory registry, keyed by BrowserSession.id - the
// Prisma BrowserSession row is metadata only (status/url/timestamps), never
// a serialized session/cookie blob. A process restart loses all live
// contexts; their BrowserSession rows are reconciled by
// reconcileBrowserSessions() (below) on the next watchdog pass - never
// silently assumed still-live just because no error was observed.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { optionalEnv } from "../../config/env";
import { writeAuditLog } from "../../security/audit";
import { WORKER_IDENTITY, identityToActorString } from "../auth/identity";
import { notificationService } from "../notifications";
import { getHeartbeat, isStale } from "../worker/heartbeat";
import { getWorkerConfig } from "../worker/config";

// Phase 10.1 (browser session lifecycle hardening, sections 4-30): wires the
// cleanup path that already existed (cleanupExpiredSessions, below) into the
// worker watchdog (core/worker/watchdog.ts) so an abandoned/orphaned/crashed
// session is reclaimed automatically, not only when a session happens to hit
// its own idle/TTL expiry. Nothing here duplicates that existing mechanism -
// reconcileBrowserSessions() below CALLS cleanupExpiredSessions() as its
// first step and adds: (a) a real atomic-conditional-update transition to
// CLEANING before any provider close is attempted - the exact pattern
// core/worker/claim.ts's claimTask() uses, so two concurrent cleanup callers
// can never both close the same session's provider handle; (b) multi-signal
// orphan detection (task status + owning worker's heartbeat freshness + last
// activity + hard max lifetime, never one weak signal alone); (c) the
// provider-vs-DB reconciliation matrix for CLOSED/CLEANING rows; (d) bounded,
// persisted cleanup-failure retry (mirrors core/worker/watchdog.ts's own
// decideRestart() exponential-backoff-with-cap shape, not a second
// implementation).

// Application-level status enum (SQLite has no enums - same convention as
// Task.status, core/worker/heartbeat.ts's WorkerHeartbeatStatus, etc.).
// CREATED is reserved for a future pre-launch step; this phase's provider
// creates the live context synchronously so sessions are born ACTIVE. IDLE
// is reserved similarly (nothing currently transitions a session to IDLE
// ahead of its idle-timeout reap) - both are accepted, validated values so a
// future phase can use them without another status-set migration.
export const SESSION_STATUSES = [
  "CREATED",
  "ACTIVE",
  "IDLE",
  "CLEANING",
  "EXPIRED",
  "CLOSED",
  "CRASHED",
  "ORPHANED",
  "CLEANUP_FAILED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export function isValidSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

// Statuses a session may be atomically claimed for cleanup FROM. CLEANING
// (already claimed), CLOSED (terminal) and CLEANUP_FAILED (terminal - see
// recordCleanupFailure) are deliberately excluded so the claim below can
// never double-claim or resurrect a terminal row.
const CLEANUP_ELIGIBLE_STATUSES: SessionStatus[] = ["ACTIVE", "IDLE", "ORPHANED", "EXPIRED", "CRASHED"];

// Mirrors Task.status's terminal set (database/schema.prisma's Task model
// comment) - a task in one of these will never claim/touch a browser session
// again.
const TERMINAL_TASK_STATUSES = ["DONE", "FAILED", "CANCELLED"];

// Lazily imported so a machine/test that never touches the browser tool
// never pays Playwright's module-load cost, and so tests that only exercise
// policy logic don't need a real Chromium at all.
type PlaywrightModule = typeof import("playwright");
let playwrightModule: PlaywrightModule | null = null;
async function getPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightModule) {
    playwrightModule = await import("playwright");
  }
  return playwrightModule;
}

// One shared Browser process for the whole worker process - contexts (not
// browsers) are the isolation unit, matching Playwright's documented
// guidance. Launched on first use, never re-launched per session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedBrowser: any | null = null;
async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  const pw = await getPlaywright();
  sharedBrowser = await pw.chromium.launch({ headless: true });
  return sharedBrowser;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface LiveSession {
  context: any;
  page: any;
  extraPages: any[];
}
const liveSessions = new Map<string, LiveSession>();

function config() {
  return {
    sessionTtlMs: parseInt(optionalEnv("BROWSER_SESSION_TTL_MS", String(30 * 60 * 1000)), 10), // 30 min bounded lifetime
    idleTimeoutMs: parseInt(optionalEnv("BROWSER_SESSION_IDLE_TIMEOUT_MS", String(10 * 60 * 1000)), 10), // 10 min idle
  };
}

export interface CreateSessionInput {
  taskId?: string | null;
  createdBy: string;
}

export interface SessionRecord {
  id: string;
  status: string;
  currentUrl: string | null;
  currentDomain: string | null;
  expiresAt: Date;
}

export async function createIsolatedSession(input: CreateSessionInput): Promise<SessionRecord> {
  const { sessionTtlMs } = config();
  const browser = await getSharedBrowser();
  // Fresh, empty context - no storageState passed, so no cookies/localStorage
  // carry over from any other session.
  const context = await browser.newContext();
  const page = await context.newPage();

  const row = await prisma.browserSession.create({
    data: {
      provider: "playwright",
      status: "ACTIVE",
      isolationLevel: "CONTEXT",
      taskId: input.taskId ?? null,
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + sessionTtlMs),
    },
  });

  liveSessions.set(row.id, { context, page, extraPages: [] });
  log("INFO", "browser.session_created", { sessionId: row.id, taskId: input.taskId ?? null });

  return { id: row.id, status: row.status, currentUrl: row.currentUrl, currentDomain: row.currentDomain, expiresAt: row.expiresAt };
}

export function getLiveSession(sessionId: string): LiveSession | null {
  return liveSessions.get(sessionId) ?? null;
}

export async function touchSession(sessionId: string, patch: { currentUrl?: string; currentDomain?: string } = {}): Promise<void> {
  await prisma.browserSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date(), ...patch } })
    .catch(() => undefined);
}

export async function isSessionExpired(sessionId: string): Promise<boolean> {
  const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
  if (!row || row.status !== "ACTIVE") return true;
  const { idleTimeoutMs } = config();
  if (row.expiresAt.getTime() < Date.now()) return true;
  if (Date.now() - row.lastActivityAt.getTime() > idleTimeoutMs) return true;
  return false;
}

export interface CloseResult {
  /** True only if THIS call actually performed the close (won the claim and the provider call succeeded, or it was already CLOSED and this is the idempotent no-op path reported honestly as `alreadyClosed`). */
  closed: boolean;
  /** True if the session was already CLOSED (or CLEANUP_FAILED/being CLEANED by another caller) - a safe no-op, never an exception. */
  alreadyClosedOrInProgress?: boolean;
}

/**
 * THE single authoritative path that ever calls a live Playwright
 * context/page `.close()` (Phase 10.1, sections 12-15, 33). Concurrency-safe
 * by construction: the ACTIVE/IDLE/ORPHANED/EXPIRED/CRASHED -> CLEANING
 * transition is one atomic conditional `prisma.browserSession.updateMany`
 * (mirrors core/worker/claim.ts's claimTask() exactly) - of two concurrent
 * callers racing on the same session id, only one `updateMany` matches the
 * row and proceeds to touch the provider; the loser's `updateMany` matches
 * zero rows and it returns immediately without calling `.close()` a second
 * time. Idempotent: calling this on an already-CLOSED (or already-CLEANING,
 * or CLEANUP_FAILED-terminal) session is a safe no-op, never an exception.
 */
export async function closeSession(sessionId: string, reason = "closed"): Promise<CloseResult> {
  const { count } = await prisma.browserSession.updateMany({
    where: { id: sessionId, status: { in: CLEANUP_ELIGIBLE_STATUSES } },
    data: { status: "CLEANING" },
  });
  if (count === 0) {
    // Either unknown id, already CLOSED, already being cleaned by another
    // (winning) caller, or terminally CLEANUP_FAILED - a safe no-op either
    // way, never a duplicate provider close and never an exception.
    return { closed: false, alreadyClosedOrInProgress: true };
  }

  // Won the claim - this call, and only this call, may touch the provider.
  const live = liveSessions.get(sessionId);
  try {
    if (live) {
      for (const p of live.extraPages) await p.close().catch(() => undefined);
      await live.context.close();
      liveSessions.delete(sessionId);
    }
  } catch (err) {
    await recordCleanupFailure(sessionId, err instanceof Error ? err.message : String(err));
    return { closed: false };
  }

  await prisma.browserSession.updateMany({
    where: { id: sessionId, status: "CLEANING" },
    data: { status: "CLOSED", closedAt: new Date(), closeReason: reason, cleanupAttempts: 0, lastCleanupError: null, nextCleanupRetryAt: null },
  });
  log("INFO", "browser.session_closed", { sessionId, reason });
  await writeAuditLog({
    actor: identityToActorString(WORKER_IDENTITY),
    action: "browser.session_closed",
    target: sessionId,
    meta: { reason },
  }).catch(() => undefined);
  return { closed: true };
}

/**
 * Bounded-retry cleanup-failure bookkeeping (sections 29-30): a provider
 * `.close()` that throws is never silently discarded. Persists
 * session/error/attempt-count/last-attempt/next-retry so this survives a
 * process restart (never held only in memory). Backoff mirrors
 * core/worker/watchdog.ts's decideRestart() shape exactly
 * (`restartBackoffBaseMs * 2^attempts`, capped at `maxRestartAttempts`) -
 * reusing that already-established, tested exponential-backoff-with-cap
 * policy rather than inventing a second one. Once the cap is hit, the
 * session moves to the terminal CLEANUP_FAILED status (a real final-status,
 * never a false CLOSED) and a CRITICAL notification + audit log entry are
 * raised exactly once (mirrors giveUpPermanently()'s pair).
 */
async function recordCleanupFailure(sessionId: string, error: string): Promise<void> {
  const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
  if (!row) return;
  const attempts = row.cleanupAttempts + 1;
  const config = await getWorkerConfig();
  const now = new Date();

  if (attempts >= config.maxRestartAttempts) {
    await prisma.browserSession.updateMany({
      where: { id: sessionId, status: "CLEANING" },
      data: { status: "CLEANUP_FAILED", cleanupAttempts: attempts, lastCleanupError: error, lastCleanupAttemptAt: now, nextCleanupRetryAt: null },
    });
    log("CRITICAL", "browser.session_cleanup_failed_permanently", { sessionId, attempts, error });
    await notificationService
      .create({
        title: `Browser session ${sessionId} could not be cleaned up`,
        body: `${attempts} cleanup attempts failed (last error: ${error}). The underlying Playwright resource may still be alive and needs manual/operator attention.`,
        type: "CRITICAL",
      })
      .catch(() => undefined);
    await writeAuditLog({
      actor: identityToActorString(WORKER_IDENTITY),
      action: "browser.session_cleanup_failed",
      target: sessionId,
      meta: { attempts, error },
    }).catch(() => undefined);
    return;
  }

  const backoffMs = config.restartBackoffBaseMs * 2 ** row.cleanupAttempts;
  // Revert to ORPHANED (still in CLEANUP_ELIGIBLE_STATUSES) so a later
  // reconcileBrowserSessions() pass can re-claim it once nextCleanupRetryAt
  // has passed - never left stuck in CLEANING.
  await prisma.browserSession.updateMany({
    where: { id: sessionId, status: "CLEANING" },
    data: { status: "ORPHANED", cleanupAttempts: attempts, lastCleanupError: error, lastCleanupAttemptAt: now, nextCleanupRetryAt: new Date(Date.now() + backoffMs) },
  });
  log("WARNING", "browser.session_cleanup_retry_scheduled", { sessionId, attempts, backoffMs, error });
}

/**
 * Real cleanup path for abandoned sessions (section 6-7): closes any live
 * Playwright context whose BrowserSession row is expired/idle-timed-out.
 * Intended to be called periodically by the SAME worker/watchdog periodic-
 * tick mechanism Phase 5 already established (core/worker/watchdog.ts) - no
 * new background-process mechanism. This is the routine TTL/idle-timeout
 * pass only; reconcileBrowserSessions() (below) is the fuller pass that ALSO
 * covers orphan/crash detection and the provider-vs-DB reconciliation
 * matrix, and calls this function as its first step.
 */
export async function cleanupExpiredSessions(): Promise<{ closed: number }> {
  const active = await prisma.browserSession.findMany({ where: { status: { in: ["ACTIVE", "IDLE"] } } });
  let closed = 0;
  for (const row of active) {
    const expired = await isSessionExpired(row.id);
    if (expired) {
      const result = await closeSession(row.id, "expired_or_idle_timeout");
      if (result.closed) closed += 1;
    }
  }
  return { closed };
}

/**
 * Provider-vs-DB reconciliation for the two states a routine expiry pass
 * doesn't cover (section 16-17's matrix):
 *  - DB=CLOSED (or otherwise terminal) but a live handle still exists in
 *    THIS process's registry -> a leak; close the live handle directly
 *    (there's no DB claim to win - the DB row is already terminal, so we
 *    just release the resource, never re-open/re-transition the row).
 *  - DB=CLEANING with no live handle in this process -> the process that
 *    held the claim crashed mid-cleanup; per the matrix this resolves to
 *    CLOSED (nothing left to close from this process). DB=CLEANING WITH a
 *    live handle is left alone - that's an in-flight closeSession() call
 *    already running ("continue/retry"), not touched here.
 */
async function reconcileLeaksAndStuckCleaning(): Promise<{ leaksClosed: number; staleCleaningResolved: number }> {
  let leaksClosed = 0;
  for (const sessionId of Array.from(liveSessions.keys())) {
    const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
    if (!row || row.status === "CLOSED" || row.status === "CLEANUP_FAILED") {
      const live = liveSessions.get(sessionId);
      if (live) {
        for (const p of live.extraPages) await p.close().catch(() => undefined);
        await live.context.close().catch(() => undefined);
        liveSessions.delete(sessionId);
        leaksClosed += 1;
        log("WARNING", "browser.session_leak_closed", { sessionId, dbStatus: row?.status ?? "unknown" });
      }
    }
  }

  let staleCleaningResolved = 0;
  const stuckCleaning = await prisma.browserSession.findMany({ where: { status: "CLEANING" } });
  for (const row of stuckCleaning) {
    if (!liveSessions.has(row.id)) {
      const { count } = await prisma.browserSession.updateMany({
        where: { id: row.id, status: "CLEANING" },
        data: { status: "CLOSED", closedAt: new Date(), closeReason: "reconciled_stale_cleaning_no_live_handle" },
      });
      if (count > 0) {
        staleCleaningResolved += 1;
        log("WARNING", "browser.session_stale_cleaning_resolved", { sessionId: row.id });
        await writeAuditLog({
          actor: identityToActorString(WORKER_IDENTITY),
          action: "browser.session_stale_cleaning_resolved",
          target: row.id,
          meta: { note: "CLEANING with no reachable provider handle in this process - resolved to CLOSED per the provider/DB reconciliation matrix." },
        }).catch(() => undefined);
      }
    }
  }
  return { leaksClosed, staleCleaningResolved };
}

interface OrphanSignal {
  orphaned: boolean;
  reason?: string;
}

/**
 * Signal #1 (section 10 - worker restart recovery): the session's owning
 * Task is still IN_PROGRESS and claimed by a worker whose heartbeat has gone
 * stale - i.e. that worker crashed mid-task, taking its browser session down
 * with it. Reuses the EXACT reasoning of core/tasks.recoverUnfinishedTasks()/
 * core/worker/claim.ts's reclaimExpiredTasks(): ownership recovery is
 * decided from persistent DB state (Task.claimedBy + WorkerHeartbeat) alone,
 * never from any single process's in-memory assumption that "it's probably
 * still running".
 */
async function isOrphanedByWorkerCrash(row: { id: string; taskId: string | null }): Promise<OrphanSignal> {
  if (!row.taskId) return { orphaned: false };
  const task = await prisma.task.findUnique({ where: { id: row.taskId } });
  if (!task || task.status !== "IN_PROGRESS" || !task.claimedBy) return { orphaned: false };
  const config = await getWorkerConfig();
  const heartbeat = await getHeartbeat(task.claimedBy);
  const stale = !heartbeat || isStale(heartbeat, config.heartbeatTimeoutMs);
  if (!stale) return { orphaned: false };
  return {
    orphaned: true,
    reason: `Session ${row.id}'s owning task ${task.id} is still IN_PROGRESS, claimed by worker "${task.claimedBy}" whose heartbeat is stale (>${config.heartbeatTimeoutMs}ms) - the worker crashed mid-task, orphaning this browser session.`,
  };
}

/**
 * Signal #2 (sections 8-9 - active-task protection + orphan detection): a
 * session only counts as abandoned when MULTIPLE corroborating signals agree
 * - idle past the configured timeout AND (its task is terminal, or it has no
 * task at all) AND (no worker currently holds a live claim on that task, or
 * that worker's heartbeat is stale). "Session looks idle" alone is
 * deliberately NOT sufficient - a session backing a task that is still
 * legitimately IN_PROGRESS with a fresh worker heartbeat is left alone here
 * (protected), even past its idle window, so an in-progress operation can
 * finish where safely possible. (Hard max lifetime is a separate, absolute
 * override applied by the caller - reconcileBrowserSessions() - regardless
 * of this function's result.)
 */
async function isOrphanedByAbandonment(row: { id: string; taskId: string | null; lastActivityAt: Date }): Promise<OrphanSignal> {
  const { idleTimeoutMs } = config();
  const idleMs = Date.now() - row.lastActivityAt.getTime();
  if (idleMs <= idleTimeoutMs) return { orphaned: false };

  let taskTerminal = true;
  let noLiveWorkerClaim = true;
  if (row.taskId) {
    const task = await prisma.task.findUnique({ where: { id: row.taskId } });
    if (task) {
      taskTerminal = TERMINAL_TASK_STATUSES.includes(task.status);
      if (!taskTerminal && task.claimedBy) {
        const workerConfig = await getWorkerConfig();
        const heartbeat = await getHeartbeat(task.claimedBy);
        noLiveWorkerClaim = !heartbeat || isStale(heartbeat, workerConfig.heartbeatTimeoutMs);
      }
    }
  }

  if (!taskTerminal && !noLiveWorkerClaim) return { orphaned: false }; // active-task protection
  return {
    orphaned: true,
    reason: `Session ${row.id} idle for ${idleMs}ms (> ${idleTimeoutMs}ms) and its owning task is ${row.taskId ? "terminal or unclaimed by any live worker" : "absent"} - abandoned, not merely idle.`,
  };
}

export interface ReconcileReport {
  /** Sessions actually moved to CLOSED by this pass (routine expiry + orphan reaps + resolved stale-CLEANING rows). */
  closed: number;
  /** Sessions identified as orphaned/crashed/lifetime-exceeded this pass (a subset attempted cleanup; see `closed`/`cleanupFailed`). */
  orphansDetected: number;
  /** Sessions that hit the bounded retry cap and moved to the terminal CLEANUP_FAILED status this pass. */
  cleanupFailed: number;
  /** Live Playwright handles closed for sessions whose DB row was already terminal (leaked resource release). */
  leaksClosed: number;
  /** CLEANING rows with no reachable provider handle in this process, resolved to CLOSED. */
  staleCleaningResolved: number;
  reasons: string[];
}

/**
 * THE watchdog-facing entry point (Phase 10.1, section 11 - the anchor
 * requirement): identifies stale/orphaned/expired/crashed sessions, attempts
 * cleanup via closeSession() (the one authoritative provider-close path,
 * above), and reports what happened so core/worker/watchdog.ts can surface a
 * real WatchdogFinding. Never gated on system state (core/state) - matching
 * the existing watchdog's own precedent (runWatchdogChecks() has never
 * checked system state) and the explicit requirement that cleanup remain
 * allowed during PAUSED/EMERGENCY_STOP even though NEW browser actions are
 * blocked elsewhere (core/enforcement, unchanged by this phase).
 */
export async function reconcileBrowserSessions(): Promise<ReconcileReport> {
  const { closed: routineClosed } = await cleanupExpiredSessions();
  const { leaksClosed, staleCleaningResolved } = await reconcileLeaksAndStuckCleaning();

  const now = Date.now();
  const candidates = await prisma.browserSession.findMany({
    where: { status: { in: ["ACTIVE", "IDLE", "ORPHANED", "CRASHED", "EXPIRED"] } },
  });

  let orphansDetected = 0;
  let orphansClosed = 0;
  let cleanupFailed = 0;
  const reasons: string[] = [];

  for (const row of candidates) {
    // Bounded-retry backoff gate (section 29-30): a session already scheduled
    // for a later retry is left alone until its window arrives - never
    // hammered every watchdog pass.
    if (row.nextCleanupRetryAt && row.nextCleanupRetryAt.getTime() > now) continue;

    const lifetimeExceeded = row.expiresAt.getTime() < now;
    const providerMissing = !liveSessions.has(row.id);

    let reason: string | null = null;
    let closeReason = "orphan_reclaimed";

    if (lifetimeExceeded) {
      // Absolute override (section 8's explicit last-line instruction): a
      // session that has been alive too long is reaped even if it currently
      // looks "active" - no task/worker signal can protect it from this.
      reason = `Session ${row.id} exceeded its hard max lifetime (expiresAt ${row.expiresAt.toISOString()}) - reaped regardless of activity.`;
      closeReason = "max_lifetime_exceeded";
    } else if (providerMissing) {
      // Strongest possible signal on its own (section 16-18): no reachable
      // handle in THIS process is real evidence the resource is gone (or was
      // never this process's to begin with, e.g. after a restart) - resolves
      // to CRASHED/ORPHANED, never silently assumed still-active.
      reason = `Session ${row.id} has no reachable Playwright handle in this process (provider crashed, or this is a fresh process after a restart - core/browser/session.ts's in-process registry is a cache, never authoritative).`;
      closeReason = "provider_crashed";
    } else {
      const crash = await isOrphanedByWorkerCrash(row);
      if (crash.orphaned) {
        reason = crash.reason ?? null;
        closeReason = "owning_worker_crashed";
      } else {
        const abandonment = await isOrphanedByAbandonment(row);
        if (abandonment.orphaned) {
          reason = abandonment.reason ?? null;
          closeReason = "abandoned_idle_task_terminal";
        }
      }
    }

    if (!reason) continue; // active-task protection: multiple signals disagree, leave it alone

    orphansDetected += 1;
    reasons.push(reason);
    log("WARNING", "browser.session_orphan_detected", { sessionId: row.id, reason, closeReason });

    const result = await closeSession(row.id, closeReason);
    if (result.closed) {
      orphansClosed += 1;
      continue;
    }
    const fresh = await prisma.browserSession.findUnique({ where: { id: row.id } });
    if (fresh?.status === "CLEANUP_FAILED") cleanupFailed += 1;
  }

  return {
    closed: routineClosed + leaksClosed + staleCleaningResolved + orphansClosed,
    orphansDetected,
    cleanupFailed,
    leaksClosed,
    staleCleaningResolved,
    reasons,
  };
}

/**
 * Test-only fault injection: makes the next provider `.close()` call(s) for
 * `sessionId` throw, so the bounded cleanup-failure retry path (sections
 * 29-30) can be tested deterministically without relying on a real
 * Playwright failure. Does nothing if the session has no live handle.
 */
export function __injectCloseFailureForTests(sessionId: string, message = "simulated provider close failure"): void {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  live.context.close = async () => {
    throw new Error(message);
  };
}

/** Test-only: closes the shared browser process entirely. */
export async function _shutdownForTests(): Promise<void> {
  // Force-closes every live handle directly (bypassing closeSession()'s
  // DB-status claim gate on purpose - a test-only full shutdown must not
  // leak a live handle just because a test left its DB row in CLEANING/
  // CLEANUP_FAILED/some other non-eligible state).
  for (const sessionId of Array.from(liveSessions.keys())) {
    const live = liveSessions.get(sessionId);
    if (live) {
      for (const p of live.extraPages) await p.close().catch(() => undefined);
      await live.context.close().catch(() => undefined);
    }
    liveSessions.delete(sessionId);
    await prisma.browserSession
      .updateMany({ where: { id: sessionId, status: { notIn: ["CLOSED"] } }, data: { status: "CLOSED", closedAt: new Date(), closeReason: "test_shutdown" } })
      .catch(() => undefined);
  }
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = null;
  }
}
