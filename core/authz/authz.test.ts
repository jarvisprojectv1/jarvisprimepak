import { describe, it, expect } from "vitest";
import { authorize } from "./index";
import { ownerIdentity, agentIdentity, serviceIdentity, SYSTEM_IDENTITY } from "../auth/identity";

describe("core/authz - Owner Command Authority", () => {
  it("denies any action with no identity", () => {
    const result = authorize(null, "system.emergency_stop");
    expect(result.allowed).toBe(false);
  });

  it("OWNER is authorized for everything, including emergency stop", () => {
    const owner = ownerIdentity("u1", "owner@example.com");
    expect(authorize(owner, "system.emergency_stop").allowed).toBe(true);
    expect(authorize(owner, "chat.use").allowed).toBe(true);
  });

  it("SYSTEM is authorized for internal actions but not emergency stop", () => {
    expect(authorize(SYSTEM_IDENTITY, "agent.run").allowed).toBe(true);
    expect(authorize(SYSTEM_IDENTITY, "system.emergency_stop").allowed).toBe(false);
  });

  it("AGENT is authorized for tool execution but not system mutations", () => {
    const agent = agentIdentity("research");
    expect(authorize(agent, "tool.execute").allowed).toBe(true);
    expect(authorize(agent, "system.pause").allowed).toBe(false);
    expect(authorize(agent, "chat.use").allowed).toBe(false);
  });

  it("SERVICE is authorized only for its narrow allowed set", () => {
    const service = serviceIdentity("integration");
    expect(authorize(service, "tool.execute").allowed).toBe(true);
    expect(authorize(service, "task.write").allowed).toBe(false);
  });

  it("fails closed for an unknown identity kind-action combination", () => {
    const agent = agentIdentity("crm");
    expect(authorize(agent, "system.tool_disable").allowed).toBe(false);
  });
});
