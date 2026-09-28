// core/ai/usage.ts - persists every LLM call's real token usage and an
// approximate estimated cost (core/ai/pricing.ts). Never logs the API key or
// raw prompt/response text - only counts and metadata, and everything that
// does pass through log() is redacted first (security/redact.ts).
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { estimateCostUsd } from "./pricing";

export interface RecordUsageInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  taskId?: string | null;
  agentName?: string | null;
}

export interface UsageRecord extends RecordUsageInput {
  id: string;
  estimatedCostUsd: number;
  createdAt: Date;
}

export async function recordAiUsage(input: RecordUsageInput): Promise<UsageRecord> {
  const estimatedCostUsd = estimateCostUsd(input.model, input.inputTokens, input.outputTokens);
  const row = await prisma.aiUsage.create({
    data: {
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCostUsd,
      taskId: input.taskId ?? null,
      agentName: input.agentName ?? null,
    },
  });
  // Only counts/ids/model name are logged - never prompt/response content.
  log("BUSINESS", "ai.usage_recorded", {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    estimatedCostUsd,
    taskId: input.taskId,
    agentName: input.agentName,
  });
  return row;
}

/** Sums estimatedCostUsd for AiUsage rows created since `since`. */
export async function sumCostSince(since: Date): Promise<number> {
  const result = await prisma.aiUsage.aggregate({
    _sum: { estimatedCostUsd: true },
    where: { createdAt: { gte: since } },
  });
  return result._sum.estimatedCostUsd ?? 0;
}

export interface UsageSummary {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
}

export async function summarizeUsageSince(since: Date): Promise<UsageSummary> {
  const rows = await prisma.aiUsage.findMany({ where: { createdAt: { gte: since } } });
  return {
    callCount: rows.length,
    totalInputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
    totalEstimatedCostUsd: rows.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
  };
}

export function startOfDayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
