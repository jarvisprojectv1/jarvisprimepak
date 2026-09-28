import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { isTaskEligible } from "./eligibility";
import { setSystemState } from "../state";
import { disableTool, enableTool, pauseAgent, resumeAgent } from "../state";
import { setLimitsConfig, DEFAULT_LIMITS } from "../limits";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";
import type { PlannedTask, TaskPriority, TaskStatus } from "../planner";

function makeTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  const now = new Date();
  return {
    id: "task-1",
    title: "Test task",
    description: null,
    status: "PENDING" as TaskStatus,
    priority: "NORMAL" as TaskPriority,
    retryCount: 0,
    parentId: null,
    dueAt: null,
    stepId: null,
    agentName: null,
    toolName: null,
    waitingReason: null,
    blockedReason: null,
    claimedBy: null,
    claimedAt: null,
    claimExpiresAt: null,
    lastEligibilityCheckAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("core/worker/eligibility - isTaskEligible", () => {
  beforeEach(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await setSystemState("RUNNING", "test cleanup", "test");
    await setLimitsConfig({ ...DEFAULT_LIMITS });
    await enableTool("files");
    await resumeAgent("research");
  });

  it("is eligible for a plain PENDING task with no blockers", async () => {
    const result = await isTaskEligible(makeTask());
    expect(result.eligible).toBe(true);
  });

  it("is not eligible (SKIP) for a DONE/CANCELLED/WAITING/BLOCKED task", async () => {
    for (const status of ["DONE", "CANCELLED", "WAITING", "BLOCKED"] as TaskStatus[]) {
      const result = await isTaskEligible(makeTask({ status }));
      expect(result.eligible).toBe(false);
      expect(result.category).toBe("SKIP");
    }
  });

  it("is WAITING when dueAt is in the future", async () => {
    const result = await isTaskEligible(makeTask({ dueAt: new Date(Date.now() + 60_000) }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("WAITING");
  });

  it("is BLOCKED when the parent task is not yet DONE", async () => {
    const parent = await prisma.task.create({ data: { title: "parent", status: "PENDING" } });
    const result = await isTaskEligible(makeTask({ parentId: parent.id }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
    await prisma.task.delete({ where: { id: parent.id } });
  });

  it("is eligible when the parent task IS done", async () => {
    const parent = await prisma.task.create({ data: { title: "parent-done", status: "DONE" } });
    const result = await isTaskEligible(makeTask({ parentId: parent.id }));
    expect(result.eligible).toBe(true);
    await prisma.task.delete({ where: { id: parent.id } });
  });

  it("is WAITING when the system is not RUNNING", async () => {
    await setSystemState("PAUSED", "test", "test");
    const result = await isTaskEligible(makeTask());
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("WAITING");
  });

  it("is BLOCKED when a tagged agent is paused", async () => {
    await pauseAgent("research", "test");
    const result = await isTaskEligible(makeTask({ agentName: "research" }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
  });

  it("is BLOCKED when a tagged tool is disabled", async () => {
    await disableTool("files", "test");
    const result = await isTaskEligible(makeTask({ toolName: "files" }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
  });

  it("is BLOCKED when a tagged tool is not registered at all", async () => {
    const result = await isTaskEligible(makeTask({ toolName: "does-not-exist" }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
  });

  it("is BLOCKED when the autonomy policy would block the action", async () => {
    const result = await isTaskEligible(makeTask({ title: "financial.transaction" }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
  });

  it("is BLOCKED once retryCount reaches the configured retry limit", async () => {
    await setLimitsConfig({ retryLimit: 2 });
    const result = await isTaskEligible(makeTask({ status: "RETRYING", retryCount: 2 }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("BLOCKED");
  });

  it("applies retry backoff - a just-updated RETRYING task is not immediately eligible", async () => {
    await setLimitsConfig({ retryLimit: 5 });
    const result = await isTaskEligible(makeTask({ status: "RETRYING", retryCount: 1, updatedAt: new Date() }));
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("WAITING");
  });

  it("is eligible again once the retry backoff window has elapsed", async () => {
    await setLimitsConfig({ retryLimit: 5 });
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    const result = await isTaskEligible(makeTask({ status: "RETRYING", retryCount: 1, updatedAt: longAgo }));
    expect(result.eligible).toBe(true);
  });
});
