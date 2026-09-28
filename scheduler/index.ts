// scheduler/index.ts - recurring job scheduling (spec section on automations).
//
// Job schedules are DATA, never hardcoded: they are loaded from the
// `automations` table (falling back to the in-code defaults below, which are
// themselves just seed data written through the same interface).
//
// Phase 3 upgrade: job handlers now PUBLISH a typed SCHEDULE.fired event
// (core/events.publish) instead of performing business logic directly inside
// the cron callback - real subscribers (registered below) react to that
// event. This also gives the condition engine (core/conditions) a real event
// to route on (see the seeded "morning-briefing" ConditionRule).
//
// Also added: per-run execution history (AutomationRun), duplicate-execution
// prevention (a job already running skips a re-entrant fire), bounded retry
// on handler failure, explicit per-job timezone (defaulting to UTC), a
// best-effort missed-schedule check at registration time, and live
// enable/disable that doesn't require a process restart.
import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "../database/client";
import { log } from "../security/logger";
import { publish } from "../core/events";
import { writeAuditLog } from "../security/audit";
import { getLimitsConfig } from "../core/limits";
import { identityToActorString, SYSTEM_IDENTITY } from "../core/auth/identity";

export type TriggerType =
  | "one_time"
  | "daily"
  | "weekly"
  | "monthly"
  | "interval"
  | "event"
  | "condition";

export interface JobDefinition {
  name: string;
  triggerType: TriggerType;
  /** Cron expression for daily/weekly/monthly/interval triggers. Ignored for one_time/event/condition. */
  schedule?: string;
  /** IANA timezone name passed to node-cron. Defaults to UTC. */
  timezone?: string;
  enabled?: boolean;
  handler: () => Promise<void> | void;
}

const CRON_TRIGGER_TYPES: TriggerType[] = ["daily", "weekly", "monthly", "interval"];
const DEFAULT_TIMEZONE = "UTC";

// Rough expected-cadence hints for the best-effort missed-schedule check
// below. This is NOT a real cron-expression parser (out of scope for this
// phase) - just enough to flag "this job hasn't run in far longer than its
// trigger type would suggest" after a restart.
const EXPECTED_CADENCE_MS: Record<TriggerType, number | undefined> = {
  daily: 26 * 60 * 60 * 1000, // a bit over a day
  weekly: 8 * 24 * 60 * 60 * 1000,
  monthly: 32 * 24 * 60 * 60 * 1000,
  interval: 2 * 60 * 60 * 1000, // conservative: most interval jobs here are hourly
  one_time: undefined,
  event: undefined,
  condition: undefined,
};

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private jobDefinitions = new Map<string, JobDefinition>();
  private runningJobs = new Set<string>();

  /** Registers a job and, for cron-driven trigger types, starts it immediately (if enabled). */
  async register(job: JobDefinition): Promise<void> {
    const timezone = job.timezone ?? DEFAULT_TIMEZONE;
    this.jobDefinitions.set(job.name, job);

    const existing = await prisma.automation.findUnique({ where: { name: job.name } });

    // Restart recovery: if the caller doesn't explicitly pass `enabled`
    // (the common case - registerExampleJobs() at boot doesn't), honor
    // whatever was last persisted (e.g. an operator disabled this job via
    // the API before a restart) rather than silently re-enabling it. An
    // explicit `enabled` always wins (e.g. a live toggle via setEnabled()).
    const wantEnabled = job.enabled !== undefined ? job.enabled : existing?.enabled ?? true;

    await prisma.automation.upsert({
      where: { name: job.name },
      update: {
        triggerType: job.triggerType,
        schedule: job.schedule,
        timezone,
        enabled: wantEnabled,
      },
      create: {
        name: job.name,
        triggerType: job.triggerType,
        schedule: job.schedule,
        timezone,
        enabled: wantEnabled,
      },
    });

    // Best-effort missed-schedule detection: if this job has run before and
    // it's been far longer than its trigger type's expected cadence, flag
    // it. Full catch-up execution is explicitly NOT implemented.
    const expectedMs = EXPECTED_CADENCE_MS[job.triggerType];
    if (existing?.lastRunAt && expectedMs) {
      const elapsed = Date.now() - existing.lastRunAt.getTime();
      if (elapsed > expectedMs) {
        log("WARNING", `scheduler.possible_missed_run:${job.name}`, {
          lastRunAt: existing.lastRunAt.toISOString(),
          elapsedMs: elapsed,
          expectedMs,
        });
      }
    }

    // Stop any previously-running cron task for this name before
    // (re-)starting, so re-registering (e.g. after an enable/disable toggle)
    // never leaves a duplicate task ticking.
    this.tasks.get(job.name)?.stop();
    this.tasks.delete(job.name);

    if (!CRON_TRIGGER_TYPES.includes(job.triggerType)) {
      log("INFO", `scheduler.register:${job.name}`, {
        triggerType: job.triggerType,
        note: "event/one_time/condition trigger types are interfaces only (no dispatcher/condition engine wired to fire them off a clock).",
      });
      return;
    }

    if (!job.schedule || !cron.validate(job.schedule)) {
      throw new Error(
        `Job "${job.name}" has trigger type "${job.triggerType}" but no valid cron schedule.`
      );
    }

    if (!wantEnabled) {
      log("INFO", `scheduler.register:${job.name}`, { enabled: false });
      return;
    }

    const task = cron.schedule(
      job.schedule,
      async () => {
        await this.fireJob(job);
      },
      { timezone }
    );

    this.tasks.set(job.name, task);
    log("INFO", `scheduler.started:${job.name}`, { schedule: job.schedule, timezone });
  }

  /** Runs one job invocation: duplicate-run guard, execution history, publish + handler, bounded retry, failure audit. */
  private async fireJob(job: JobDefinition): Promise<void> {
    if (this.runningJobs.has(job.name)) {
      log("WARNING", `scheduler.duplicate_fire_skipped:${job.name}`, {
        reason: "Previous invocation of this job is still running.",
      });
      return;
    }
    this.runningJobs.add(job.name);
    log("ACTION", `scheduler.fire:${job.name}`);

    const limits = await getLimitsConfig();
    const maxAttempts = Math.max(1, limits.retryLimit);
    let attempt = 0;
    let lastError: unknown;

    const automation = await prisma.automation.findUnique({ where: { name: job.name } });
    const run = automation
      ? await prisma.automationRun.create({ data: { automationId: automation.id, attempt: 1 } })
      : null;

    try {
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          // Phase 3: publish a typed SCHEDULE event FIRST, so subscribers and
          // the condition engine can react, instead of the cron callback
          // performing business logic itself.
          await publish({
            type: "SCHEDULE.fired",
            payload: { jobName: job.name, attempt },
            source: "scheduler",
          });
          // Legacy proof-of-pipe event kept for backward compatibility with
          // core/events' registerDefaultSubscribers (Phase 2).
          await publish({ type: "scheduler.fired", payload: { jobName: job.name }, source: "scheduler" });

          await job.handler();

          await prisma.automation.update({ where: { name: job.name }, data: { lastRunAt: new Date() } });
          if (run) {
            await prisma.automationRun.update({
              where: { id: run.id },
              data: { status: "SUCCESS", endedAt: new Date(), attempt },
            });
          }
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          log("ERROR", `scheduler.error:${job.name}`, {
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (lastError) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        if (run) {
          await prisma.automationRun.update({
            where: { id: run.id },
            data: { status: "FAILED", endedAt: new Date(), error: message, attempt },
          });
        }
        await writeAuditLog({
          actor: identityToActorString(SYSTEM_IDENTITY),
          action: `scheduler.job_failed:${job.name}`,
          target: job.name,
          meta: { attempts: attempt, error: message },
        });
      }
    } finally {
      this.runningJobs.delete(job.name);
    }
  }

  stop(name: string): void {
    this.tasks.get(name)?.stop();
    this.tasks.delete(name);
  }

  stopAll(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  isRunning(name: string): boolean {
    return this.tasks.has(name);
  }

  /** Live-toggles a job's enabled state without a process restart, re-reading its stored definition. */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const def = this.jobDefinitions.get(name);
    if (!def) return false;
    await this.register({ ...def, enabled });
    return true;
  }
}

export const scheduler = new Scheduler();

/**
 * Registers Phase 1's example jobs (now event-publishing, per Phase 3): the
 * cron callback publishes SCHEDULE.fired and these subscribers do the actual
 * (safe, log-only / read-only) work in reaction to it - equivalent behavior
 * to before, just moved to plug into the event bus.
 */
export async function registerExampleJobs(): Promise<void> {
  const { subscribe } = await import("../core/events");

  subscribe("SCHEDULE.fired", async (event) => {
    const payload = event.payload as { jobName?: string } | undefined;
    if (payload?.jobName === "daily-heartbeat") {
      log("INFO", "scheduler.daily-heartbeat", { note: "JARVIS is alive." });
    }
    if (payload?.jobName === "hourly-stale-lead-check") {
      const count = await prisma.lead.count({ where: { status: "NEW" } });
      log("BUSINESS", "scheduler.hourly-stale-lead-check", { newLeadCount: count });
    }
  });

  await scheduler.register({
    name: "daily-heartbeat",
    triggerType: "daily",
    schedule: "0 8 * * *", // 08:00 every day
    timezone: "UTC",
    handler: () => {
      // Business logic now lives in the SCHEDULE.fired subscriber above.
    },
  });

  await scheduler.register({
    name: "hourly-stale-lead-check",
    triggerType: "interval",
    schedule: "0 * * * *", // once an hour
    timezone: "UTC",
    handler: () => {
      // Business logic now lives in the SCHEDULE.fired subscriber above.
    },
  });

  // Example (b) from docs/PHASE3_IDENTITY_EVENTS.md: a SCHEDULE event fired
  // at a configured time creates a "morning briefing" task, via the seeded
  // "morning-briefing" ConditionRule (core/conditions/rules.ts) - task
  // creation only, no briefing content generation (a later phase).
  await scheduler.register({
    name: "morning-briefing",
    triggerType: "daily",
    schedule: "0 7 * * *", // 07:00 every day
    timezone: "UTC",
    handler: () => {
      // The ConditionRule matching SCHEDULE.fired{jobName:"morning-briefing"}
      // creates the task; nothing else to do here.
    },
  });

  // Phase 5 (Autonomous Daily Cycle, #8): the evening half of the daily
  // cycle. Same pattern as morning-briefing above - the cron callback only
  // publishes SCHEDULE.fired; the seeded "daily-report" ConditionRule
  // (core/conditions/rules.ts) creates a task tagged toolName:"reports", so
  // the worker executes it directly through tools/reports.ts (which calls
  // core/reports/dailyReport.ts) - the same guarded tool-registry path as
  // any other tool call. Kept as a genuinely separate job (rather than
  // folding into morning-briefing) since it fires 14 hours later and creates
  // a differently-tagged task.
  await scheduler.register({
    name: "daily-report",
    triggerType: "daily",
    schedule: "0 21 * * *", // 21:00 every day
    timezone: "UTC",
    handler: () => {
      // The ConditionRule matching SCHEDULE.fired{jobName:"daily-report"}
      // creates the task; nothing else to do here.
    },
  });
}
