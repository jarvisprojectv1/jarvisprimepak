import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { checkCostLimit, setCostControlConfig, DEFAULT_COST_CONTROL } from "./costControl";
import { planTask } from "../planner";

describe("core/ai/costControl", () => {
  afterEach(async () => {
    await setCostControlConfig({ ...DEFAULT_COST_CONTROL });
    await prisma.aiUsage.deleteMany({ where: { model: "test-model" } });
  });

  it("allows a call when spend is under both limits", async () => {
    await setCostControlConfig({ dailyLimitUsd: 100, monthlyLimitUsd: 1000 });
    const result = await checkCostLimit();
    expect(result.allowed).toBe(true);
  });

  it("denies a call once the daily limit is reached and raises a notification", async () => {
    await setCostControlConfig({ dailyLimitUsd: 0.0001, monthlyLimitUsd: 1000 });
    await prisma.aiUsage.create({
      data: {
        provider: "test",
        model: "test-model",
        inputTokens: 1_000_000,
        outputTokens: 0,
        estimatedCostUsd: 1,
      },
    });

    const beforeCount = await prisma.notification.count();
    const result = await checkCostLimit();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily AI cost limit");
    const afterCount = await prisma.notification.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it("moves an associated task to WAITING when the cost limit is exceeded", async () => {
    await setCostControlConfig({ dailyLimitUsd: 0.0001, monthlyLimitUsd: 1000 });
    await prisma.aiUsage.create({
      data: { provider: "test", model: "test-model", inputTokens: 1_000_000, outputTokens: 0, estimatedCostUsd: 1 },
    });
    const [task] = await planTask({ title: "cost-limited-task" });
    const result = await checkCostLimit(task.id);
    expect(result.allowed).toBe(false);
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe("WAITING");
  });
});
