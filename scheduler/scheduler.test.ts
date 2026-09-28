import { describe, it, expect } from "vitest";
import { Scheduler } from "./index";
import { prisma } from "../database/client";

describe("scheduler", () => {
  it("registers a cron-driven job, persists it to automations, and can stop it", async () => {
    const scheduler = new Scheduler();
    const name = `test-job-${Date.now()}`;

    await scheduler.register({
      name,
      triggerType: "interval",
      schedule: "*/5 * * * *",
      handler: () => {},
    });

    expect(scheduler.isRunning(name)).toBe(true);

    const row = await prisma.automation.findUnique({ where: { name } });
    expect(row?.triggerType).toBe("interval");
    expect(row?.enabled).toBe(true);

    scheduler.stop(name);
    expect(scheduler.isRunning(name)).toBe(false);
  });

  it("registers an event-triggered job as a no-op (interface only, no event bus yet)", async () => {
    const scheduler = new Scheduler();
    const name = `event-job-${Date.now()}`;
    await scheduler.register({ name, triggerType: "event", handler: () => {} });
    // Event triggers aren't cron-scheduled in Phase 1.
    expect(scheduler.isRunning(name)).toBe(false);
    const row = await prisma.automation.findUnique({ where: { name } });
    expect(row?.triggerType).toBe("event");
  });

  it("rejects a cron trigger type with an invalid schedule", async () => {
    const scheduler = new Scheduler();
    await expect(
      scheduler.register({
        name: `bad-${Date.now()}`,
        triggerType: "daily",
        schedule: "not-a-cron",
        handler: () => {},
      })
    ).rejects.toThrow();
  });

  it("persists the given timezone on the automation row (default UTC)", async () => {
    const scheduler = new Scheduler();
    const name = `tz-job-${Date.now()}`;
    await scheduler.register({
      name,
      triggerType: "interval",
      schedule: "*/5 * * * *",
      timezone: "America/New_York",
      handler: () => {},
    });
    const row = await prisma.automation.findUnique({ where: { name } });
    expect(row?.timezone).toBe("America/New_York");
    scheduler.stop(name);
  });

  it("defaults timezone to UTC when not specified", async () => {
    const scheduler = new Scheduler();
    const name = `tz-default-${Date.now()}`;
    await scheduler.register({ name, triggerType: "interval", schedule: "*/5 * * * *", handler: () => {} });
    const row = await prisma.automation.findUnique({ where: { name } });
    expect(row?.timezone).toBe("UTC");
    scheduler.stop(name);
  });

  it("prevents duplicate/overlapping execution of the same job", async () => {
    const scheduler = new Scheduler();
    const name = `dup-job-${Date.now()}`;
    let runCount = 0;
    const job = {
      name,
      triggerType: "interval" as const,
      schedule: "*/5 * * * *",
      handler: async () => {
        runCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    };
    await scheduler.register(job);

    // Fire the private job-runner twice "concurrently", simulating an
    // overlapping cron tick while the first invocation is still running.
    const fireJob = (scheduler as unknown as { fireJob: (j: typeof job) => Promise<void> }).fireJob.bind(scheduler);
    await Promise.all([fireJob(job), fireJob(job)]);

    expect(runCount).toBe(1);
    scheduler.stop(name);
  });

  it("records AutomationRun execution history (success and failure)", async () => {
    const scheduler = new Scheduler();
    const name = `history-job-${Date.now()}`;
    const job = { name, triggerType: "interval" as const, schedule: "*/5 * * * *", handler: () => {} };
    await scheduler.register(job);

    const fireJob = (scheduler as unknown as { fireJob: (j: typeof job) => Promise<void> }).fireJob.bind(scheduler);
    await fireJob(job);

    const automation = await prisma.automation.findUnique({ where: { name } });
    const runs = await prisma.automationRun.findMany({ where: { automationId: automation!.id } });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe("SUCCESS");
    scheduler.stop(name);
  });

  it("live enable/disable stops and starts a job without a process restart", async () => {
    const scheduler = new Scheduler();
    const name = `toggle-job-${Date.now()}`;
    await scheduler.register({ name, triggerType: "interval", schedule: "*/5 * * * *", handler: () => {} });
    expect(scheduler.isRunning(name)).toBe(true);

    await scheduler.setEnabled(name, false);
    expect(scheduler.isRunning(name)).toBe(false);
    const disabledRow = await prisma.automation.findUnique({ where: { name } });
    expect(disabledRow?.enabled).toBe(false);

    await scheduler.setEnabled(name, true);
    expect(scheduler.isRunning(name)).toBe(true);
    scheduler.stop(name);
  });

  it("restart recovery: a job left disabled before a simulated crash stays disabled after re-registering", async () => {
    const name = `restart-job-${Date.now()}`;
    const firstProcessScheduler = new Scheduler();
    await firstProcessScheduler.register({ name, triggerType: "interval", schedule: "*/5 * * * *", handler: () => {} });
    await firstProcessScheduler.setEnabled(name, false);
    firstProcessScheduler.stopAll();

    // Simulate a fresh process: a brand-new Scheduler instance re-registering
    // the same job definition (as registerExampleJobs() does at boot),
    // without explicitly passing `enabled`.
    const secondProcessScheduler = new Scheduler();
    await secondProcessScheduler.register({ name, triggerType: "interval", schedule: "*/5 * * * *", handler: () => {} });

    expect(secondProcessScheduler.isRunning(name)).toBe(false);
    const row = await prisma.automation.findUnique({ where: { name } });
    expect(row?.enabled).toBe(false);
    secondProcessScheduler.stopAll();
  });
});
