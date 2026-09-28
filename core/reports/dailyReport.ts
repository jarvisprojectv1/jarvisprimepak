// core/reports/dailyReport.ts - Daily Executive Report (Phase 5 / Autonomous
// Worker, requirement #11).
//
// Strictly generated from real, currently-available data: Task rows for the
// day, the worker's own heartbeat, SystemLog error counts, and AiUsage cost
// totals. A business metric with no real data source (e.g. anything CRM
// beyond the existing `leads` table) is simply omitted or reported as "no
// data" - never fabricated.
import { prisma } from "../../database/client";
import { listHeartbeats } from "../worker/heartbeat";
import { summarizeUsageSince, startOfDayUtc } from "../ai/usage";

export interface TaskSummaryLine {
  id: string;
  title: string;
  retryCount: number;
  reason?: string | null;
}

export interface DailyReportContent {
  date: string; // YYYY-MM-DD, UTC
  completedTasks: TaskSummaryLine[];
  failedTasks: TaskSummaryLine[];
  waitingTasks: TaskSummaryLine[];
  blockedTasks: TaskSummaryLine[];
  system: {
    workers: Array<{
      workerId: string;
      status: string;
      uptimeMs: number;
      processedTasks: number;
      failedTasks: number;
      restartCount: number;
    }>;
    errorLogCount: number;
    aiUsage: { callCount: number; totalInputTokens: number; totalOutputTokens: number; totalEstimatedCostUsd: number };
  };
  business: {
    newLeadsToday: number | "no data";
    totalOpenLeads: number | "no data";
  };
}

function dateKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Generates the report content for `forDate` (defaults to "today", UTC). Does not persist it - see saveDailyReport(). */
export async function generateDailyReport(forDate: Date = todayUtc()): Promise<DailyReportContent> {
  const start = todayUtc(forDate);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const [completed, failed, waiting, blocked, heartbeats, errorLogs, aiUsage, newLeadsToday, totalOpenLeads] =
    await Promise.all([
      prisma.task.findMany({ where: { status: "DONE", updatedAt: { gte: start, lt: end } } }),
      prisma.task.findMany({ where: { status: "FAILED", updatedAt: { gte: start, lt: end } } }),
      prisma.task.findMany({ where: { status: "WAITING", updatedAt: { gte: start, lt: end } } }),
      prisma.task.findMany({ where: { status: "BLOCKED", updatedAt: { gte: start, lt: end } } }),
      listHeartbeats(),
      prisma.systemLog.count({ where: { category: { in: ["ERROR", "CRITICAL"] }, createdAt: { gte: start, lt: end } } }),
      summarizeUsageSince(startOfDayUtc(forDate)),
      prisma.lead.count({ where: { createdAt: { gte: start, lt: end } } }).catch(() => "no data" as const),
      prisma.lead.count({ where: { status: { in: ["NEW", "CONTACTED", "QUALIFIED"] } } }).catch(() => "no data" as const),
    ]);

  const now = Date.now();

  return {
    date: dateKeyUtc(start),
    completedTasks: completed.map((t) => ({ id: t.id, title: t.title, retryCount: t.retryCount })),
    failedTasks: failed.map((t) => ({ id: t.id, title: t.title, retryCount: t.retryCount, reason: t.failureReason })),
    waitingTasks: waiting.map((t) => ({ id: t.id, title: t.title, retryCount: t.retryCount, reason: t.waitingReason })),
    blockedTasks: blocked.map((t) => ({ id: t.id, title: t.title, retryCount: t.retryCount, reason: t.blockedReason })),
    system: {
      workers: heartbeats.map((h) => ({
        workerId: h.workerId,
        status: h.status,
        uptimeMs: now - h.startedAt.getTime(),
        processedTasks: h.processedTasks,
        failedTasks: h.failedTasks,
        restartCount: h.restartCount,
      })),
      errorLogCount: errorLogs,
      aiUsage,
    },
    business: {
      newLeadsToday: typeof newLeadsToday === "number" ? newLeadsToday : "no data",
      totalOpenLeads: typeof totalOpenLeads === "number" ? totalOpenLeads : "no data",
    },
  };
}

/** Generates and persists today's report (idempotent - upserts by date, so a re-run replaces rather than duplicates). */
export async function generateAndSaveDailyReport(forDate: Date = todayUtc()): Promise<DailyReportContent> {
  const content = await generateDailyReport(forDate);
  await prisma.dailyReport.upsert({
    where: { reportDate: content.date },
    update: { content: JSON.stringify(content) },
    create: { reportDate: content.date, content: JSON.stringify(content) },
  });
  return content;
}

export async function getLatestDailyReport(): Promise<DailyReportContent | null> {
  const row = await prisma.dailyReport.findFirst({ orderBy: { reportDate: "desc" } });
  if (!row) return null;
  try {
    return JSON.parse(row.content) as DailyReportContent;
  } catch {
    return null;
  }
}
