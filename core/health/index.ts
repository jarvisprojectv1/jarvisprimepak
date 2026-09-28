// core/health - System Health checks (Phase 3 / Identity & Events).
//
// Each check returns HEALTHY | DEGRADED | FAILED | UNKNOWN with a short,
// non-sensitive reason - never a stack trace, file path beyond what's
// already non-sensitive, or env value. GET /system/health aggregates all
// checks (see apps/api/src/routes/system.ts): FAILED if any check FAILED,
// else DEGRADED if any DEGRADED, else HEALTHY.
import os from "node:os";
import fs from "node:fs/promises";
import { prisma } from "../../database/client";
import { scheduler } from "../../scheduler";
import { toolRegistry } from "../../tools/registry";
import { listAgents } from "../../agents/registry";
import { Memory } from "../memory";
import { publish, subscribe } from "../events";
import { appConfig } from "../../config/env";
import { getHeartbeat, isStale } from "../worker/heartbeat";
import { getWorkerConfig } from "../worker/config";
import { summarizeProviders } from "../../config/providers";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "FAILED" | "UNKNOWN";

export interface ComponentHealth {
  status: HealthStatus;
  reason: string;
}

export interface SystemHealthReport {
  status: HealthStatus;
  components: Record<string, ComponentHealth>;
  checkedAt: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function checkApi(): Promise<ComponentHealth> {
  // Trivially "self" - if this code is running, the API process is up.
  return { status: "HEALTHY", reason: "API process is running." };
}

async function checkDatabase(): Promise<ComponentHealth> {
  try {
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1"), 2000);
    return { status: "HEALTHY", reason: "Database responded to SELECT 1." };
  } catch (err) {
    return { status: "FAILED", reason: "Database did not respond in time." };
  }
}

async function checkScheduler(): Promise<ComponentHealth> {
  const expectedJobs = ["daily-heartbeat", "hourly-stale-lead-check", "morning-briefing", "daily-report"];
  const running = expectedJobs.filter((name) => scheduler.isRunning(name));
  if (running.length === expectedJobs.length) {
    return { status: "HEALTHY", reason: `All ${expectedJobs.length} expected cron jobs are running.` };
  }
  if (running.length === 0) {
    return { status: "FAILED", reason: "No expected cron jobs are running." };
  }
  return { status: "DEGRADED", reason: `${running.length}/${expectedJobs.length} expected cron jobs are running.` };
}

async function checkEventBus(): Promise<ComponentHealth> {
  try {
    let received = false;
    const unsubscribe = subscribe("SYSTEM.health_check", () => {
      received = true;
    });
    await publish({ type: "SYSTEM.health_check", payload: {}, source: "health" });
    unsubscribe();
    return received
      ? { status: "HEALTHY", reason: "Publish + subscribe round-trip succeeded." }
      : { status: "DEGRADED", reason: "Event published but handler did not run synchronously." };
  } catch {
    return { status: "FAILED", reason: "Event bus publish failed." };
  }
}

async function checkTaskQueue(): Promise<ComponentHealth> {
  try {
    const total = await prisma.task.count({ where: { status: { in: ["IN_PROGRESS", "RETRYING"] } } });
    if (total > 100) return { status: "DEGRADED", reason: `${total} tasks are IN_PROGRESS/RETRYING - unusually high.` };
    return { status: "HEALTHY", reason: `${total} tasks currently IN_PROGRESS/RETRYING.` };
  } catch {
    return { status: "UNKNOWN", reason: "Could not query the task queue." };
  }
}

async function checkAgents(): Promise<ComponentHealth> {
  try {
    // "Stuck" agents: rows in agent_runs still RUNNING with no endedAt for
    // an unreasonable time (30 minutes). A real deadline-tracking mechanism
    // per agent run is future work.
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const stuck = await prisma.agentRun.count({
      where: { status: "RUNNING", startedAt: { lt: staleThreshold } },
    });
    if (stuck > 0) {
      return { status: "DEGRADED", reason: `${stuck} agent run(s) have been RUNNING for over 30 minutes.` };
    }
    return { status: "HEALTHY", reason: `${listAgents().length} agent(s) registered, none stuck.` };
  } catch {
    return { status: "UNKNOWN", reason: "Could not query agent runs." };
  }
}

async function checkToolRegistry(): Promise<ComponentHealth> {
  const count = toolRegistry.list().length;
  if (count === 0) return { status: "FAILED", reason: "No tools are registered." };
  return { status: "HEALTHY", reason: `${count} tool(s) registered.` };
}

async function checkMemory(): Promise<ComponentHealth> {
  try {
    await withTimeout(Memory.search({ limit: 1 }), 2000);
    return { status: "HEALTHY", reason: "Memory search round-trip succeeded." };
  } catch {
    return { status: "FAILED", reason: "Memory search did not respond in time." };
  }
}

async function checkDisk(): Promise<ComponentHealth> {
  try {
    // fs.statfs is available on Node 18.15+/20+; if it throws (unsupported
    // platform/sandbox), we honestly report UNKNOWN rather than a fabricated
    // number.
    const stats = await (fs as any).statfs?.(appConfig.sandboxDir);
    if (!stats) return { status: "UNKNOWN", reason: "Disk usage is not available on this platform." };
    const freeBytes = stats.bfree * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 1;
    if (freeRatio < 0.05) return { status: "DEGRADED", reason: `Only ${(freeRatio * 100).toFixed(1)}% disk free.` };
    return { status: "HEALTHY", reason: `${(freeRatio * 100).toFixed(1)}% disk free.` };
  } catch {
    return { status: "UNKNOWN", reason: "Could not read disk usage in this environment." };
  }
}

async function checkResources(): Promise<ComponentHealth> {
  const load = os.loadavg()[0];
  const cpuCount = os.cpus().length || 1;
  const mem = process.memoryUsage();
  const loadRatio = load / cpuCount;
  if (loadRatio > 4) {
    return {
      status: "DEGRADED",
      reason: `1-min load average ${load.toFixed(2)} across ${cpuCount} CPU(s); heapUsed ${Math.round(mem.heapUsed / 1e6)}MB.`,
    };
  }
  return {
    status: "HEALTHY",
    reason: `1-min load average ${load.toFixed(2)} across ${cpuCount} CPU(s); heapUsed ${Math.round(mem.heapUsed / 1e6)}MB.`,
  };
}

// Phase 5: 11th check - the Autonomous Worker's own liveness, via its DB
// heartbeat (see core/worker/heartbeat.ts). UNKNOWN if the worker has never
// started in this process (e.g. a test harness that never boots
// apps/api/src/index.ts) - never a fabricated HEALTHY.
async function checkWorker(): Promise<ComponentHealth> {
  try {
    const config = await getWorkerConfig();
    const heartbeat = await getHeartbeat("worker-1");
    if (!heartbeat) {
      return { status: "UNKNOWN", reason: "No worker heartbeat recorded yet." };
    }
    if (heartbeat.status === "CRASHED") {
      return { status: "FAILED", reason: "Worker watchdog gave up after repeated restart attempts." };
    }
    if (isStale(heartbeat, config.heartbeatTimeoutMs)) {
      return { status: "FAILED", reason: `Worker heartbeat is stale (last update ${heartbeat.lastHeartbeat.toISOString()}).` };
    }
    if (heartbeat.status === "DEGRADED") {
      return { status: "DEGRADED", reason: "Worker reported DEGRADED status." };
    }
    return {
      status: "HEALTHY",
      reason: `Worker "${heartbeat.workerId}" is ${heartbeat.status}; processed ${heartbeat.processedTasks}, failed ${heartbeat.failedTasks}.`,
    };
  } catch {
    return { status: "UNKNOWN", reason: "Could not read the worker heartbeat." };
  }
}

// Phase 6: 12th check - is a real web search provider configured? Never
// makes a live network call from a health check (that would make /health
// itself flaky/slow and dependent on outbound network) - just reports
// whether the credential is present, exactly like checking scheduler/tool
// registration state above.
async function checkWebProvider(): Promise<ComponentHealth> {
  const configured = Boolean(process.env.BRAVE_SEARCH_API_KEY && process.env.BRAVE_SEARCH_API_KEY.trim() !== "");
  if (!configured) {
    return { status: "DEGRADED", reason: "No web search provider configured (BRAVE_SEARCH_API_KEY unset) - research features return CONFIGURATION_REQUIRED." };
  }
  return { status: "HEALTHY", reason: "A web search provider credential is configured." };
}

function aggregate(components: Record<string, ComponentHealth>): HealthStatus {
  const statuses = Object.values(components).map((c) => c.status);
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("DEGRADED")) return "DEGRADED";
  if (statuses.every((s) => s === "UNKNOWN")) return "UNKNOWN";
  return "HEALTHY";
}

// Phase 12 (Production Integration, item 6): liveness vs readiness are
// DELIBERATELY different checks with different costs and different meaning,
// following standard practice (a liveness probe answers "is the process
// alive at all", cheap and near-instant; a readiness probe answers "can this
// instance actually serve traffic right now", checking its real
// dependencies) - neither replaces GET /system/health's full 12-component
// report (that one stays authenticated and detailed, for an operator; these
// two are meant for an unauthenticated process supervisor / load balancer
// and intentionally reveal nothing sensitive).

/** Liveness: the process can execute JS at all. No I/O, no dependency checks - if this throws or hangs, the process itself is the problem, not a dependency. */
export function getLiveness(): { status: "HEALTHY"; checkedAt: string } {
  return { status: "HEALTHY", checkedAt: new Date().toISOString() };
}

export interface ReadinessReport {
  ready: boolean;
  status: HealthStatus;
  checkedAt: string;
  database: ComponentHealth;
  providers: ReturnType<typeof summarizeProviders>;
}

/**
 * Readiness: can this instance serve real traffic right now? Checks the one
 * dependency that makes EVERY request fail if it's down (the database), and
 * reports provider configuration state for operator visibility - a missing
 * OPTIONAL/CONFIGURATION_REQUIRED provider does NOT fail readiness (the
 * system is designed to run with providers unconfigured, per config/env.ts's
 * documented design principle), only a failed database does.
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const database = await checkDatabase();
  const providers = summarizeProviders();
  const ready = database.status !== "FAILED";
  return {
    ready,
    status: database.status,
    checkedAt: new Date().toISOString(),
    database,
    providers,
  };
}

export async function getSystemHealth(): Promise<SystemHealthReport> {
  const [api, database, schedulerHealth, eventBus, taskQueue, agents, tools, memory, disk, resources, workerHealth, webProvider] =
    await Promise.all([
      checkApi(),
      checkDatabase(),
      checkScheduler(),
      checkEventBus(),
      checkTaskQueue(),
      checkAgents(),
      checkToolRegistry(),
      checkMemory(),
      checkDisk(),
      checkResources(),
      checkWorker(),
      checkWebProvider(),
    ]);

  const components: Record<string, ComponentHealth> = {
    api,
    database,
    scheduler: schedulerHealth,
    eventBus,
    taskQueue,
    agents,
    toolRegistry: tools,
    memory,
    disk,
    resources,
    worker: workerHealth,
    webProvider,
  };

  return {
    status: aggregate(components),
    components,
    checkedAt: new Date().toISOString(),
  };
}
