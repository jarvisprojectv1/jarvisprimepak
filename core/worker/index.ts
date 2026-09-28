// core/worker/index.ts - the Autonomous Worker loop (Phase 5).
//
// Loop, per tick: refresh heartbeat -> check system state -> select eligible
// task(s) (up to maxWorkers concurrent slots) -> claim (DB-backed) -> execute
// (through the SAME guarded tools/registry.execute() / agents/registry.run()
// / core/brain.handle() every other caller uses - never a bypass) -> update
// task status/reason -> release claim -> emit a TASK event -> repeat.
//
// This is an IN-PROCESS interval, started at API boot alongside
// recoverUnfinishedTasks() (apps/api/src/index.ts) - it keeps running for as
// long as the Node process is alive, not tied to any single HTTP request.
// Being honest about what that means: "continues after the dashboard is
// closed" is true (the dashboard is just a browser tab; closing it does not
// touch this process), but this is NOT a separate OS-level daemon - if the
// API process itself stops, the worker stops with it. A real always-on
// daemon would need a process supervisor (systemd, pm2, a container
// restart policy, ...), which is outside this stack - see
// docs/PHASE5_AUTONOMOUS_WORKER.md.
import { toolRegistry } from "../../tools/registry";
import { getAgent } from "../../agents/registry";
import { brain } from "../brain";
import { getSystemState } from "../state";
import { getLimitsConfig } from "../limits";
import { updateTaskStatus, retryOrFailTask, type PlannedTask, type TaskStatus } from "../planner";
import { publish } from "../events";
import { isTaskEligible } from "./eligibility";
import { claimTask, releaseClaim, reclaimExpiredTasks } from "./claim";
import { selectCandidateTasks, selectStaleWaitingOrBlocked } from "./queue";
import { initHeartbeat, beat, getHeartbeat } from "./heartbeat";
import { getWorkerConfig, type WorkerConfig } from "./config";
import { runWatchdogChecks, decideRestart, giveUpPermanently, reportFindings, starvationFinding } from "./watchdog";
import { WORKER_IDENTITY, identityToActorString } from "../auth/identity";
import { writeAuditLog } from "../../security/audit";
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export interface TaskOutcome {
  taskId: string;
  status: TaskStatus;
  detail: string;
}

async function markTerminal(
  task: PlannedTask,
  status: Exclude<TaskStatus, "RETRYING">,
  reason: string,
  retryLimit: number
): Promise<TaskOutcome> {
  if (status === "FAILED") {
    const updated = await retryOrFailTask(task.id, retryLimit, reason);
    return { taskId: task.id, status: updated.status, detail: reason };
  }
  await updateTaskStatus(task.id, status, status === "WAITING" || status === "BLOCKED" ? reason : undefined);
  return { taskId: task.id, status, detail: reason };
}

/**
 * Executes one already-claimed, top-level task. A task tagged with a
 * toolName/agentName (e.g. from a ConditionRule like the daily-report job)
 * is called DIRECTLY through the same guarded registry every other caller
 * uses. A plain task with neither tag is delegated to the Brain (which plans
 * and executes its OWN task tree for the request) - the original trigger
 * task is then marked DONE/WAITING/BLOCKED/FAILED to reflect the Brain's
 * real, honest outcome, never a fabricated success. See
 * docs/PHASE5_AUTONOMOUS_WORKER.md "worker scope" for why this doesn't
 * re-run Brain-plan subtasks (those already ran inside runPlan()).
 */
export async function processClaimedTask(task: PlannedTask, retryLimit: number): Promise<TaskOutcome> {
  try {
    if (task.toolName) {
      // Phase 7.1 hardening: pass the task's own id through as `taskId` (was
      // an unconditional `{}` before - every existing toolName-tagged tool,
      // e.g. tools/reports.ts, ignores unknown input keys, so this is
      // additive). This lets a tool derive task-specific context it has no
      // other way to reach here - e.g. tools/email/emailTool.ts looks up a
      // FollowUp row by taskId for a follow-up dispatch task, still going
      // through this exact same guarded call.
      const result = await toolRegistry.execute(task.toolName, { taskId: task.id }, WORKER_IDENTITY);
      if (result.status === "OK") return markTerminal(task, "DONE", result.message, retryLimit);
      if (result.status === "NOT_IMPLEMENTED" || result.status === "CONFIGURATION_REQUIRED") {
        return markTerminal(task, "WAITING", `Tool "${task.toolName}" not usable yet: ${result.message}`, retryLimit);
      }
      if (result.status === "BLOCKED") return markTerminal(task, "BLOCKED", result.message, retryLimit);
      return markTerminal(task, "FAILED", result.message, retryLimit);
    }

    if (task.agentName) {
      const agent = getAgent(task.agentName);
      if (!agent) return markTerminal(task, "FAILED", `Agent "${task.agentName}" is not registered.`, retryLimit);
      const result = await agent.run({}, WORKER_IDENTITY);
      if (result.status === "SUCCESS") return markTerminal(task, "DONE", result.summary, retryLimit);
      if (result.status === "NOT_IMPLEMENTED" || result.status === "WAITING") return markTerminal(task, "WAITING", result.summary, retryLimit);
      return markTerminal(task, "FAILED", result.summary, retryLimit);
    }

    // Generic task: delegate to the Brain, attaching its plan directly under
    // THIS task (rootTaskId) - core/planner.planFromPlan creates the plan's
    // step-subtasks with parentId = task.id instead of a second, unrelated
    // parent task, so the trigger task and the executed plan are one real,
    // queryable Task tree (hardening pass - see docs/PHASE5_AUTONOMOUS_WORKER.md
    // "known limitations" for the gap this closes).
    const brainResult = await brain.handle(
      { message: `${task.title}${task.description ? `\n\n${task.description}` : ""}` },
      WORKER_IDENTITY,
      { rootTaskId: task.id }
    );
    const detail = `Delegated to Brain (task ${brainResult.taskId ?? "n/a"}): ${brainResult.reply}`;
    switch (brainResult.status) {
      case "SUCCESS":
      case "PARTIAL":
        return markTerminal(task, "DONE", detail, retryLimit);
      case "BLOCKED":
        return markTerminal(task, "BLOCKED", detail, retryLimit);
      case "WAITING":
      case "REQUIRES_INFORMATION":
      case "REQUIRES_TOOL":
        return markTerminal(task, "WAITING", detail, retryLimit);
      default:
        return markTerminal(task, "FAILED", detail, retryLimit);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return markTerminal(task, "FAILED", message, retryLimit);
  }
}

export class Worker {
  private tickTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private ticksSinceProgress = 0;
  private activeSlots = new Set<Promise<void>>();

  constructor(public readonly workerId: string = "worker-1") {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await initHeartbeat(this.workerId);

    const config = await getWorkerConfig();
    this.heartbeatTimer = setInterval(() => {
      beat(this.workerId).catch((err) => log("ERROR", "worker.heartbeat_failed", { error: String(err) }));
    }, config.heartbeatIntervalMs);

    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => log("ERROR", "worker.tick_failed", { error: err instanceof Error ? err.message : String(err) }));
    }, config.tickIntervalMs);

    log("INFO", "worker.started", { workerId: this.workerId, config });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = undefined;
    this.heartbeatTimer = undefined;
    await beat(this.workerId, { status: "STOPPED", currentTaskId: null });
    log("INFO", "worker.stopped", { workerId: this.workerId });
  }

  /** One loop iteration. Exposed for tests so the interval timing doesn't need to be awaited. */
  async tick(): Promise<{ processed: number }> {
    const config = await getWorkerConfig();

    // Crash recovery for worker-claimed in-flight tasks (#6/#7), run every
    // tick - cheap (indexed query, usually zero rows).
    await reclaimExpiredTasks();

    const state = await getSystemState();
    if (state.state !== "RUNNING") {
      await beat(this.workerId, { status: "IDLE", currentTaskId: null });
      return { processed: 0 };
    }

    // Backoff re-check of stale WAITING/BLOCKED tasks (#2's "never hammer" requirement).
    await this.recheckStaleTasks(config);

    const candidates = await selectCandidateTasks();
    let processed = 0;

    for (const candidate of candidates) {
      if (this.activeSlots.size >= config.maxWorkers) break;

      const eligibility = await isTaskEligible(candidate);
      if (!eligibility.eligible) {
        if (eligibility.category === "WAITING" || eligibility.category === "BLOCKED") {
          await updateTaskStatus(candidate.id, eligibility.category, eligibility.reason);
          await prisma.task.update({ where: { id: candidate.id }, data: { lastEligibilityCheckAt: new Date() } });
        }
        continue;
      }

      const claim = await claimTask(candidate.id, this.workerId, config.claimTimeoutMs);
      if (!claim.claimed || !claim.task) continue;

      processed += 1;
      const slot = this.runSlot(claim.task, config);
      this.activeSlots.add(slot);
      slot.finally(() => this.activeSlots.delete(slot));
    }

    this.ticksSinceProgress = processed > 0 ? 0 : this.ticksSinceProgress + 1;

    const pendingCount = candidates.length;
    const starvation = starvationFinding(this.ticksSinceProgress, config.starvationTicks, pendingCount);
    if (starvation) {
      await reportFindings(this.workerId, [starvation]);
    }

    await beat(this.workerId, { status: this.activeSlots.size > 0 ? "RUNNING" : "IDLE", currentTaskId: null });
    return { processed };
  }

  private async recheckStaleTasks(config: WorkerConfig): Promise<void> {
    const stale = await selectStaleWaitingOrBlocked(config.recheckCooldownMs, config.recheckBatchSize);
    for (const task of stale) {
      // A WAITING/BLOCKED task is never directly re-selected by
      // selectCandidateTasks() (its status excludes it) - this promotes it
      // back to PENDING only if its blocker has genuinely cleared, so the
      // NEXT tick's candidate scan can pick it up normally.
      const wouldBeEligibleIfPending: PlannedTask = { ...task, status: "PENDING", retryCount: task.retryCount };
      const result = await isTaskEligible(wouldBeEligibleIfPending);
      if (result.eligible) {
        await updateTaskStatus(task.id, "PENDING");
        log("INFO", "worker.task_unblocked", { taskId: task.id });
      } else {
        await prisma.task.update({
          where: { id: task.id },
          data: { lastEligibilityCheckAt: new Date(), ...(result.reason ? { [task.status === "WAITING" ? "waitingReason" : "blockedReason"]: result.reason } : {}) },
        });
      }
    }
  }

  private async runSlot(task: PlannedTask, config: WorkerConfig): Promise<void> {
    await beat(this.workerId, { status: "RUNNING", currentTaskId: task.id });
    const limits = await getLimitsConfig();
    log("ACTION", "worker.task_start", { workerId: this.workerId, taskId: task.id, title: task.title });

    // Audit trail: target = the task id, same convention runPlan's per-step
    // entries and spawn's rejection entries use, so the root task's own
    // claim/outcome events are queryable alongside its now-real children's
    // step-outcome entries via one AuditLog query filtered by task id(s).
    await writeAuditLog({
      actor: identityToActorString(WORKER_IDENTITY),
      action: "worker.task_claimed",
      target: task.id,
      meta: { title: task.title, toolName: task.toolName, agentName: task.agentName },
    });

    const outcome = await processClaimedTask(task, limits.retryLimit);
    await releaseClaim(task.id, this.workerId);

    await writeAuditLog({
      actor: identityToActorString(WORKER_IDENTITY),
      action: "worker.task_outcome",
      target: task.id,
      meta: { status: outcome.status, detail: outcome.detail },
    });

    await publish({
      type: "TASK.worker_outcome",
      payload: { taskId: outcome.taskId, status: outcome.status },
      source: `worker:${this.workerId}`,
    }).catch((err) => log("WARNING", "worker.event_publish_failed", { error: String(err) }));

    const succeeded = outcome.status === "DONE";
    await beat(this.workerId, {
      status: "IDLE",
      currentTaskId: null,
      incrementProcessed: succeeded,
      incrementFailed: !succeeded && (outcome.status === "FAILED" || outcome.status === "BLOCKED"),
    });

    log("ACTION", "worker.task_done", { workerId: this.workerId, taskId: task.id, status: outcome.status });
  }

  /**
   * Watchdog pass: checks this worker's own heartbeat/health, and if it
   * finds a heartbeat timeout AND the process is still alive (i.e. this very
   * function is running), attempts a bounded, backed-off restart of the tick
   * loop. Meant to be invoked from a SEPARATE timer (see
   * apps/api/src/index.ts) - a worker cannot watch its own dead interval.
   */
  async watchdogPass(): Promise<void> {
    const findings = await runWatchdogChecks(this.workerId);
    const heartbeatFinding = findings.find((f) => f.kind === "HEARTBEAT_TIMEOUT");

    if (heartbeatFinding) {
      const config = await getWorkerConfig();
      const decision = decideRestart(this.workerId, config);
      if (decision.giveUp) {
        await giveUpPermanently(this.workerId, `${heartbeatFinding.detail} ${decision.reason}`);
        return;
      }
      if (decision.shouldRestart) {
        log("WARNING", "worker.watchdog_restarting", { workerId: this.workerId, reason: decision.reason });
        await writeAuditLog({
          actor: identityToActorString(WORKER_IDENTITY),
          action: "worker.watchdog_restart",
          target: this.workerId,
          meta: { reason: decision.reason, finding: heartbeatFinding.detail },
        });
        await beat(this.workerId, { incrementRestart: true });
        await this.stop();
        await this.start();
      }
    }

    const otherFindings = findings.filter((f) => f.kind !== "HEARTBEAT_TIMEOUT");
    if (otherFindings.length > 0) {
      await reportFindings(this.workerId, otherFindings);
    }
  }
}

export const worker = new Worker();

export { isTaskEligible } from "./eligibility";
export { claimTask, releaseClaim, reclaimExpiredTasks } from "./claim";
export { spawnChildTask } from "./spawn";
export { getWorkerConfig, setWorkerConfig, DEFAULT_WORKER_CONFIG } from "./config";
export { getHeartbeat, listHeartbeats } from "./heartbeat";
export { runWatchdogChecks } from "./watchdog";
