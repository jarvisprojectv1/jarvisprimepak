// agents/market-agent.ts - Market/Forex Intelligence (Phase 6, item 9).
//
// RESEARCH AND MONITORING ONLY. This agent NEVER places an order, moves
// funds, stores a broker credential, or talks to any trading/broker API -
// there is no such tool anywhere in this codebase (see
// agents/no-trading.test.ts for a grep-based architectural proof). It is
// built the exact same way as ResearchAgent: search + fetch through the
// guarded tool registry, extract text, remember with real provenance. The
// only difference from ResearchAgent is its fixed set of macro/forex query
// topics - it is not a generic research agent with a different name, but it
// shares 100% of the same safe plumbing (no separate, less-audited path).
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { prisma } from "../database/client";
import { log } from "../security/logger";
import { toolRegistry } from "../tools/registry";
import type { SearchResult, FetchedPage } from "../tools/web/types";
import { canonicalizeUrl } from "../tools/web/sourceResolver";
import { classifyEvidence } from "../core/research/evidence";
import { hashContent } from "../core/research/dedup";
import { startResearchRun, completeResearchRun, recordResearchSource, recordResearchEvidence } from "../core/research/provenance";
import { Memory } from "../core/memory";
import { WORKER_IDENTITY } from "../core/auth/identity";

const DEFAULT_TOPICS = ["forex market news", "central bank interest rate announcement", "gold price news", "bitcoin price news"];
const MAX_SOURCES = 2;

export class MarketAgent implements AgentInterface {
  name = "market";
  objective = "Research and monitor forex/macro/gold/BTC news for informational awareness only - never trades, never moves funds.";
  status: AgentStatus = "IDLE";

  async run(input: Record<string, unknown> = {}): Promise<AgentRunResult> {
    this.status = "RUNNING";
    const agentRow = await prisma.agent.upsert({
      where: { name: this.name },
      update: { status: "RUNNING", objective: this.objective },
      create: { name: this.name, objective: this.objective, status: "RUNNING" },
    });
    const run = await prisma.agentRun.create({ data: { agentId: agentRow.id, status: "RUNNING", input: JSON.stringify(input) } });

    try {
      const topic = typeof input.topic === "string" ? input.topic : DEFAULT_TOPICS[0];
      const taskId = typeof input.taskId === "string" ? input.taskId : undefined;

      const searchResult = await toolRegistry.execute("web_search", { query: topic, taskId }, WORKER_IDENTITY);
      if (searchResult.status === "CONFIGURATION_REQUIRED") {
        return this.finish(agentRow.id, run.id, {
          status: "NOT_IMPLEMENTED",
          summary: `Market intelligence for "${topic}" is not available: ${searchResult.message}`,
          nextAction: "Set BRAVE_SEARCH_API_KEY to enable market/forex news research.",
        });
      }
      if (searchResult.status !== "OK") {
        return this.finish(agentRow.id, run.id, { status: "FAILED", summary: `Market search failed: ${searchResult.message}` });
      }

      const researchRun = await startResearchRun({ taskId, query: topic, createdBy: WORKER_IDENTITY.label });
      const { results } = searchResult.data as { results: SearchResult[] };
      const seen = new Set<string>();
      const evidenceIds: string[] = [];
      let fetched = 0;

      for (const r of results) {
        const canonical = canonicalizeUrl(r.url);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        if (fetched >= MAX_SOURCES) break;

        const fetchResult = await toolRegistry.execute("web_fetch", { url: r.url, taskId }, WORKER_IDENTITY);
        if (fetchResult.status !== "OK") continue;
        fetched += 1;
        const page = fetchResult.data as FetchedPage;
        const snippet = page.text.slice(0, 500);
        const sourceRow = await recordResearchSource({
          researchRunId: researchRun.id,
          url: r.url,
          canonicalUrl: page.canonicalUrl,
          domain: page.domain,
          title: page.title,
          contentHash: hashContent(page.text),
          sourceType: "fetched_page",
          discoveredByQuery: topic,
        });
        const evidenceRow = await recordResearchEvidence({
          researchSourceId: sourceRow.id,
          extractedText: snippet,
          classification: classifyEvidence(snippet),
          relatedTaskId: taskId,
        });
        evidenceIds.push(evidenceRow.id);

        await Memory.remember({
          namespace: "KNOWLEDGE",
          key: `market:${topic}`,
          content: snippet,
          value: { topic, domain: page.domain },
          source: page.domain,
          confidence: 0.5,
          relatedEntity: evidenceRow.id,
          metadata: { researchRunId: researchRun.id, note: "informational monitoring only - no trading action taken or possible" },
        });
      }

      await completeResearchRun(researchRun.id, fetched > 0 ? "SUCCESS" : "FAILED", `Fetched ${fetched} market/forex source(s) for "${topic}".`);

      if (fetched === 0) {
        return this.finish(agentRow.id, run.id, { status: "WAITING", summary: `No market sources could be fetched for "${topic}".` });
      }

      return this.finish(agentRow.id, run.id, {
        status: "SUCCESS",
        summary: `Monitored "${topic}": ${fetched} source(s) recorded for informational awareness (no trading action taken).`,
        data: { researchRunId: researchRun.id, sourceCount: fetched },
        result: { researchRunId: researchRun.id, sourceCount: fetched },
        evidence: { researchRunId: researchRun.id, evidenceIds },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: "FAILED" } });
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", output: message, endedAt: new Date() } });
      log("ERROR", "market-agent.error", { error: message });
      return { status: "FAILED", summary: message };
    }
  }

  private async finish(agentId: string, runId: string, result: AgentRunResult): Promise<AgentRunResult> {
    this.status = result.status;
    await prisma.agent.update({ where: { id: agentId }, data: { status: result.status } });
    await prisma.agentRun.update({ where: { id: runId }, data: { status: result.status, output: JSON.stringify(result), endedAt: new Date() } });
    return result;
  }
}
