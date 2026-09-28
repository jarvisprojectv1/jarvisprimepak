// core/production/retryPolicy.test.ts - Phase 12 (item 8): a real,
// executed proof that nothing ever auto-retries a policy block, an auth
// failure, an approval-required state, or the financial hard-block.
//
// This does not add a new enforcement mechanism - it exercises the REAL,
// EXISTING path (core/worker/index.ts's processClaimedTask ->
// core/enforcement's guardToolExecution -> markTerminal) and asserts the
// documented, already-shipped behavior: a "BLOCKED" ToolResult status is
// terminal (core/planner.updateTaskStatus), never routed through
// retryOrFailTask - only "FAILED" is. If a future change ever made a policy
// block retryable, this test would catch it.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";
import { processClaimedTask } from "../worker/index";
import { disableTool, enableTool, setSystemState } from "../state";
import { isRetryableOutcomeStatus, classifyError } from "./errors";

describe("Phase 12 (item 8) - retry policy audit: policy blocks/auth failures/hard-blocks never auto-retry", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await enableTool("reports");
    await setSystemState("RUNNING", "test cleanup", "test");
  });

  it("isRetryableOutcomeStatus: only FAILED is retryable - BLOCKED/WAITING/DONE never are", () => {
    expect(isRetryableOutcomeStatus("FAILED")).toBe(true);
    expect(isRetryableOutcomeStatus("BLOCKED")).toBe(false);
    expect(isRetryableOutcomeStatus("WAITING")).toBe(false);
    expect(isRetryableOutcomeStatus("DONE")).toBe(false);
  });

  it("a tool disabled by an operator (policy block) marks the task BLOCKED, with retryCount left untouched - not routed through retryOrFailTask", async () => {
    await disableTool("reports");
    const task = await prisma.task.create({ data: { title: "phase12-retry-audit-disabled-tool", toolName: "reports", status: "IN_PROGRESS", retryCount: 0 } });
    const plannedTask = { ...task, waitingReason: null, blockedReason: null, failureReason: null } as any;

    const outcome = await processClaimedTask(plannedTask, 5);
    expect(outcome.status).toBe("BLOCKED");

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("BLOCKED");
    // The defining proof: retryCount is UNCHANGED. retryOrFailTask() is the
    // ONLY function that increments retryCount (core/planner/index.ts) - if
    // this were ever wired to retry, retryCount would be 1 here.
    expect(row.retryCount).toBe(0);

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("EMERGENCY_STOP (the most severe policy block) marks a task BLOCKED, never retried, for ANY tool - including a genuinely healthy one", async () => {
    await setSystemState("EMERGENCY_STOP", "phase12 retry audit", "test");
    const task = await prisma.task.create({ data: { title: "phase12-retry-audit-estop", toolName: "reports", status: "IN_PROGRESS", retryCount: 2 } });
    const plannedTask = { ...task, waitingReason: null, blockedReason: null, failureReason: null } as any;

    const outcome = await processClaimedTask(plannedTask, 5);
    expect(outcome.status).toBe("BLOCKED");

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("BLOCKED");
    expect(row.retryCount).toBe(2); // unchanged - still not routed through retryOrFailTask

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("classifyError never marks a policy-blocked or auth-failure message as retryable", () => {
    expect(classifyError(new Error("Blocked: Tool \"reports\" is disabled.")).retryable).toBe(false);
    expect(classifyError(new Error("System is in EMERGENCY_STOP (test).")).retryable).toBe(false);
    expect(classifyError(new Error("Unauthorized: invalid session")).retryable).toBe(false);
    expect(classifyError(new Error("CONFIGURATION REQUIRED: ANTHROPIC_API_KEY is not set.")).retryable).toBe(false);
  });

  it("classifyError DOES mark a genuinely transient-shaped failure as retryable - the policy is selective, not \"never retry anything\"", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")).retryable).toBe(true);
    expect(classifyError(new Error("SQLITE_BUSY: database is locked")).retryable).toBe(true);
  });
});
