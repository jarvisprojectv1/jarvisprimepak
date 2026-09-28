// core/research/limits.ts - Cost/Resource Control for research (Phase 6,
// item 18). Same Setting-backed config pattern as core/limits/index.ts
// (extended, not rewritten - core/limits itself is untouched). Covers:
// max searches/fetches per task, max concurrent research jobs, minimum
// topic-poll interval, and a repeated-failed-fetch backoff so a broken
// source is never hammered. LLM spend remains entirely under
// core/ai/costControl.ts - these are plain-HTTP operation counts, not
// tokens/dollars.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export interface ResearchLimitsConfig {
  maxSearchesPerTask: number;
  maxFetchesPerTask: number;
  maxResearchDurationMs: number;
  maxConcurrentResearchJobs: number;
  /** Never poll a single topic more often than this, regardless of its configured interval. */
  minTopicPollIntervalMinutes: number;
  /** After this many consecutive failures fetching the same canonical URL, back off for backoffMs. */
  failureBackoffThreshold: number;
  failureBackoffMs: number;
}

export const DEFAULT_RESEARCH_LIMITS: ResearchLimitsConfig = {
  maxSearchesPerTask: 5,
  maxFetchesPerTask: 10,
  maxResearchDurationMs: 5 * 60 * 1000,
  maxConcurrentResearchJobs: 2,
  minTopicPollIntervalMinutes: 60,
  failureBackoffThreshold: 3,
  failureBackoffMs: 30 * 60 * 1000,
};

const SETTINGS_KEY = "research.limits.config";

export async function getResearchLimitsConfig(): Promise<ResearchLimitsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_RESEARCH_LIMITS };
  try {
    return { ...DEFAULT_RESEARCH_LIMITS, ...(JSON.parse(row.value) as Partial<ResearchLimitsConfig>) };
  } catch {
    return { ...DEFAULT_RESEARCH_LIMITS };
  }
}

export async function setResearchLimitsConfig(partial: Partial<ResearchLimitsConfig>): Promise<ResearchLimitsConfig> {
  const current = await getResearchLimitsConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Per-task operation budgets (in-process counters, same "not distributed"
// honesty as core/limits - see docs/PHASE2_AUTONOMY.md).
// ---------------------------------------------------------------------------
type OpKind = "search" | "fetch";
const taskOpCounts = new Map<string, { search: number; fetch: number }>();
const concurrentResearchJobs = new Set<string>();
const failureCounts = new Map<string, { count: number; backoffUntil?: number }>();

export async function checkResearchOpBudget(
  taskId: string,
  op: OpKind
): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getResearchLimitsConfig();
  const limit = op === "search" ? limits.maxSearchesPerTask : limits.maxFetchesPerTask;
  const counts = taskOpCounts.get(taskId) ?? { search: 0, fetch: 0 };
  if (counts[op] >= limit) {
    log("SECURITY", "research.op_budget_exceeded", { taskId, op, limit });
    return { allowed: false, reason: `Task "${taskId}" reached its ${op} budget of ${limit}.` };
  }
  counts[op] += 1;
  taskOpCounts.set(taskId, counts);
  return { allowed: true };
}

export function resetResearchOpBudget(taskId: string): void {
  taskOpCounts.delete(taskId);
}

export async function acquireResearchJobSlot(jobId: string): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getResearchLimitsConfig();
  if (concurrentResearchJobs.size >= limits.maxConcurrentResearchJobs) {
    return { allowed: false, reason: `Concurrent research job limit of ${limits.maxConcurrentResearchJobs} reached.` };
  }
  concurrentResearchJobs.add(jobId);
  return { allowed: true };
}

export function releaseResearchJobSlot(jobId: string): void {
  concurrentResearchJobs.delete(jobId);
}

/** Records a fetch failure for `canonicalUrl`; returns whether the source is currently backed off. */
export async function recordFetchFailure(canonicalUrl: string): Promise<void> {
  const limits = await getResearchLimitsConfig();
  const current = failureCounts.get(canonicalUrl) ?? { count: 0 };
  current.count += 1;
  if (current.count >= limits.failureBackoffThreshold) {
    current.backoffUntil = Date.now() + limits.failureBackoffMs;
  }
  failureCounts.set(canonicalUrl, current);
}

export function recordFetchSuccess(canonicalUrl: string): void {
  failureCounts.delete(canonicalUrl);
}

export function isBackedOff(canonicalUrl: string): boolean {
  const current = failureCounts.get(canonicalUrl);
  if (!current?.backoffUntil) return false;
  return Date.now() < current.backoffUntil;
}

/** Test-only: resets all in-process research-limit state. */
export function __resetResearchLimitsForTests(): void {
  taskOpCounts.clear();
  concurrentResearchJobs.clear();
  failureCounts.clear();
}
