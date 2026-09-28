// core/limits - Rate & Resource Controls (Phase 2 / Step 3, part C).
//
// Simple in-process counters with rolling windows - explicitly NOT a
// distributed rate limiter (see docs/PHASE2_AUTONOMY.md limitations). Limits
// are configurable via the `settings` table (key "limits.config") with sane
// in-code defaults, matching the existing config/env.ts philosophy.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export interface LimitsConfig {
  /** Max calls to a single tool per rolling minute. */
  toolRateLimitPerMinute: number;
  /** Max runs of a single agent per rolling minute. */
  agentRateLimitPerMinute: number;
  /** Max agents allowed to run at the same time, globally. */
  concurrentAgentLimit: number;
  /** Max automatic retries for a single task. */
  retryLimit: number;
  /** Max tasks that may be created in a rolling 24h day. */
  dailyTaskLimit: number;
  /** Max login attempts per rolling minute, keyed by email+IP (Phase 3 auth). */
  loginRateLimitPerMinute: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  toolRateLimitPerMinute: 60,
  agentRateLimitPerMinute: 30,
  concurrentAgentLimit: 5,
  retryLimit: 3,
  dailyTaskLimit: 500,
  loginRateLimitPerMinute: 5,
};

const SETTINGS_KEY = "limits.config";

export async function getLimitsConfig(): Promise<LimitsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_LIMITS };
  try {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(row.value) as Partial<LimitsConfig>) };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

export async function setLimitsConfig(partial: Partial<LimitsConfig>): Promise<LimitsConfig> {
  const current = await getLimitsConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
  });
  return next;
}

// ---------------------------------------------------------------------------
// In-process rolling-window counters
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Bucket {
  windowStart: number;
  count: number;
}

const toolBuckets = new Map<string, Bucket>();
const agentBuckets = new Map<string, Bucket>();
const loginBuckets = new Map<string, Bucket>();
let dailyTaskBucket: Bucket = { windowStart: Date.now(), count: 0 };
const runningAgents = new Set<string>(); // per-invocation tokens, for concurrency accounting

function checkAndBump(buckets: Map<string, Bucket>, key: string, limit: number, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export async function checkToolRate(toolName: string): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getLimitsConfig();
  const allowed = checkAndBump(toolBuckets, toolName, limits.toolRateLimitPerMinute);
  if (!allowed) {
    const reason = `Tool "${toolName}" exceeded its rate limit of ${limits.toolRateLimitPerMinute}/minute.`;
    log("SECURITY", "limits.tool_rate_exceeded", { toolName, limit: limits.toolRateLimitPerMinute });
    return { allowed, reason };
  }
  return { allowed: true };
}

export async function checkAgentRate(agentName: string): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getLimitsConfig();
  const allowed = checkAndBump(agentBuckets, agentName, limits.agentRateLimitPerMinute);
  if (!allowed) {
    const reason = `Agent "${agentName}" exceeded its rate limit of ${limits.agentRateLimitPerMinute}/minute.`;
    log("SECURITY", "limits.agent_rate_exceeded", { agentName, limit: limits.agentRateLimitPerMinute });
    return { allowed, reason };
  }
  return { allowed: true };
}

/**
 * Login attempt rate limiter, keyed by "email:ip" (Phase 3 auth). Same
 * in-process rolling-window pattern as the tool/agent limiters above -
 * intentionally not distributed, see docs/PHASE2_AUTONOMY.md limitations.
 */
export async function checkLoginRate(key: string): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getLimitsConfig();
  const allowed = checkAndBump(loginBuckets, key, limits.loginRateLimitPerMinute);
  if (!allowed) {
    log("SECURITY", "limits.login_rate_exceeded", { key });
    return { allowed, reason: `Too many login attempts. Try again in a minute.` };
  }
  return { allowed: true };
}

export async function checkDailyTaskLimit(): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getLimitsConfig();
  const now = Date.now();
  if (now - dailyTaskBucket.windowStart >= DAY_MS) {
    dailyTaskBucket = { windowStart: now, count: 0 };
  }
  if (dailyTaskBucket.count >= limits.dailyTaskLimit) {
    log("SECURITY", "limits.daily_task_limit_exceeded", { limit: limits.dailyTaskLimit });
    return { allowed: false, reason: `Daily task limit of ${limits.dailyTaskLimit} reached.` };
  }
  dailyTaskBucket.count += 1;
  return { allowed: true };
}

/** Attempts to reserve one concurrent-agent slot. Call releaseAgentSlot(token) when done. */
export async function acquireAgentSlot(
  agentName: string
): Promise<{ allowed: boolean; reason?: string; token?: string }> {
  const limits = await getLimitsConfig();
  if (runningAgents.size >= limits.concurrentAgentLimit) {
    log("SECURITY", "limits.concurrent_agent_limit_exceeded", {
      agentName,
      limit: limits.concurrentAgentLimit,
      currentlyRunning: runningAgents.size,
    });
    return {
      allowed: false,
      reason: `Concurrent-agent limit of ${limits.concurrentAgentLimit} reached.`,
    };
  }
  // Each running invocation gets a unique token so two concurrent runs of the
  // *same* agent both count toward the global concurrency limit.
  const token = `${agentName}:${Date.now()}:${Math.random()}`;
  runningAgents.add(token);
  return { allowed: true, token };
}

export function releaseAgentSlot(token?: string): void {
  if (token) {
    runningAgents.delete(token);
    return;
  }
}

export function currentConcurrentAgentCount(): number {
  return runningAgents.size;
}

export function checkRetryLimit(retryCount: number, limit: number): boolean {
  return retryCount < limit;
}

// ---------------------------------------------------------------------------
// Phase 5 (Autonomous Worker): non-mutating "peek" checks. These read the
// current bucket state WITHOUT bumping the counter, so the worker's
// eligibility pre-filter (core/worker/eligibility.ts) can ask "would this be
// rate-limited right now?" without itself consuming a slot a real call would
// need. The real, consuming checkToolRate/checkAgentRate inside
// core/enforcement remain the ONLY authoritative gate - this is a cheap
// pre-filter to avoid wasted Brain/tool invocations, never a replacement for
// the gate.
// ---------------------------------------------------------------------------
function peek(buckets: Map<string, Bucket>, key: string, limit: number, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) return true;
  return bucket.count < limit;
}

export async function peekToolRate(toolName: string): Promise<boolean> {
  const limits = await getLimitsConfig();
  return peek(toolBuckets, toolName, limits.toolRateLimitPerMinute);
}

export async function peekAgentRate(agentName: string): Promise<boolean> {
  const limits = await getLimitsConfig();
  return peek(agentBuckets, agentName, limits.agentRateLimitPerMinute);
}

export function peekConcurrentAgentSlot(limit: number): boolean {
  return runningAgents.size < limit;
}

/** Test-only: resets all in-process counters. */
export function __resetLimitsForTests(): void {
  toolBuckets.clear();
  agentBuckets.clear();
  loginBuckets.clear();
  dailyTaskBucket = { windowStart: Date.now(), count: 0 };
  runningAgents.clear();
}
