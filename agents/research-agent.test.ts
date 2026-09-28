import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ResearchAgent } from "./research-agent";
import { toolRegistry } from "../tools/registry";
import { createWebSearchTool } from "../tools/web/searchTool";
import { webFetchTool } from "../tools/web/fetchTool";
import { MockSearchProvider } from "../tools/web/mockSearchProvider";
import { startTestServer, type TestServerHandle } from "../tools/web/testServer";
import { __resetResearchLimitsForTests } from "../core/research/limits";
import { prisma } from "../database/client";

let handle: TestServerHandle;
let provider: MockSearchProvider;

beforeAll(async () => {
  handle = await startTestServer({
    "/source-a": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Source A</title></head><body><p>Apparel packaging exports grew, according to industry data.</p></body></html>");
    },
    "/source-b": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Source B</title></head><body><p>Sustainable packaging adoption may increase next year.</p></body></html>");
    },
    "/unreachable": (_req, res) => {
      res.writeHead(500).end("boom");
    },
  });

  provider = new MockSearchProvider({
    kind: "results",
    results: [
      { title: "Source A", url: `${handle.url}/source-a`, snippet: "growth", domain: "127.0.0.1" },
      { title: "Source B", url: `${handle.url}/source-b`, snippet: "sustainable", domain: "127.0.0.1" },
    ],
  });

  // Register real web_search/web_fetch tools backed by a mock provider + the
  // real fetch tool pointed at the local test server - the SAME
  // toolRegistry.execute() path the agent uses, no bypass.
  toolRegistry.register(createWebSearchTool(provider));
  toolRegistry.register(webFetchTool);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  __resetResearchLimitsForTests();
});

describe("agents/research-agent - upgraded for real (but controlled) web research", () => {
  it("P/Q: produces real evidence + a memory entry when internal knowledge is absent and web tools are configured", async () => {
    const agent = new ResearchAgent();
    const topic = `apparel-packaging-test-${Date.now()}`;
    const result = await agent.run({ topic });

    expect(result.status).toBe("SUCCESS");
    expect(result.evidence).toBeDefined();
    const evidence = result.evidence as { evidenceIds: string[]; sourceCount: number };
    expect(evidence.sourceCount).toBeGreaterThan(0);
    expect(evidence.evidenceIds.length).toBeGreaterThan(0);

    const memories = await prisma.memory.findMany({ where: { key: `research:${topic}` } });
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0].source).toBeTruthy();
    expect(memories[0].relatedEntity).toBeTruthy();
  });

  it("prefers internal knowledge over web research when it exists", async () => {
    const topic = `internal-topic-${Date.now()}`;
    await prisma.knowledge.create({ data: { topic, content: "We already know this." } });

    const agent = new ResearchAgent();
    const result = await agent.run({ topic });
    expect(result.status).toBe("SUCCESS");
    expect((result.data as any).matches).toBeDefined();
    expect(provider.calls).not.toContain(topic);
  });

  it("honestly reports WAITING (never fabricates evidence) when every source fails to fetch", async () => {
    provider.behavior = { kind: "results", results: [{ title: "Unreachable", url: `${handle.url}/unreachable`, snippet: "x", domain: "127.0.0.1" }] };
    const agent = new ResearchAgent();
    const topic = `all-sources-fail-${Date.now()}`;
    const result = await agent.run({ topic });
    expect(result.status).toBe("WAITING");
    expect(result.errors?.length).toBeGreaterThan(0);

    const memories = await prisma.memory.findMany({ where: { key: `research:${topic}` } });
    expect(memories).toHaveLength(0); // no fabricated memory when nothing was actually fetched
  });
});
