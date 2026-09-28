import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../../database/client";
import {
  getSystemState,
  setSystemState,
  pauseAgent,
  resumeAgent,
  isAgentPaused,
  disableTool,
  enableTool,
  isToolDisabled,
  emergencyStop,
  recover,
} from "./index";

async function resetAllState() {
  await setSystemState("RUNNING", "test cleanup", "test");
  await prisma.setting.deleteMany({
    where: { key: { in: ["system.paused_agents", "system.disabled_tools"] } },
  });
}

describe("core/state", () => {
  afterEach(async () => {
    await resetAllState();
  });

  it("defaults to RUNNING", async () => {
    await resetAllState();
    const state = await getSystemState();
    expect(state.state).toBe("RUNNING");
  });

  it("persists a state change with reason and actor", async () => {
    await setSystemState("MAINTENANCE", "scheduled maintenance", "alice");
    const state = await getSystemState();
    expect(state.state).toBe("MAINTENANCE");
    expect(state.reason).toBe("scheduled maintenance");
    expect(state.actor).toBe("alice");
  });

  it("pauses and resumes a single named agent", async () => {
    expect(await isAgentPaused("research")).toBe(false);
    await pauseAgent("research", "alice");
    expect(await isAgentPaused("research")).toBe(true);
    expect(await isAgentPaused("crm")).toBe(false); // only the named agent
    await resumeAgent("research", "alice");
    expect(await isAgentPaused("research")).toBe(false);
  });

  it("disables and enables a single named tool", async () => {
    expect(await isToolDisabled("files")).toBe(false);
    await disableTool("files", "alice");
    expect(await isToolDisabled("files")).toBe(true);
    expect(await isToolDisabled("email")).toBe(false); // only the named tool
    await enableTool("files", "alice");
    expect(await isToolDisabled("files")).toBe(false);
  });

  it("emergencyStop sets EMERGENCY_STOP and pauses every registered agent/tool", async () => {
    // Ensure builtins are registered so the sets are non-empty.
    const { registerBuiltinAgents } = await import("../../agents/registry");
    const { registerBuiltinTools } = await import("../../tools");
    registerBuiltinAgents();
    registerBuiltinTools();

    await emergencyStop("alice", "test emergency");
    const state = await getSystemState();
    expect(state.state).toBe("EMERGENCY_STOP");
    expect(await isAgentPaused("research")).toBe(true);
    expect(await isAgentPaused("crm")).toBe(true);
    expect(await isToolDisabled("files")).toBe(true);
  });

  it("recover() returns state to RUNNING without auto-resuming agents/tools", async () => {
    await emergencyStop("alice", "test emergency");
    await recover("alice", "all clear");
    const state = await getSystemState();
    expect(state.state).toBe("RUNNING");
    // Safe recovery: paused agents/disabled tools stay as they were.
    expect(await isAgentPaused("research")).toBe(true);
  });
});
