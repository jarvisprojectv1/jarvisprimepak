import { describe, it, expect } from "vitest";
import { createWebSearchTool } from "./searchTool";
import { MockSearchProvider, ConfigurationRequiredMockProvider } from "./mockSearchProvider";

describe("tools/web/searchTool - WebSearchTool", () => {
  it("A: returns real results from a mocked search provider", async () => {
    const provider = new MockSearchProvider({
      kind: "results",
      results: [{ title: "Example", url: "https://example.com/a", snippet: "hello", domain: "example.com" }],
    });
    const tool = createWebSearchTool(provider);
    const result = await tool.execute({ query: "apparel packaging" });
    expect(result.status).toBe("OK");
    expect(provider.calls).toEqual(["apparel packaging"]);
    expect((result.data as any).results).toHaveLength(1);
  });

  it("B: returns CONFIGURATION_REQUIRED when the provider has no credentials, never fabricating results", async () => {
    const tool = createWebSearchTool(new ConfigurationRequiredMockProvider());
    const result = await tool.execute({ query: "anything" });
    expect(result.status).toBe("CONFIGURATION_REQUIRED");
    expect(result.data).toBeUndefined();
  });

  it("C: surfaces a search timeout as an honest ERROR, not a silent empty success", async () => {
    const tool = createWebSearchTool(new MockSearchProvider({ kind: "timeout" }));
    const result = await tool.execute({ query: "anything" });
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/timed out/i);
  });

  it("D: surfaces a provider failure as ERROR", async () => {
    const tool = createWebSearchTool(
      new MockSearchProvider({ kind: "error", error: { code: "PROVIDER_ERROR", message: "upstream 500" } })
    );
    const result = await tool.execute({ query: "anything" });
    expect(result.status).toBe("ERROR");
    expect(result.message).toMatch(/upstream 500/);
  });

  it("rejects an empty query without calling the provider", async () => {
    const provider = new MockSearchProvider({ kind: "results", results: [] });
    const tool = createWebSearchTool(provider);
    const result = await tool.execute({ query: "  " });
    expect(result.status).toBe("ERROR");
    expect(provider.calls).toHaveLength(0);
  });

  it("S: enforces the per-task search budget", async () => {
    const provider = new MockSearchProvider({ kind: "results", results: [] });
    const tool = createWebSearchTool(provider);
    const taskId = `budget-test-${Date.now()}`;
    const { setResearchLimitsConfig, __resetResearchLimitsForTests } = await import("../../core/research/limits");
    __resetResearchLimitsForTests();
    await setResearchLimitsConfig({ maxSearchesPerTask: 2 });
    expect((await tool.execute({ query: "q1", taskId })).status).toBe("OK");
    expect((await tool.execute({ query: "q2", taskId })).status).toBe("OK");
    const third = await tool.execute({ query: "q3", taskId });
    expect(third.status).toBe("BLOCKED");
  });
});
