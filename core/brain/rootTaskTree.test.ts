// core/brain/rootTaskTree.test.ts - hardening pass integration tests: the
// generic-worker-delegated-task -> Brain seam, closed via
// `brain.handle(request, identity, { rootTaskId })`. Proves the whole tree
// (root Task + real linked children) is one connected, queryable structure,
// that failure/waiting/blocked propagation onto the root outcome is coherent,
// and that the per-step/per-root AuditLog entries are traceable by task id.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Brain } from "./index";
import type { AIProvider, AICompletionOutcome, AIMessage, CompleteOptions } from "../ai/provider";
import { registerBuiltinTools } from "../../tools";
import { toolRegistry } from "../../tools/registry";
import { registerBuiltinAgents } from "../../agents/registry";
import { setSystemState } from "../state";
import { setLimitsConfig, DEFAULT_LIMITS } from "../limits";
import { prisma } from "../../database/client";

function planToolUse(plan: unknown) {
  return { id: "tu_1", name: "propose_plan", input: plan as Record<string, unknown> };
}

class FakeProvider implements AIProvider {
  name = "fake";
  constructor(private responses: AICompletionOutcome[]) {}
  async complete(_messages: AIMessage[], _options?: CompleteOptions): Promise<AICompletionOutcome> {
    const next = this.responses.shift();
    if (!next) throw new Error("FakeProvider ran out of scripted responses");
    return next;
  }
}

function planResponse(plan: unknown): AICompletionOutcome {
  return {
    ok: true,
    content: "",
    toolUses: [planToolUse(plan)],
    model: "fake-model",
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
  };
}

async function resetState() {
  await setSystemState("RUNNING", "test cleanup", "test");
  await setLimitsConfig({ ...DEFAULT_LIMITS });
}

describe("core/brain rootTaskId - closing the generic worker -> Brain task-tree seam", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await resetState();
  });

  it("A/B: a generic worker task delegated to the Brain results in every step's Task row being a real child (parentId) of the original triggering task - one connected tree, no orphan Brain-created parent", async () => {
    const triggerTask = await prisma.task.create({ data: { title: "generic worker task" } });

    const plan = {
      goal: "Two independent steps",
      reasoning_summary: "test",
      successCriteria: "both steps succeed",
      steps: [
        { stepId: "s1", description: "List files", tool: "files", arguments: { action: "list", path: "." }, expectedResult: "ok", verification: "ok" },
        { stepId: "s2", description: "Run research", agent: "research", arguments: {}, expectedResult: "ok", verification: "ok" },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);

    const result = await brain.handle(
      { message: "do the generic thing" },
      undefined,
      { rootTaskId: triggerTask.id }
    );

    // The Brain's own returned taskId IS the worker's original trigger task -
    // never a second, disconnected parent.
    expect(result.taskId).toBe(triggerTask.id);

    const children = await prisma.task.findMany({ where: { parentId: triggerTask.id } });
    expect(children.length).toBe(2);
    expect(children.map((c) => c.stepId).sort()).toEqual(["s1", "s2"]);
    for (const child of children) {
      expect(child.parentId).toBe(triggerTask.id);
    }

    // No extra, unrelated parent task was created for this plan.
    const allTasksNamedAfterGoal = await prisma.task.findMany({ where: { title: plan.goal } });
    expect(allTasksNamedAfterGoal.length).toBe(0);

    // The trigger task's own row was never overwritten/duplicated - it IS
    // still the same row, now with real children.
    const reloadedTrigger = await prisma.task.findUniqueOrThrow({ where: { id: triggerTask.id } });
    expect(reloadedTrigger.id).toBe(triggerTask.id);

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("C: one child step FAILED after retries exhausted, another SUCCEEDED -> aggregate root outcome is PARTIAL (not silently DONE or FAILED)", async () => {
    // retryLimit=1 so a single tool failure is immediately terminal (FAILED),
    // never RETRYING - deterministic for the test.
    await setLimitsConfig({ ...DEFAULT_LIMITS, retryLimit: 1 });

    const failingTool = {
      name: "test.always-fails",
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { status: "ERROR" as const, message: "simulated failure" };
      },
    };
    if (!toolRegistry.get(failingTool.name)) toolRegistry.register(failingTool);

    const triggerTask = await prisma.task.create({ data: { title: "generic task with one failing step" } });
    const plan = {
      goal: "One succeeds, one fails",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [
        { stepId: "s1", description: "Succeeds", tool: "files", arguments: { action: "list", path: "." }, expectedResult: "ok", verification: "ok" },
        { stepId: "s2", description: "Fails", tool: "test.always-fails", expectedResult: "ok", verification: "ok" },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);

    const result = await brain.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    expect(result.status).toBe("PARTIAL");
    const children = await prisma.task.findMany({ where: { parentId: triggerTask.id } });
    const s1 = children.find((c) => c.stepId === "s1")!;
    const s2 = children.find((c) => c.stepId === "s2")!;
    expect(s1.status).toBe("DONE");
    expect(s2.status).toBe("FAILED");

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("C: every child step FAILED -> aggregate root outcome is FAILED (none succeeded)", async () => {
    await setLimitsConfig({ ...DEFAULT_LIMITS, retryLimit: 1 });
    if (!toolRegistry.get("test.always-fails")) {
      toolRegistry.register({
        name: "test.always-fails",
        description: "test",
        inputSchema: { type: "object" as const, properties: {} },
        async execute() {
          return { status: "ERROR" as const, message: "simulated failure" };
        },
      });
    }

    const triggerTask = await prisma.task.create({ data: { title: "generic task, all steps fail" } });
    const plan = {
      goal: "Both fail",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [
        { stepId: "s1", description: "Fails", tool: "test.always-fails", expectedResult: "ok", verification: "ok" },
        { stepId: "s2", description: "Also fails", tool: "test.always-fails", expectedResult: "ok", verification: "ok" },
      ],
    };
    // Every step failing makes the overall run FAILED, which triggers the
    // Brain's existing single documented re-plan attempt (docs/PHASE4_BRAIN_MEMORY.md
    // #3.11) - script a second identical plan response for that retry.
    const provider = new FakeProvider([planResponse(plan), planResponse(plan)]);
    const brain = new Brain(provider);

    const result = await brain.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    expect(result.status).toBe("FAILED");
    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("D: a child step returning REQUIRES_TOOL (the WAITING-equivalent per-step status) alongside a SUCCESS step -> root stays REQUIRES_TOOL, never silently overwritten to SUCCESS by the other step", async () => {
    const triggerTask = await prisma.task.create({ data: { title: "generic task, one step needs an unconfigured tool" } });
    const plan = {
      goal: "One succeeds, one needs an unconfigured tool",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [
        { stepId: "s1", description: "Succeeds", tool: "files", arguments: { action: "list", path: "." }, expectedResult: "ok", verification: "ok" },
        { stepId: "s2", description: "Needs web search (not configured)", tool: "web", arguments: { query: "x" }, expectedResult: "ok", verification: "ok" },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);

    const result = await brain.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    expect(result.status).toBe("REQUIRES_TOOL");
    const children = await prisma.task.findMany({ where: { parentId: triggerTask.id } });
    const s1 = children.find((c) => c.stepId === "s1")!;
    const s2 = children.find((c) => c.stepId === "s2")!;
    expect(s1.status).toBe("DONE");
    expect(s2.status).toBe("WAITING"); // REQUIRES_TOOL maps to Task status WAITING

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("F: PAUSED mid-tree halts the remaining dependent step, and that step's REAL child Task row is BLOCKED (consistent, no orphaned/half-updated state)", async () => {
    const pausingTool = {
      name: "test.pausing-tool-tree",
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        await setSystemState("PAUSED", "paused mid-plan by test tool", "test");
        return { status: "OK" as const, message: "did the first thing" };
      },
    };
    if (!toolRegistry.get(pausingTool.name)) toolRegistry.register(pausingTool);
    const secondTool = {
      name: "test.should-not-run-tree",
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { status: "OK" as const, message: "should never run" };
      },
    };
    if (!toolRegistry.get(secondTool.name)) toolRegistry.register(secondTool);

    const triggerTask = await prisma.task.create({ data: { title: "generic task, paused mid-plan" } });
    const plan = {
      goal: "Two-step plan, paused after step 1",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [
        { stepId: "s1", description: "Pauses the system", tool: "test.pausing-tool-tree", expectedResult: "ok", verification: "ok" },
        { stepId: "s2", description: "Should be halted", tool: "test.should-not-run-tree", expectedResult: "ok", verification: "ok", dependsOn: ["s1"] },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);

    const result = await brain.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    expect(result.status).toBe("BLOCKED");
    const children = await prisma.task.findMany({ where: { parentId: triggerTask.id } });
    const s1 = children.find((c) => c.stepId === "s1")!;
    const s2 = children.find((c) => c.stepId === "s2")!;
    expect(s1.status).toBe("DONE");
    expect(s2.status).toBe("BLOCKED");

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("H: AuditLog entries for both the root and its real children are queryable by task id (target)", async () => {
    const triggerTask = await prisma.task.create({ data: { title: "audited generic task" } });
    const plan = {
      goal: "One step, audited",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [{ stepId: "s1", description: "List files", tool: "files", arguments: { action: "list", path: "." }, expectedResult: "ok", verification: "ok" }],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);

    await brain.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    const child = await prisma.task.findFirstOrThrow({ where: { parentId: triggerTask.id, stepId: "s1" } });
    const childAudit = await prisma.auditLog.findMany({ where: { target: child.id } });
    expect(childAudit.length).toBeGreaterThan(0);
    expect(childAudit.some((a) => a.action === "brain.step_outcome")).toBe(true);
    const meta = JSON.parse(childAudit[0].meta!);
    expect(meta.stepId).toBe("s1");

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });

  it("E (end-to-end): retrying the root task (re-invoking the Brain with the same rootTaskId) never creates a second set of child tasks", async () => {
    const triggerTask = await prisma.task.create({ data: { title: "root retried end-to-end" } });
    const plan = {
      goal: "Single step plan",
      reasoning_summary: "test",
      successCriteria: "n/a",
      steps: [{ stepId: "s1", description: "List files", tool: "files", arguments: { action: "list", path: "." }, expectedResult: "ok", verification: "ok" }],
    };

    const brain1 = new Brain(new FakeProvider([planResponse(plan)]));
    await brain1.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });
    const countAfterFirst = await prisma.task.count({ where: { parentId: triggerTask.id } });
    expect(countAfterFirst).toBe(1);

    // The worker would retry by re-invoking the Brain with the SAME
    // rootTaskId. The prior child (from a real tool call) is now DONE
    // (terminal), so planFromPlan is entitled to plan fresh - but re-running
    // with the identical plan/stepId, the point being proven here is that
    // repeated Brain invocations against the same root never leave two
    // live, duplicate-and-diverging sets of children at once. To exercise
    // the "still in-flight" branch specifically (the actual retry-guard
    // path), reset the existing child back to a non-terminal status first,
    // simulating a retry fired while the previous attempt hadn't finished.
    await prisma.task.updateMany({ where: { parentId: triggerTask.id }, data: { status: "RETRYING" } });

    const brain2 = new Brain(new FakeProvider([planResponse(plan)]));
    await brain2.handle({ message: "run it" }, undefined, { rootTaskId: triggerTask.id });

    const countAfterRetry = await prisma.task.count({ where: { parentId: triggerTask.id } });
    expect(countAfterRetry).toBe(1); // still exactly one child - no duplicate set

    await prisma.task.deleteMany({ where: { OR: [{ id: triggerTask.id }, { parentId: triggerTask.id }] } });
  });
});
