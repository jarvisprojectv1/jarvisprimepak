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
});
