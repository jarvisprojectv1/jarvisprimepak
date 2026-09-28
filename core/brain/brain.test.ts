import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Brain } from "./index";
import type { AIProvider, AICompletionOutcome, AIMessage, CompleteOptions } from "../ai/provider";
import { registerBuiltinTools } from "../../tools";
import { toolRegistry } from "../../tools/registry";
import { registerBuiltinAgents } from "../../agents/registry";
import { setSystemState } from "../state";
import { prisma } from "../../database/client";

function planToolUse(plan: unknown) {
  return { id: "tu_1", name: "propose_plan", input: plan as Record<string, unknown> };
}

/** A fully controllable fake AIProvider - never touches the real Anthropic API. */
class FakeProvider implements AIProvider {
  name = "fake";
  constructor(private responses: AICompletionOutcome[]) {}
  private calls: { messages: AIMessage[]; options?: CompleteOptions }[] = [];
  async complete(messages: AIMessage[], options?: CompleteOptions): Promise<AICompletionOutcome> {
    this.calls.push({ messages, options });
    const next = this.responses.shift();
    if (!next) throw new Error("FakeProvider ran out of scripted responses");
    return next;
  }
  get callCount() {
    return this.calls.length;
  }
}

function textResponse(content: string): AICompletionOutcome {
  return { ok: true, content, toolUses: [], model: "fake-model", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } };
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
  await prisma.setting.deleteMany({
    where: { key: { in: ["system.paused_agents", "system.disabled_tools"] } },
  });
}

describe("core/brain - the JARVIS Brain", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await resetState();
  });

  it("a plain conversational request with no tool_use returns the text reply directly (backward-compatible simple chat)", async () => {
    const provider = new FakeProvider([textResponse("Hello, human.")]);
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "hi", conversationId: `t-${Date.now()}` });
    expect(result.status).toBe("SUCCESS");
    expect(result.reply).toBe("Hello, human.");
  });

  it("never calls a tool/agent outside toolRegistry.execute()/agent.run() - proven by the disabled-tool gate still applying to a Brain-driven step", async () => {
    const { disableTool, enableTool } = await import("../state");
    await disableTool("files");

    const plan = {
      goal: "List sandbox files",
      reasoning_summary: "Need a directory listing.",
      successCriteria: "Files are listed.",
      steps: [
        {
          stepId: "s1",
          description: "List files",
          tool: "files",
          arguments: { action: "list", path: "." },
          expectedResult: "A file listing",
          verification: "Tool returns OK",
        },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "list my files", conversationId: `t-${Date.now()}` });

    // If the Brain had a bypass path, the disabled-tool gate (core/enforcement,
    // via core/state) would never see this call and the step would "succeed."
    // Because it genuinely goes through toolRegistry.execute(), it's BLOCKED.
    expect(result.steps?.[0].status).toBe("BLOCKED");
    expect(result.status).toBe("BLOCKED");

    await enableTool("files");
  });

  it("halts additional steps when the system is PAUSED before the run starts", async () => {
    await setSystemState("PAUSED", "test", "test");
    const provider = new FakeProvider([]); // should never even reach the AI call
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "do something", conversationId: `t-${Date.now()}` });
    expect(result.status).toBe("BLOCKED");
    expect(provider.callCount).toBe(0);
  });

  it("halts remaining dependent steps when the system is paused mid-plan, rather than running the whole plan", async () => {
    const pausingTool = {
      name: "test.pausing-tool",
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        await setSystemState("PAUSED", "paused mid-plan by test tool", "test");
        return { status: "OK" as const, message: "did the first thing" };
      },
    };
    if (!toolRegistry.get(pausingTool.name)) toolRegistry.register(pausingTool);

    const secondTool = {
      name: "test.should-not-run",
      description: "test",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { status: "OK" as const, message: "should never run" };
      },
    };
    if (!toolRegistry.get(secondTool.name)) toolRegistry.register(secondTool);

    const plan = {
      goal: "Two-step plan where the system pauses after step 1",
      reasoning_summary: "Testing mid-plan halting.",
      successCriteria: "Both steps run.",
      steps: [
        {
          stepId: "s1",
          description: "First step (pauses the system as a side effect)",
          tool: "test.pausing-tool",
          expectedResult: "ok",
          verification: "ok",
        },
        {
          stepId: "s2",
          description: "Second step (should be halted)",
          tool: "test.should-not-run",
          expectedResult: "ok",
          verification: "ok",
          dependsOn: ["s1"],
        },
      ],
    };

    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "run the two-step plan", conversationId: `t-${Date.now()}` });

    expect(result.steps?.find((s) => s.stepId === "s1")?.status).toBe("SUCCESS");
    expect(result.steps?.find((s) => s.stepId === "s2")?.status).toBe("BLOCKED");
  });

  it("honestly reports REQUIRES_TOOL rather than fabricating success when a step needs an unconfigured tool", async () => {
    const plan = {
      goal: "Find 50 apparel prospects",
      reasoning_summary: "This needs open-web search, which is not configured.",
      successCriteria: "50 qualified prospects are found.",
      steps: [
        {
          stepId: "s1",
          description: "Search the web for apparel companies",
          tool: "web",
          arguments: { query: "apparel manufacturers" },
          expectedResult: "A list of prospects",
          verification: "The tool returns real search results",
        },
      ],
    };
    const provider = new FakeProvider([planResponse(plan)]);
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "find me 50 apparel prospects", conversationId: `t-${Date.now()}` });

    expect(result.status).toBe("REQUIRES_TOOL");
    expect(result.steps?.[0].status).toBe("REQUIRES_TOOL");
    expect(result.reply).not.toMatch(/found 50/i);
  });

  it("rejects an invalid plan (fails closed) without executing any step", async () => {
    const spy = vi.spyOn(toolRegistry, "execute");
    const invalidPlan = { goal: "bad plan", reasoning_summary: "x", successCriteria: "x", steps: [] };
    const provider = new FakeProvider([planResponse(invalidPlan)]);
    const brain = new Brain(provider);
    const result = await brain.handle({ message: "do a bad plan", conversationId: `t-${Date.now()}` });

    expect(result.status).toBe("FAILED");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
