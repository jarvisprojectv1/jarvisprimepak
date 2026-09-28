import { describe, it, expect } from "vitest";
import { checkAgentResultContract } from "./contract";

describe("agents/contract - checkAgentResultContract", () => {
  it("passes a SUCCESS result that has real evidence", () => {
    const check = checkAgentResultContract({ status: "SUCCESS", evidence: { rowCount: 3 } });
    expect(check.ok).toBe(true);
  });

  it("passes a SUCCESS result whose evidence is carried in `data` or `result` instead", () => {
    expect(checkAgentResultContract({ status: "SUCCESS", data: { id: "abc" } }).ok).toBe(true);
    expect(checkAgentResultContract({ status: "SUCCESS", result: { id: "abc" } }).ok).toBe(true);
  });

  it("catches an agent claiming SUCCESS with no evidence/data/result at all", () => {
    const check = checkAgentResultContract({ status: "SUCCESS" });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("no evidence");
  });

  it("catches an agent claiming SUCCESS with empty evidence objects/arrays", () => {
    expect(checkAgentResultContract({ status: "SUCCESS", evidence: {} }).ok).toBe(false);
    expect(checkAgentResultContract({ status: "SUCCESS", evidence: [] }).ok).toBe(false);
  });

  it("never flags a non-SUCCESS result, even with no evidence", () => {
    expect(checkAgentResultContract({ status: "FAILED" }).ok).toBe(true);
    expect(checkAgentResultContract({ status: "NOT_IMPLEMENTED" }).ok).toBe(true);
  });

  it("real built-in agents' SUCCESS paths satisfy the contract", async () => {
    const { registerBuiltinAgents, getAgent } = await import("./registry");
    registerBuiltinAgents();
    const result = await getAgent("crm")!.run({});
    if (result.status === "SUCCESS") {
      expect(checkAgentResultContract(result).ok).toBe(true);
    }
  });
});
