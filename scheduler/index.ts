// scheduler/index.ts - recurring job scheduling (spec section on automations).
//
// Job schedules are DATA, never hardcoded: they are loaded from the
// `automations` settings table (falling back to the in-code defaults below,
// which are themselves just seed data written through the same interface).
// Supported trigger types: one_time, daily, weekly, monthly, interval,
// event-triggered, condition-triggered. Phase 1 wires up cron-based triggers
// (daily/weekly/monthly/interval) for real; event/condition triggers are
// interfaces only (no event bus / condition engine yet).
import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "../database/client";
import { log } from "../security/logger";

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
  enabled?: boolean;
  handler: () => Promise<void> | void;
}

const CRON_TRIGGER_TYPES: TriggerType[] = ["daily", "weekly", "monthly", "interval"];

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();

  /** Registers a job and, for cron-driven trigger types, starts it immediately. */
  async register(job: JobDefinition): Promise<void> {
    await prisma.automation.upsert({
      where: { name: job.name },
      update: {
        triggerType: job.triggerType,
        schedule: job.schedule,
        enabled: job.enabled ?? true,
      },
      create: {
        name: job.name,
        triggerType: job.triggerType,
        schedule: job.schedule,
        enabled: job.enabled ?? true,
      },
    });

    if (!CRON_TRIGGER_TYPES.includes(job.triggerType)) {
      log("INFO", `scheduler.register:${job.name}`, {
        triggerType: job.triggerType,
        note: "event/one_time/condition triggers are interfaces only in Phase 1 (no event bus / condition engine yet).",
      });
      return;
    }

    if (!job.schedule || !cron.validate(job.schedule)) {
      throw new Error(
        `Job "${job.name}" has trigger type "${job.triggerType}" but no valid cron schedule.`
      );
    }

    if (job.enabled === false) {
      log("INFO", `scheduler.register:${job.name}`, { enabled: false });
      return;
    }

    const task = cron.schedule(job.schedule, async () => {
      log("ACTION", `scheduler.fire:${job.name}`);
      try {
        await job.handler();
        await prisma.automation.update({
          where: { name: job.name },
          data: { lastRunAt: new Date() },
        });
      } catch (err) {
        log("ERROR", `scheduler.error:${job.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.tasks.set(job.name, task);
    log("INFO", `scheduler.started:${job.name}`, { schedule: job.schedule });
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
}

export const scheduler = new Scheduler();

/**
 * Registers Phase 1's example jobs: log-only, no-op-on-real-systems, so they
 * are safe to run out of the box. Real business automations (follow-up
 * emails, report generation, etc.) are a later phase.
 */
export async function registerExampleJobs(): Promise<void> {
  await scheduler.register({
    name: "daily-heartbeat",
    triggerType: "daily",
    schedule: "0 8 * * *", // 08:00 every day, server time
    handler: () => {
      log("INFO", "scheduler.daily-heartbeat", { note: "JARVIS is alive." });
    },
  });

  await scheduler.register({
    name: "hourly-stale-lead-check",
    triggerType: "interval",
    schedule: "0 * * * *", // once an hour
    handler: async () => {
      const count = await prisma.lead.count({ where: { status: "NEW" } });
      log("BUSINESS", "scheduler.hourly-stale-lead-check", { newLeadCount: count });
    },
  });
}
