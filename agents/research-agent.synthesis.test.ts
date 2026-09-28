// agents/research-agent.synthesis.test.ts - Phase 6.1 end-to-end tests: the
// ResearchAgent wired to a FakeProvider (constructor DI, same pattern as
// core/brain/brain.test.ts). Covers A (end-to-end search->fetch->synthesis),
// N (memory provenance correct post-grounding), O (traceable end to end),
// P/Q (pause/emergency-stop mid-flow, before synthesis runs), R (audit log
// entries for the synthesis call), and S (retry doesn't duplicate a
// research run's already-fetched sources).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ResearchAgent } from "./research-agent";
import { toolRegistry } from "../tools/registry";
import { createWebSearchTool } from "../tools/web/searchTool";
import { webFetchTool } from "../tools/web/fetchTool";
import { MockSearchProvider } from "../tools/web/mockSearchProvider";
import { startTestServer, type TestServerHandle } from "../tools/web/testServer";
import { __resetResearchLimitsForTests } from "../core/research/limits";
import { prisma } from "../database/client";
import { setSystemState } from "../core/state";
import { traceMemoryProvenance } from "../core/research/provenance";
import type { AIProvider, AICompletionOutcome, AIMessage, CompleteOptions } from "../core/ai/provider";

class FakeProvider implements AIProvider {
  name = "fake";
  calls: { messages: AIMessage[]; options?: CompleteOptions }[] = [];
  constructor(private responses: AICompletionOutcome[]) {}
  async complete(messages: AIMessage[], options?: CompleteOptions): Promise<AICompletionOutcome> {
    this.calls.push({ messages, options });
    const next = this.responses.shift();
    if (!next) throw new Error("FakeProvider ran out of scripted responses");
    return next;
  }
}

function synthesisTextResponse(evidenceId: string, sourceId: string): AICompletionOutcome {
  return {
    ok: true,
    content: JSON.stringify({
      summary: "One source discusses the topic.",
      findings: [
        {
          id: "f1",
          statement: "Apparel packaging exports grew, per one source.",
          classification: "SOURCE_CLAIM",
          evidenceIds: [evidenceId],
          sourceIds: [sourceId],
        },
      ],
      uncertainties: [],
      contradictions: [],
      confidence: 0.55,
      followUpQuestions: ["Is this corroborated by a second source?"],
    }),
    toolUses: [],
    model: "fake-model",
    usage: { inputTokens: 20, outputTokens: 20, estimatedCostUsd: 0.002 },
  };
}

let handle: TestServerHandle;
const sharedSearchProvider = new MockSearchProvider({ kind: "results", results: [] });

beforeAll(async () => {
  handle = await startTestServer({
    "/synth-source": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Synth Source</title></head><body><p>Apparel packaging exports grew, according to industry data.</p></body></html>");
    },
    "/synth-source-retry": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Retry Source</title></head><body><p>Retry-test source content, according to a report.</p></body></html>");
    },
    "/pausing-source": async (_req, res) => {
      // Side effect during a real, in-flight fetch: pauses the system, same
      // technique core/brain/brain.test.ts uses for a tool's side effect,
      // applied here to prove the research agent's synthesis step also
      // honors a mid-execution pause (P/Q).
      await setSystemState("PAUSED", "paused mid-research by test source", "test");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Pausing Source</title></head><body><p>Some content, according to a report.</p></body></html>");
    },
  });
  toolRegistry.register(webFetchTool);
  toolRegistry.register(createWebSearchTool(sharedSearchProvider));
});

afterAll(async () => {
  await handle.close();
});

afterEach(async () => {
  await setSystemState("RUNNING", "test cleanup", "test");
});

describe("agents/research-agent - Phase 6.1 LLM synthesis wiring", () => {
  it("A/N/O: end-to-end search -> fetch -> synthesis produces a grounded finding, a provenance-correct Memory entry, and a traceable chain", async () => {
    __resetResearchLimitsForTests();
    const topic = `synth-topic-${Date.now()}`;
    sharedSearchProvider.behavior = {
      kind: "results",
      results: [{ title: "Synth Source", url: `${handle.url}/synth-source`, snippet: "growth", domain: "127.0.0.1" }],
    };

    // We don't know the real evidenceId/sourceId until after the run
    // fetches them, so script the FakeProvider to read them back off
    // whatever ResearchEvidence row gets created for this topic - simplest
    // is a provider whose complete() inspects the prompt for the "valid
    // evidence/source ids" line we know synthesis.ts emits.
    const fakeProvider: AIProvider = {
      name: "fake",
      async complete(messages) {
        const idsLine = messages.find((m) => m.content.startsWith("Valid evidence/source ids"))!.content;
        const match = /evidence_id=(\S+) source_id=(\S+)/.exec(idsLine)!;
        return synthesisTextResponse(match[1], match[2]);
      },
    };

    const agent = new ResearchAgent(fakeProvider);
    const result = await agent.run({ topic });

    expect(result.status).toBe("SUCCESS");
    const data = result.data as { synthesis?: { findings: Array<{ statement: string }> } };
    expect(data.synthesis).toBeDefined();
    expect(data.synthesis!.findings).toHaveLength(1);

    const memories = await prisma.memory.findMany({ where: { key: `research-synthesis:${topic}` } });
    expect(memories).toHaveLength(1);
    expect(memories[0].confidence).toBeCloseTo(0.55);
    expect(memories[0].relatedEntity).toBeTruthy();

    // O: full provenance chain is traceable from the Memory row's
    // relatedEntity (a ResearchEvidence id) all the way to the ResearchRun.
    const trace = await traceMemoryProvenance(memories[0].relatedEntity);
    expect(trace).not.toBeNull();
    expect(trace!.source.url).toBe(`${handle.url}/synth-source`);
    expect(trace!.run.query).toBe(topic);

    // R: the synthesis call itself is audit-logged (category AGENT is a
    // persisted category - see security/logger.ts's PERSISTED_CATEGORIES).
    // log() persists fire-and-forget, so give it a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const auditRows = await prisma.systemLog.findMany({
      where: { message: "research-agent.synthesis_success" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it("P/Q: a pause that happens mid-run (after fetch, before synthesis) halts the synthesis call and returns an honest WAITING - never a fabricated result", async () => {
    __resetResearchLimitsForTests();
    const topic = `synth-pause-topic-${Date.now()}`;
    sharedSearchProvider.behavior = {
      kind: "results",
      results: [{ title: "Pausing Source", url: `${handle.url}/pausing-source`, snippet: "x", domain: "127.0.0.1" }],
    };

    const fakeProvider = new FakeProvider([synthesisTextResponse("should-not-be-used", "should-not-be-used")]);
    const agent = new ResearchAgent(fakeProvider);
    const result = await agent.run({ topic });

    expect(result.status).toBe("WAITING");
    expect(result.summary).toMatch(/PAUSED/);
    // The LLM was never actually called - the mid-execution state check
    // short-circuited before synthesizeResearch() could call it.
    expect(fakeProvider.calls).toHaveLength(0);
  });

  it("S: retrying research for the same topic within the refresh window does not re-fetch/duplicate the already-recorded source", async () => {
    __resetResearchLimitsForTests();
    const topic = `synth-retry-topic-${Date.now()}`;
    const retryUrl = `${handle.url}/synth-source-retry`;
    sharedSearchProvider.behavior = {
      kind: "results",
      results: [{ title: "Retry Source", url: retryUrl, snippet: "growth", domain: "127.0.0.1" }],
    };

    // First run creates and fetches the source for real.
    const agent1 = new ResearchAgent({
      name: "fake",
      async complete(messages) {
        const idsLine = messages.find((m) => m.content.startsWith("Valid evidence/source ids"))!.content;
        const match = /evidence_id=(\S+) source_id=(\S+)/.exec(idsLine)!;
        return synthesisTextResponse(match[1], match[2]);
      },
    });
    const firstResult = await agent1.run({ topic });
    expect(firstResult.status).toBe("SUCCESS");

    const sourcesAfterFirst = await prisma.researchSource.findMany({ where: { url: retryUrl } });
    expect(sourcesAfterFirst).toHaveLength(1);

    // Second "retry" run for the exact same topic, within the refresh
    // window - shouldRefetch() should say "don't refetch" for this
    // already-known, fresh canonical URL, so no new ResearchSource row (and
    // therefore no new synthesis Memory write from a duplicated fetch)
    // should be created for it.
    __resetResearchLimitsForTests();
    const fakeProvider2 = new FakeProvider([synthesisTextResponse("e", "s")]);
    const agent2 = new ResearchAgent(fakeProvider2);
    await agent2.run({ topic });

    const sourcesAfterRetry = await prisma.researchSource.findMany({ where: { url: retryUrl } });
    expect(sourcesAfterRetry.length).toBe(sourcesAfterFirst.length);
    // The fake provider for the retry attempt was never even called, since
    // the deduped fetch loop never fetched a NEW page for synthesis to run
    // on top of (no fresh evidence this run) - proving no duplicate work.
    expect(fakeProvider2.calls).toHaveLength(0);
  });
});
