// core/worker/watchdog.ts - Worker Watchdog (Phase 5 / Autonomous Worker,
// requirement #5).
//
// Detects: heartbeat timeout (worker stopped unexpectedly), repeated
// failures (failedTasks growing faster than processedTasks), task starvation
// (eligible tasks exist but nothing got processed for N ticks), queue growth
// (pending task count trending up unboundedly), and excessive retries (a
// specific task's retryCount at/near its limit repeatedly). It can restart
// the worker loop if it's in a recoverable state (the interval died but the
// process is alive), with exponential backoff and a hard cap on attempts
// within a time window - never an infinite restart loop. Every automatic
// stop (the cap being hit) produces BOTH an audit log entry AND a
// notification (requirement #15).
import { prisma } from "../../database/client";
import { getHeartbeat, isStale, type WorkerHeartbeatRecord } from "./heartbeat";
import { getWorkerConfig } from "./config";
import { notificationService } from "../notifications";
import { writeAuditLog } from "../../security/audit";
import { WORKER_IDENTITY, identityToActorString } from "../auth/identity";
import { log } from "../../security/logger";
import { reconcileBrowserSessions } from "../browser/session";

export type WatchdogFindingKind =
  | "HEARTBEAT_TIMEOUT"
  | "REPEATED_FAILURES"
  | "TASK_STARVATION"
  | "QUEUE_GROWTH"
  | "EXCESSIVE_RETRIES"
  | "ORPHANED_BROWSER_SESSIONS";

export interface WatchdogFinding {
  kind: WatchdogFindingKind;
  detail: string;
}

/**
 * Pure(ish) diagnostics for everything EXCEPT the browser-session check
 * below - no restart side effects. Used both by the watchdog loop and by
 * GET /system/health.
 *
 * Phase 10.1 exception, explicit and deliberate: the browser-session-health
 * check IS side-effecting - it calls reconcileBrowserSessions() (
 * core/browser/session.ts), which actually claims and closes
 * orphaned/expired/crashed sessions, not just reports on them. This matches
 * the disclosed Phase 10 gap this sub-phase closes ("cleanup exists but
 * isn't wired into the watchdog") - the fix IS wiring real cleanup into this
 * function, not just adding another read-only finding. It is intentionally
 * NEVER gated on core/state's system state here (this function has never
 * checked system state, for any finding) - cleanup must keep running during
 * PAUSED/EMERGENCY_STOP even though core/enforcement already blocks NEW
 * browser tool actions elsewhere, unchanged by this phase.
 */
export async function runWatchdogChecks(workerId: string): Promise<WatchdogFinding[]> {
  const config = await getWorkerConfig();
  const findings: WatchdogFinding[] = [];

  const heartbeat = await getHeartbeat(workerId);
  if (!heartbeat) {
    findings.push({ kind: "HEARTBEAT_TIMEOUT", detail: `No heartbeat row for worker "${workerId}" yet.` });
  } else if (heartbeat.status !== "STOPPED" && isStale(heartbeat, config.heartbeatTimeoutMs)) {
    findings.push({
      kind: "HEARTBEAT_TIMEOUT",
      detail: `Last heartbeat at ${heartbeat.lastHeartbeat.toISOString()}, over ${config.heartbeatTimeoutMs}ms ago.`,
    });
  }

  if (heartbeat && heartbeat.processedTasks + heartbeat.failedTasks >= 5) {
    const failureRatio = heartbeat.failedTasks / (heartbeat.processedTasks + heartbeat.failedTasks);
    if (failureRatio > 0.5) {
      findings.push({
        kind: "REPEATED_FAILURES",
        detail: `${heartbeat.failedTasks}/${heartbeat.processedTasks + heartbeat.failedTasks} recent tasks failed (>50%).`,
      });
    }
  }

  const pendingCount = await prisma.task.count({
    where: { status: { in: ["PENDING", "QUEUED", "RETRYING"] }, parentId: null, stepId: null },
  });
  if (pendingCount > 200) {
    findings.push({
      kind: "QUEUE_GROWTH",
      detail: `${pendingCount} tasks are pending/queued/retrying - unboundedly growing backlog.`,
    });
  }

  const nearLimitRetries = await prisma.task.count({
    where: { status: "RETRYING", retryCount: { gte: 2 } },
  });
  if (nearLimitRetries > 0) {
    findings.push({
      kind: "EXCESSIVE_RETRIES",
      detail: `${nearLimitRetries} task(s) are RETRYING at/near the retry limit.`,
    });
  }

  // Phase 10.1: real browser-session cleanup, wired into the watchdog (the
  // anchor requirement this sub-phase closes). Only reported as a finding
  // when something notable actually happened - genuine orphans/crashes
  // detected, or a cleanup permanently failed - never for a routine
  // idle/TTL-expiry close (those are expected, frequent, and not
  // watchdog-worthy; see reportFindings()'s notification, which fires for
  // ANY non-empty findings list, so a routine close must not land here).
  try {
    const browserReport = await reconcileBrowserSessions();
    if (browserReport.orphansDetected > 0 || browserReport.cleanupFailed > 0) {
      findings.push({
        kind: "ORPHANED_BROWSER_SESSIONS",
        detail: `${browserReport.orphansDetected} orphaned/crashed/expired browser session(s) detected this pass (${browserReport.closed} closed, ${browserReport.cleanupFailed} cleanup-failed). ${browserReport.reasons.slice(0, 5).join(" | ")}`,
      });
    }
  } catch (err) {
    log("ERROR", "worker.watchdog_browser_reconcile_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return findings;
}

/** Task starvation: eligible-looking tasks exist, but the worker's own tick counter shows no progress for `starvationTicks` ticks in a row. Tracked by the caller (core/worker/index.ts), reported here for a single, shared shape. */
export function starvationFinding(ticksWithNoProgress: number, threshold: number, pendingCount: number): WatchdogFinding | null {
  if (ticksWithNoProgress >= threshold && pendingCount > 0) {
    return {
      kind: "TASK_STARVATION",
      detail: `${pendingCount} pending task(s) but no task was processed in the last ${ticksWithNoProgress} ticks.`,
    };
  }
  return null;
}

export interface RestartDecision {
  shouldRestart: boolean;
  reason: string;
  giveUp: boolean;
}

interface RestartAttempt {
  at: number;
}

const restartHistory = new Map<string, RestartAttempt[]>();

/** Test-only: resets in-process restart-attempt history. */
export function __resetWatchdogForTests(): void {
  restartHistory.clear();
}

/**
 * Decides whether a heartbeat-timeout finding warrants a restart attempt,
 * enforcing exponential backoff and a hard cap on attempts within
 * `restartWindowMs`. Once the cap is hit within the window, `giveUp: true` is
 * returned exactly once per breach and the caller (core/worker/index.ts)
 * must mark the heartbeat CRASHED and raise the CRITICAL
 * notification/audit-log pair - this function does not do that itself, it
 * only decides.
 */
export function decideRestart(workerId: string, config: { maxRestartAttempts: number; restartWindowMs: number; restartBackoffBaseMs: number }, now = Date.now()): RestartDecision {
  const history = (restartHistory.get(workerId) ?? []).filter((a) => now - a.at < config.restartWindowMs);

  if (history.length >= config.maxRestartAttempts) {
    restartHistory.set(workerId, history);
    return { shouldRestart: false, giveUp: true, reason: `Hard cap of ${config.maxRestartAttempts} restart attempts reached within ${config.restartWindowMs}ms.` };
  }

  const backoffMs = config.restartBackoffBaseMs * 2 ** history.length;
  const lastAttempt = history[history.length - 1];
  if (lastAttempt && now - lastAttempt.at < backoffMs) {
    return { shouldRestart: false, giveUp: false, reason: `Backing off ${backoffMs}ms since last restart attempt.` };
  }

  history.push({ at: now });
  restartHistory.set(workerId, history);
  return { shouldRestart: true, giveUp: false, reason: `Restart attempt ${history.length}/${config.maxRestartAttempts}.` };
}

/** The "giving up permanently" path: CRASHED heartbeat + CRITICAL notification + audit log entry (requirement #15). */
export async function giveUpPermanently(workerId: string, reason: string): Promise<void> {
  const { beat } = await import("./heartbeat");
  await beat(workerId, { status: "CRASHED" });
  log("CRITICAL", "worker.watchdog_gave_up", { workerId, reason });
  await notificationService.create({
    title: `JARVIS worker "${workerId}" has stopped and could not be restarted`,
    body: reason,
    type: "CRITICAL",
  });
  await writeAuditLog({
    actor: identityToActorString(WORKER_IDENTITY),
    action: "worker.watchdog_gave_up",
    target: workerId,
    meta: { reason },
  });
}

export async function reportFindings(workerId: string, findings: WatchdogFinding[]): Promise<void> {
  for (const finding of findings) {
    log("WARNING", `worker.watchdog_finding:${finding.kind}`, { workerId, detail: finding.detail });
  }
  if (findings.length > 0) {
    await notificationService.create({
      title: `JARVIS worker watchdog: ${findings.length} finding(s)`,
      body: findings.map((f) => `${f.kind}: ${f.detail}`).join("\n"),
      type: "WARNING",
    });
  }
}

export type { WorkerHeartbeatRecord };
