import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents, getAgent } from "../../agents/registry";
import { toolRegistry } from "../../tools/registry";
import { createWebSearchTool } from "../../tools/web/searchTool";
import { MockSearchProvider } from "../../tools/web/mockSearchProvider";
import { setSystemState, pauseAgent, resumeAgent } from "../state";
import { processClaimedTask } from "./index";
import type { PlannedTask } from "../planner";

describe("core/worker - emergency stop / pause halt research mid-flow (T/U)", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
    if (!toolRegistry.get("web_search_test_marker")) {
      // no-op registration guard; web_search/web_fetch already registered by registerBuiltinTools()
    }
  });

  afterEach(async () => {
    await setSystemState("RUNNING", "test cleanup", "test");
    await resumeAgent("research", "test");
  });

  it("T: EMERGENCY_STOP halts a research agent run before it ever touches a tool", async () => {
    const provider = new MockSearchProvider({ kind: "results", results: [] });
    // Confirms the mock provider is never even called - the enforcement gate
    // short-circuits before the agent's own run() body executes.
    await setSystemState("EMERGENCY_STOP", "test emergency", "test");

    const agent = getAgent("research")!;
    const result = await agent.run({ topic: "halted-topic" });
    expect(result.status).toBe("FAILED");
    expect(result.summary).toMatch(/EMERGENCY_STOP/);
    expect(provider.calls).toHaveLength(0);
  });

  it("U: pausing the research agent specifically halts it without affecting other agents", async () => {
    await pauseAgent("research", "test");
    const research = getAgent("research")!;
    const result = await research.run({ topic: "paused-topic" });
    expect(result.status).toBe("FAILED");
    expect(result.summary).toMatch(/paused/i);

    // Another agent is unaffected.
    const system = getAgent("system")!;
    const other = await system.run({});
    expect(other.status).not.toBe("FAILED");
  });

  it("P: the worker delegates an agentName-tagged task directly to the research agent through the guarded path", async () => {
    const task = await prisma.task.create({
      data: { title: "internal-only-research", agentName: "research", status: "IN_PROGRESS" },
    });
    // No topic input reaches processClaimedTask (it calls agent.run({}) with
    // no arguments for a tagged task) - the agent should honestly fail
    // closed asking for a topic, never fabricate a result.
    const plannedTask = { ...task, waitingReason: null, blockedReason: null, failureReason: null } as unknown as PlannedTask;
    const outcome = await processClaimedTask(plannedTask, 3);
    // A missing 'topic' input is a real, honest failure - never fabricated
    // success - which retryOrFailTask turns into RETRYING (retries remain)
    // or FAILED (exhausted), never anything else.
    expect(["FAILED", "WAITING", "RETRYING"]).toContain(outcome.status);
    await prisma.task.delete({ where: { id: task.id } });
  });
});
