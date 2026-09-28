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
// Phase 11 (Business Intelligence, sections 31-34): extends the existing
// report generator (never forks a second one - see this file's original
// header discipline) with a deterministic-only executive-briefing section.
// No AIProvider is passed here deliberately: the daily report already runs
// on a schedule with no human waiting on prose, so it stays free/instant and
// fully reproducible - any AI narrative is opt-in via
// core/business/intelligence/executiveBriefing.ts's `aiProvider` option,
// called separately (e.g. from the weekly-review job) when desired.
import { buildExecutiveBriefing } from "../business/intelligence/executiveBriefing";

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
  // Phase 6 (Web Research): honestly reports whether web research ran
  // overnight - never fabricates "overnight monitoring" that didn't happen.
  research: {
    webResearchConfigured: boolean;
    researchRunsToday: number;
    newWebResultsToday: number;
    note: string;
  };
  // Phase 7 (Email & CRM, item 25): real counts only - a category with
  // nothing to report says so explicitly, never fabricated.
  emailCrm: {
    emailProviderConfigured: boolean;
    emailsSentToday: number;
    emailsReceivedToday: number;
    newLeadsFromResearchToday: number;
    pendingApprovals: number;
    approvalsDecidedToday: number;
    leadsByStatus: Array<{ status: string; count: number }>;
    note: string;
  };
  // Phase 8 (WhatsApp, item 45): SAME "real counts only" discipline as
  // emailCrm above, filtered to channel "WHATSAPP" on the SAME generalized
  // Email/ApprovalRequest tables - not a separate metrics pipeline.
  whatsapp: {
    providerConfigured: boolean;
    messagesSentToday: number;
    messagesReceivedToday: number;
    pendingApprovals: number;
    approvalsDecidedToday: number;
    optOutsToday: number;
    note: string;
  };
  // Phase 11 (Business Intelligence, item 31): see buildBusinessIntelligenceSection() below.
  businessIntelligence: BusinessIntelligenceSection;
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

  const [
    completed,
    failed,
    waiting,
    blocked,
    heartbeats,
    errorLogs,
    aiUsage,
    newLeadsToday,
    totalOpenLeads,
    researchRunsToday,
    newWebResultsToday,
    emailsSentToday,
    emailsReceivedToday,
    newLeadsFromResearchToday,
    pendingApprovals,
    approvalsDecidedToday,
    leadsByStatusRaw,
    whatsappMessagesSentToday,
    whatsappMessagesReceivedToday,
    whatsappPendingApprovals,
    whatsappApprovalsDecidedToday,
    whatsappOptOutsToday,
  ] = await Promise.all([
    prisma.task.findMany({ where: { status: "DONE", updatedAt: { gte: start, lt: end } } }),
    prisma.task.findMany({ where: { status: "FAILED", updatedAt: { gte: start, lt: end } } }),
    prisma.task.findMany({ where: { status: "WAITING", updatedAt: { gte: start, lt: end } } }),
    prisma.task.findMany({ where: { status: "BLOCKED", updatedAt: { gte: start, lt: end } } }),
    listHeartbeats(),
    prisma.systemLog.count({ where: { category: { in: ["ERROR", "CRITICAL"] }, createdAt: { gte: start, lt: end } } }),
    summarizeUsageSince(startOfDayUtc(forDate)),
    prisma.lead.count({ where: { createdAt: { gte: start, lt: end } } }).catch(() => "no data" as const),
    prisma.lead.count({ where: { status: { in: ["NEW", "CONTACTED", "QUALIFIED"] } } }).catch(() => "no data" as const),
    prisma.researchRun.count({ where: { startedAt: { gte: start, lt: end } } }),
    prisma.event.count({ where: { type: "WEB.new_research_result", createdAt: { gte: start, lt: end } } }),
    // Phase 8: explicitly filtered to channel "EMAIL" - the Email table now
    // also holds WhatsApp rows (see database/schema.prisma's Email.channel
    // comment), so these counts would otherwise silently double-count
    // WhatsApp messages into the email-specific section below.
    prisma.email.count({ where: { channel: "EMAIL", direction: "outbound", status: "SENT", createdAt: { gte: start, lt: end } } }),
    prisma.email.count({ where: { channel: "EMAIL", direction: "inbound", createdAt: { gte: start, lt: end } } }),
    prisma.lead.count({ where: { researchRunId: { not: null }, createdAt: { gte: start, lt: end } } }),
    // Phase 8: filtered to action "email.send" for the same double-counting
    // reason as the Email queries above - a WhatsApp approval is counted in
    // the `whatsapp` section instead.
    prisma.approvalRequest.count({ where: { status: "PENDING", action: "email.send" } }),
    prisma.approvalRequest.count({ where: { status: { in: ["APPROVED", "REJECTED"] }, action: "email.send", updatedAt: { gte: start, lt: end } } }),
    prisma.lead.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.email.count({ where: { channel: "WHATSAPP", direction: "outbound", status: "SENT", createdAt: { gte: start, lt: end } } }),
    prisma.email.count({ where: { channel: "WHATSAPP", direction: "inbound", createdAt: { gte: start, lt: end } } }),
    prisma.approvalRequest.count({ where: { status: "PENDING", action: "whatsapp.send" } }),
    prisma.approvalRequest.count({ where: { status: { in: ["APPROVED", "REJECTED"] }, action: "whatsapp.send", updatedAt: { gte: start, lt: end } } }),
    prisma.email.count({ where: { channel: "WHATSAPP", classification: "UNSUBSCRIBE_REQUEST", createdAt: { gte: start, lt: end } } }),
  ]);

  const webResearchConfigured = Boolean(process.env.BRAVE_SEARCH_API_KEY && process.env.BRAVE_SEARCH_API_KEY.trim() !== "");
  const emailProviderConfigured = Boolean(process.env.GMAIL_ACCESS_TOKEN && process.env.GMAIL_USER_EMAIL);
  const whatsappProviderConfigured = Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_BUSINESS_ACCOUNT_ID);
  const leadsByStatus = leadsByStatusRaw.map((r) => ({ status: r.status, count: r._count.status }));

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
    research: {
      webResearchConfigured,
      researchRunsToday,
      newWebResultsToday,
      note: webResearchConfigured
        ? `Web research capability is configured; ${researchRunsToday} research run(s) and ${newWebResultsToday} new tracked-topic result(s) today.`
        : "Web research capability is not configured (no search provider credential); this brief covers internal system status only.",
    },
    emailCrm: {
      emailProviderConfigured,
      emailsSentToday,
      emailsReceivedToday,
      newLeadsFromResearchToday,
      pendingApprovals,
      approvalsDecidedToday,
      leadsByStatus,
      note: emailProviderConfigured
        ? `Email capability is configured; ${emailsSentToday} sent / ${emailsReceivedToday} received today, ${pendingApprovals} approval(s) pending.`
        : `Email sending/receiving is not configured (no GMAIL_ACCESS_TOKEN/GMAIL_USER_EMAIL); CRM pipeline counts below are still real. ${pendingApprovals} approval(s) pending.`,
    },
    whatsapp: {
      providerConfigured: whatsappProviderConfigured,
      messagesSentToday: whatsappMessagesSentToday,
      messagesReceivedToday: whatsappMessagesReceivedToday,
      pendingApprovals: whatsappPendingApprovals,
      approvalsDecidedToday: whatsappApprovalsDecidedToday,
      optOutsToday: whatsappOptOutsToday,
      note: whatsappProviderConfigured
        ? `WhatsApp capability is configured; ${whatsappMessagesSentToday} sent / ${whatsappMessagesReceivedToday} received today, ${whatsappPendingApprovals} approval(s) pending, ${whatsappOptOutsToday} opt-out(s) today.`
        : `WhatsApp sending/receiving is not configured (no WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_BUSINESS_ACCOUNT_ID); any counts below reflect locally-ingested test/mock data only.`,
    },
    businessIntelligence: await buildBusinessIntelligenceSection(forDate),
  };
}

// Phase 11 (item 31): recommendation summary + pipeline-risk/follow-up
// candidate counts, straight from the deterministic BI snapshot for
// "today" - no AI call, matching this file's existing "real counts only"
// discipline for every other section.
export interface BusinessIntelligenceSection {
  snapshotId: string;
  periodLabel: string;
  pipelineRiskCount: number;
  followUpCandidateCount: number;
  dataQualityIssueCount: number;
  anomalyCount: number;
  recommendationCount: number;
  highPriorityRecommendationCount: number;
  note: string;
}

async function buildBusinessIntelligenceSection(forDate: Date): Promise<BusinessIntelligenceSection> {
  const briefing = await buildExecutiveBriefing({ windowName: "TODAY", snapshotType: "DAILY", now: forDate });
  const risk = briefing.statements["pipeline_risk.stale_leads"];
  const followUps = briefing.statements["follow_up.candidates"];
  const dataQuality = briefing.statements["data_quality.report"];
  const anomalies = briefing.statements["anomaly_detection.result"];

  const pipelineRiskCount = Array.isArray(risk?.value) ? risk.value.length : 0;
  const followUpCandidateCount = Array.isArray(followUps?.value) ? followUps.value.length : 0;
  const dq = dataQuality?.value as { duplicateCompanies: number; duplicateContacts: number; duplicateLeads: number; contactsMissingEmailAndPhone: number } | null | undefined;
  const dataQualityIssueCount = dq ? dq.duplicateCompanies + dq.duplicateContacts + dq.duplicateLeads + dq.contactsMissingEmailAndPhone : 0;
  const anomalyCount = Array.isArray(anomalies?.value) ? anomalies.value.length : 0;
  const highPriorityRecommendationCount = briefing.recommendations.filter((r) => r.priority === "HIGH").length;

  return {
    snapshotId: `${briefing.periodLabel}`,
    periodLabel: briefing.periodLabel,
    pipelineRiskCount,
    followUpCandidateCount,
    dataQualityIssueCount,
    anomalyCount,
    recommendationCount: briefing.recommendations.length,
    highPriorityRecommendationCount,
    note: `Business Intelligence (Phase 11): ${pipelineRiskCount} stale pipeline lead(s), ${followUpCandidateCount} follow-up candidate(s), ${dataQualityIssueCount} data-quality issue(s), ${anomalyCount} anomaly signal(s), ${briefing.recommendations.length} recommendation(s) (${highPriorityRecommendationCount} HIGH priority). All figures are deterministic (no AI call in the daily report path).`,
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
