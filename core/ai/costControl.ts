// core/ai/costControl.ts - Cost Control (Phase 4 / Brain & Memory).
//
// Configurable daily/monthly USD spend limits, backed by the `settings`
// table (same pattern as core/limits' `limits.config`), with sane defaults
// when unset. Checked BEFORE every LLM call the Brain makes; a call that
// would exceed either limit is refused (no API call is made), a Notification
// is raised, and (if there's an associated task) that task is moved to
// WAITING rather than silently failing or fabricating a response.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { notificationService } from "../notifications";
import { updateTaskStatus } from "../planner";
import { sumCostSince, startOfDayUtc, startOfMonthUtc } from "./usage";

export interface CostControlConfig {
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

export const DEFAULT_COST_CONTROL: CostControlConfig = {
  dailyLimitUsd: 5,
  monthlyLimitUsd: 50,
};

const SETTINGS_KEY = "ai.cost_control";

export async function getCostControlConfig(): Promise<CostControlConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_COST_CONTROL };
  try {
    return { ...DEFAULT_COST_CONTROL, ...(JSON.parse(row.value) as Partial<CostControlConfig>) };
  } catch {
    return { ...DEFAULT_COST_CONTROL };
  }
}

export async function setCostControlConfig(
  partial: Partial<CostControlConfig>
): Promise<CostControlConfig> {
  const current = await getCostControlConfig();
  const next = { ...current, ...partial };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
  });
  return next;
}

export interface CostCheckResult {
  allowed: boolean;
  reason?: string;
  dailySpentUsd: number;
  monthlySpentUsd: number;
}

/**
 * Checks cumulative AiUsage spend for the current UTC day/month against the
 * configured limits. Does NOT make the LLM call itself - callers (the Brain)
 * must check this BEFORE calling AIProvider.complete() and skip the call
 * entirely if `allowed` is false.
 */
export async function checkCostLimit(taskId?: string | null): Promise<CostCheckResult> {
  const config = await getCostControlConfig();
  const [dailySpentUsd, monthlySpentUsd] = await Promise.all([
    sumCostSince(startOfDayUtc()),
    sumCostSince(startOfMonthUtc()),
  ]);

  if (dailySpentUsd >= config.dailyLimitUsd) {
    return await denyAndNotify(
      `Daily AI cost limit reached ($${dailySpentUsd.toFixed(4)} spent of $${config.dailyLimitUsd} limit).`,
      dailySpentUsd,
      monthlySpentUsd,
      taskId
    );
  }
  if (monthlySpentUsd >= config.monthlyLimitUsd) {
    return await denyAndNotify(
      `Monthly AI cost limit reached ($${monthlySpentUsd.toFixed(4)} spent of $${config.monthlyLimitUsd} limit).`,
      dailySpentUsd,
      monthlySpentUsd,
      taskId
    );
  }

  return { allowed: true, dailySpentUsd, monthlySpentUsd };
}

async function denyAndNotify(
  reason: string,
  dailySpentUsd: number,
  monthlySpentUsd: number,
  taskId?: string | null
): Promise<CostCheckResult> {
  log("BUSINESS", "ai.cost_limit_exceeded", { reason, dailySpentUsd, monthlySpentUsd, taskId });
  try {
    await notificationService.create({
      title: "AI cost limit reached",
      body: reason,
      type: "ACTION_REQUIRED",
    });
  } catch (err) {
    log("WARNING", "ai.cost_limit_notification_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (taskId) {
    try {
      await updateTaskStatus(taskId, "WAITING");
    } catch (err) {
      log("WARNING", "ai.cost_limit_task_update_failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { allowed: false, reason, dailySpentUsd, monthlySpentUsd };
}
