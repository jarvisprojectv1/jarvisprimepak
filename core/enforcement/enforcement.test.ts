import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { toolRegistry, type Tool } from "../../tools/registry";
import { filesTool } from "../../tools/files";
import { registerAgent, getAgent } from "../../agents/registry";
import type { AgentInterface, AgentRunResult, AgentStatus } from "../../agents/types";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";
import {
  setSystemState,
  getSystemState,
  pauseAgent,
  resumeAgent,
  disableTool,
  enableTool,
  emergencyStop,
} from "../state";
import { setLimitsConfig, DEFAULT_LIMITS, __resetLimitsForTests } from "../limits";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlowTestAgent implements AgentInterface {
  name: string;
  objective = "test agent";
  status: AgentStatus = "IDLE";
  private delayMs: number;

  constructor(name: string, delayMs = 30) {
    this.name = name;
    this.delayMs = delayMs;
  }

  async run(): Promise<AgentRunResult> {
    await delay(this.delayMs);
    return { status: "SUCCESS", summary: `${this.name} ran` };
  }
}

async function resetGates() {
  await setSystemState("RUNNING", "test cleanup", "test");
  await prisma.setting.deleteMany({
    where: { key: { in: ["system.paused_agents", "system.disabled_tools"] } },
  });
  __resetLimitsForTests();
  await setLimitsConfig({ ...DEFAULT_LIMITS });
}

describe("core/enforcement - the single enforcement gate", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await resetGates();
  });

  it("executes an AUTONOMOUS tool call normally with no blocking", async () => {
    const result = await toolRegistry.execute("files", { action: "list", path: "." });
    expect(result.status).not.toBe("BLOCKED");
  });

  it("short-circuits a hardcoded-BLOCKED action with no execution at all", async () => {
    let executed = false;
    const blockedTool: Tool = {
      name: "financial.transaction",
      description: "test",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        executed = true;
        return { status: "OK", message: "should never run" };
      },
    };
    toolRegistry.register(blockedTool);

    const result = await toolRegistry.execute("financial.transaction", {});
    expect(result.status).toBe("BLOCKED");
    expect(executed).toBe(false);
  });

  it("executes a NOTIFY-level tool and writes a Notification row", async () => {
    const beforeCount = await prisma.notification.count();
    const result = await toolRegistry.execute("email", { action: "send" });
    expect(result.status).not.toBe("BLOCKED"); // NOTIFY still executes
    const afterCount = await prisma.notification.count();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it("blocks all execution when the system is globally PAUSED", async () => {
    await setSystemState("PAUSED", "test pause", "test");
    const result = await toolRegistry.execute("files", { action: "list", path: "." });
    expect(result.status).toBe("BLOCKED");
  });

  it("blocks only the paused agent, not others", async () => {
    registerAgent(new SlowTestAgent("pausable-agent-a", 1));
    registerAgent(new SlowTestAgent("pausable-agent-b", 1));

    await pauseAgent("pausable-agent-a");

    const blocked = await getAgent("pausable-agent-a")!.run();
    const notBlocked = await getAgent("pausable-agent-b")!.run();

    expect(blocked.status).toBe("FAILED");
    expect(blocked.summary).toContain("BLOCKED");
    expect(notBlocked.status).toBe("SUCCESS");

    await resumeAgent("pausable-agent-a");
  });

  it("blocks only the disabled tool, not others", async () => {
    await disableTool("files");
    const filesResult = await toolRegistry.execute("files", { action: "list", path: "." });
    const emailResult = await toolRegistry.execute("email", { action: "send" });
    expect(filesResult.status).toBe("BLOCKED");
    expect(emailResult.status).not.toBe("BLOCKED");
    await enableTool("files");
  });

  it("emergency stop blocks all tools and pauses all agents", async () => {
    await emergencyStop("test", "drill");
    const state = await getSystemState();
    expect(state.state).toBe("EMERGENCY_STOP");

    const toolResult = await toolRegistry.execute("files", { action: "list", path: "." });
    expect(toolResult.status).toBe("BLOCKED");

    const agentResult = await getAgent("research")!.run({ topic: "x" });
    expect(agentResult.status).toBe("FAILED");
    expect(agentResult.summary).toContain("EMERGENCY_STOP");
  });

  it("blocks a tool once its rate limit is exceeded", async () => {
    await setLimitsConfig({ toolRateLimitPerMinute: 1 });
    const first = await toolRegistry.execute("files", { action: "list", path: "." });
    const second = await toolRegistry.execute("files", { action: "list", path: "." });
    expect(first.status).not.toBe("BLOCKED");
    expect(second.status).toBe("BLOCKED");
  });

  it("allows concurrent agents up to the limit and blocks the one past it", async () => {
    await setLimitsConfig({ concurrentAgentLimit: 2 });
    registerAgent(new SlowTestAgent("concurrent-agent-a", 50));
    registerAgent(new SlowTestAgent("concurrent-agent-b", 50));
    registerAgent(new SlowTestAgent("concurrent-agent-c", 50));

    const [a, b, c] = await Promise.all([
      getAgent("concurrent-agent-a")!.run(),
      getAgent("concurrent-agent-b")!.run(),
      getAgent("concurrent-agent-c")!.run(),
    ]);

    const statuses = [a.status, b.status, c.status];
    expect(statuses.filter((s) => s === "SUCCESS").length).toBe(2);
    expect(statuses.filter((s) => s === "FAILED").length).toBe(1);
  });

  it("writes an audit log entry for both allowed and blocked actions, redacting secrets", async () => {
    const secret = "sk-thisisasecretvalue1234567890";
    await toolRegistry.execute("files", { action: "list", path: ".", apiKey: secret });
    await disableTool("files");
    await toolRegistry.execute("files", { action: "list", path: ".", apiKey: secret });
    await enableTool("files");

    const entries = await prisma.auditLog.findMany({
      where: { target: "files" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.meta ?? "").not.toContain(secret);
    }
    const blockedEntry = entries.find((e) => e.action.startsWith("tool.blocked"));
    expect(blockedEntry).toBeDefined();
  });

  it("cannot be bypassed: calling the tool's own execute() directly is still gated", async () => {
    // filesTool is the SAME object mutated by ToolRegistry.register() -
    // there is no unguarded execute left on it, even for a caller that
    // imports the module directly instead of going through the registry.
    await disableTool("files");
    const direct = await filesTool.execute({ action: "list", path: "." });
    expect(direct.status).toBe("BLOCKED");
    await enableTool("files");
  });
});
