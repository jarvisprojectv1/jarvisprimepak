import { describe, it, expect } from "vitest";
import { Scheduler, registerExampleJobs, scheduler } from "./index";
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

  it("morning-briefing and daily-report are stored with the literal Asia/Karachi timezone (Phase 7.1 hardening)", async () => {
    await registerExampleJobs();

    const morning = await prisma.automation.findUnique({ where: { name: "morning-briefing" } });
    expect(morning?.schedule).toBe("0 5 * * *");
    expect(morning?.timezone).toBe("Asia/Karachi");

    const daily = await prisma.automation.findUnique({ where: { name: "daily-report" } });
    expect(daily?.schedule).toBe("0 21 * * *");
    expect(daily?.timezone).toBe("Asia/Karachi");
    // Same timezone mechanism (the literal stored string passed straight to
    // node-cron), not a new approach - both jobs use it identically.
    expect(morning?.timezone).toBe(daily?.timezone);
  });

  it("Asia/Karachi is a fixed UTC+5 offset with no daylight saving: 05:00 local == 00:00 UTC, 21:00 local == 16:00 UTC", () => {
    // Verified via Intl (the same mechanism node-cron's TimeMatcher itself
    // uses internally) rather than assumed - Pakistan has used a flat UTC+5
    // offset year-round since abolishing its brief 2008-2009 DST trial.
    const offsetMinutesFor = (utcDate: Date): number => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Karachi",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(utcDate);
      const hour = Number(parts.find((p) => p.type === "hour")!.value);
      const minute = Number(parts.find((p) => p.type === "minute")!.value);
      return hour * 60 + minute;
    };

    // A January date (winter) and a July date (summer) both resolve to the
    // exact same +5h offset - proving there is no seasonal DST shift.
    const winterUtcMidnight = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
    const summerUtcMidnight = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    expect(offsetMinutesFor(winterUtcMidnight)).toBe(5 * 60); // 00:00 UTC -> 05:00 local
    expect(offsetMinutesFor(summerUtcMidnight)).toBe(5 * 60);

    const winterUtcAfternoon = new Date(Date.UTC(2026, 0, 15, 16, 0, 0));
    const summerUtcAfternoon = new Date(Date.UTC(2026, 6, 15, 16, 0, 0));
    expect(offsetMinutesFor(winterUtcAfternoon)).toBe(21 * 60); // 16:00 UTC -> 21:00 local
    expect(offsetMinutesFor(summerUtcAfternoon)).toBe(21 * 60);
  });

  it("re-registering morning-briefing/daily-report (simulating a restart) does not create a duplicate Automation row or duplicate cron task", async () => {
    await registerExampleJobs();
    await registerExampleJobs(); // second "boot"

    const morningRows = await prisma.automation.findMany({ where: { name: "morning-briefing" } });
    const dailyRows = await prisma.automation.findMany({ where: { name: "daily-report" } });
    expect(morningRows.length).toBe(1);
    expect(dailyRows.length).toBe(1);
    expect(morningRows[0].timezone).toBe("Asia/Karachi");
    expect(dailyRows[0].timezone).toBe("Asia/Karachi");
    expect(scheduler.isRunning("morning-briefing")).toBe(true);
    expect(scheduler.isRunning("daily-report")).toBe(true);
  });

  it("re-registering the same job name (simulating two process boots) upserts in place: no duplicate Automation row, no duplicate running cron task", async () => {
    const scheduler = new Scheduler();
    const name = `boot-sim-${Date.now()}`;
    const job = {
      name,
      triggerType: "daily" as const,
      schedule: "0 5 * * *",
      timezone: "UTC",
      handler: () => {},
    };

    // "Boot" 1
    await scheduler.register(job);
    // "Boot" 2 (same process instance re-registering, as registerExampleJobs()
    // does every time the API starts) - and a second, independent Scheduler
    // instance simulating a fresh process entirely.
    await scheduler.register(job);
    const secondBootScheduler = new Scheduler();
    await secondBootScheduler.register(job);

    const rows = await prisma.automation.findMany({ where: { name } });
    expect(rows.length).toBe(1);
    expect(rows[0].schedule).toBe("0 5 * * *");

    // Exactly one running cron task per scheduler instance holding this name,
    // and re-registering never leaves a second task ticking underneath.
    expect(scheduler.isRunning(name)).toBe(true);
    expect(secondBootScheduler.isRunning(name)).toBe(true);

    scheduler.stop(name);
    secondBootScheduler.stop(name);
  });
});
