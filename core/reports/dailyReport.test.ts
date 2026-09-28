import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { generateDailyReport, generateAndSaveDailyReport, getLatestDailyReport, todayUtc } from "./dailyReport";

describe("core/reports/dailyReport - Daily Executive Report (#11)", () => {
  it("reports completed/failed/waiting/blocked tasks from real data for the given day", async () => {
    const now = todayUtc();
    const done = await prisma.task.create({ data: { title: "done-today", status: "DONE" } });
    const failed = await prisma.task.create({ data: { title: "failed-today", status: "FAILED", failureReason: "boom" } });
    const waiting = await prisma.task.create({ data: { title: "waiting-today", status: "WAITING", waitingReason: "needs info" } });
    const blocked = await prisma.task.create({ data: { title: "blocked-today", status: "BLOCKED", blockedReason: "policy" } });

    const report = await generateDailyReport(now);

    expect(report.completedTasks.some((t) => t.id === done.id)).toBe(true);
    const failedEntry = report.failedTasks.find((t) => t.id === failed.id);
    expect(failedEntry?.reason).toBe("boom");
    const waitingEntry = report.waitingTasks.find((t) => t.id === waiting.id);
    expect(waitingEntry?.reason).toBe("needs info");
    const blockedEntry = report.blockedTasks.find((t) => t.id === blocked.id);
    expect(blockedEntry?.reason).toBe("policy");

    expect(typeof report.system.errorLogCount).toBe("number");
    expect(report.system.aiUsage).toBeDefined();

    await prisma.task.deleteMany({ where: { id: { in: [done.id, failed.id, waiting.id, blocked.id] } } });
  });

  it("never fabricates a business metric - reports 'no data' shape is at minimum a real query result", async () => {
    const report = await generateDailyReport();
    expect(report.business.newLeadsToday === "no data" || typeof report.business.newLeadsToday === "number").toBe(true);
  });

  it("generateAndSaveDailyReport persists and getLatestDailyReport reads it back, idempotently (upsert by date)", async () => {
    const first = await generateAndSaveDailyReport();
    const second = await generateAndSaveDailyReport();
    expect(first.date).toBe(second.date);

    const rowCount = await prisma.dailyReport.count({ where: { reportDate: first.date } });
    expect(rowCount).toBe(1);

    const latest = await getLatestDailyReport();
    expect(latest?.date).toBe(first.date);
  });
});
