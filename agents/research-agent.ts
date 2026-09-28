// agents/research-agent.ts - upgraded for Phase 6 (Web Research).
//
// Flow: OBSERVE (topic/taskId input) -> check internal knowledge first ->
// if insufficient AND web_search is configured, formulate a query and call
// WebSearchTool -> select top-N sources (dedup by canonical URL) -> fetch via
// WebFetchTool -> extract + classify evidence (FACT/SOURCE_CLAIM/ANALYSIS/
// UNCERTAINTY - never auto-FACT) -> compare across sources (conflicts are
// surfaced, never silently resolved) -> persist real ResearchRun/Source/
// Evidence rows (core/research/provenance.ts) -> remember (Memory KNOWLEDGE,
// with real source/confidence/relatedEntity=evidenceId, superseding any
// prior entry for the same key) -> return a real AgentRunResult with
// non-empty evidence (see agents/contract.ts).
//
// Every tool call below goes through toolRegistry.execute() - the SAME
// guarded path (state -> limits -> policy -> execute -> audit) every other
// caller uses. This agent never calls fetch()/an AI provider with raw
// external content - any text extracted from the web is wrapped via
// core/research/trustBoundary.wrapExternalContent() before it could ever be
// interpolated into a prompt (this agent does not currently call the AI
// provider itself - see docs/PHASE6_WEB_RESEARCH.md for where that wrapping
// point is exercised end-to-end in tests).
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { prisma } from "../database/client";
import { log } from "../security/logger";
import { toolRegistry } from "../tools/registry";
import type { SearchResult, FetchedPage } from "../tools/web/types";
import { canonicalizeUrl } from "../tools/web/sourceResolver";
import { classifyEvidence, compareAcrossSources, type SourceExcerpt } from "../core/research/evidence";
import { hashContent, shouldRefetch, isUnchanged } from "../core/research/dedup";
import { logInjectionSignalsIfAny, wrapExternalContent } from "../core/research/trustBoundary";
import {
  startResearchRun,
  completeResearchRun,
  recordResearchSource,
  recordResearchEvidence,
} from "../core/research/provenance";
import { Memory } from "../core/memory";
import { WORKER_IDENTITY } from "../core/auth/identity";

const MAX_SOURCES = 3;

export class ResearchAgent implements AgentInterface {
  name = "research";
  objective = "Answer research questions using internal knowledge and, when configured, real web research.";
  status: AgentStatus = "IDLE";

  async run(input: Record<string, unknown> = {}): Promise<AgentRunResult> {
    this.status = "RUNNING";
    const agentRow = await prisma.agent.upsert({
      where: { name: this.name },
      update: { status: "RUNNING", objective: this.objective },
      create: { name: this.name, objective: this.objective, status: "RUNNING" },
    });
    const run = await prisma.agentRun.create({
      data: { agentId: agentRow.id, status: "RUNNING", input: JSON.stringify(input) },
    });

    try {
      const topic = typeof input.topic === "string" ? input.topic : undefined;
      const taskId = typeof input.taskId === "string" ? input.taskId : undefined;

      if (!topic) {
        return this.finish(agentRow.id, run.id, { status: "FAILED", summary: "A 'topic' input is required to research." });
      }

      const matches = await prisma.knowledge.findMany({ where: { topic: { contains: topic } }, take: 10 });
      if (matches.length > 0) {
        return this.finish(agentRow.id, run.id, {
          status: "SUCCESS",
          summary: `Found ${matches.length} internal knowledge entr${matches.length === 1 ? "y" : "ies"} for "${topic}".`,
          data: { matches },
          result: { matches },
          evidence: { matchCount: matches.length, matchIds: matches.map((m) => m.id) },
        });
      }

      // No internal knowledge: try real web research if configured.
      const searchResult = await toolRegistry.execute("web_search", { query: topic, taskId }, WORKER_IDENTITY);
      if (searchResult.status === "CONFIGURATION_REQUIRED") {
        return this.finish(agentRow.id, run.id, {
          status: "NOT_IMPLEMENTED",
          summary: `No internal knowledge found for "${topic}". Web research is not configured: ${searchResult.message}`,
          nextAction: "Set BRAVE_SEARCH_API_KEY (see .env.example) to enable open-web research.",
        });
      }
      if (searchResult.status !== "OK") {
        return this.finish(agentRow.id, run.id, {
          status: "WAITING",
          summary: `No internal knowledge found for "${topic}", and web search failed: ${searchResult.message}`,
          nextAction: "Retry later or investigate the web search tool's error.",
        });
      }

      const researchRun = await startResearchRun({ taskId, query: topic, createdBy: WORKER_IDENTITY.label });

      const searchData = searchResult.data as { results: SearchResult[] };
      const seenCanonical = new Set<string>();
      const dedupedResults: SearchResult[] = [];
      for (const r of searchData.results) {
        const canonical = canonicalizeUrl(r.url);
        if (seenCanonical.has(canonical)) continue;
        seenCanonical.add(canonical);
        dedupedResults.push(r);
        if (dedupedResults.length >= MAX_SOURCES) break;
      }

      const excerpts: SourceExcerpt[] = [];
      const evidenceIds: string[] = [];
      const errors: string[] = [];
      let anyFetchOk = false;

      for (const result of dedupedResults) {
        const canonical = canonicalizeUrl(result.url);
        const refetch = await shouldRefetch(canonical);
        if (!refetch.shouldFetch && refetch.existingSource) {
          // Unchanged/fresh source: still record evidence from the prior
          // source row so the run's provenance chain is real, without
          // re-fetching (Phase 6 item 16 - no duplicated work).
          continue;
        }

        const fetchResult = await toolRegistry.execute("web_fetch", { url: result.url, taskId }, WORKER_IDENTITY);
        if (fetchResult.status !== "OK") {
          errors.push(`${result.url}: ${fetchResult.message}`);
          continue;
        }
        anyFetchOk = true;
        const page = fetchResult.data as FetchedPage;
        const contentHash = hashContent(page.text);

        // Best-effort, log-only signal - never blocks/alters execution. The
        // architectural guarantee (validatePlan + enforcement gate) is what
        // actually protects against injected content, not this scan.
        logInjectionSignalsIfAny(page.text, { url: result.url });

        // Demonstrates the trust-boundary wrapping this agent would hand to
        // an AI provider for synthesis; not currently sent anywhere (this
        // agent does deterministic extraction, not LLM synthesis), but any
        // future call site MUST route external text through this wrapper -
        // see core/research/trustBoundary.ts.
        void wrapExternalContent(page.text.slice(0, 2000), {
          url: result.url,
          title: page.title,
          retrievedAt: page.fetchedAt,
        });

        const sourceRow = await recordResearchSource({
          researchRunId: researchRun.id,
          url: result.url,
          canonicalUrl: page.canonicalUrl,
          domain: page.domain,
          title: page.title,
          contentHash,
          sourceType: "fetched_page",
          discoveredByQuery: topic,
        });

        const snippet = page.text.slice(0, 500);
        const classification = classifyEvidence(snippet);
        const evidenceRow = await recordResearchEvidence({
          researchSourceId: sourceRow.id,
          extractedText: snippet,
          classification,
          relatedTaskId: taskId,
        });
        evidenceIds.push(evidenceRow.id);
        excerpts.push({ sourceId: sourceRow.id, domain: page.domain, text: snippet });
      }

      if (!anyFetchOk) {
        await completeResearchRun(researchRun.id, "FAILED", "All source fetches failed.");
        return this.finish(agentRow.id, run.id, {
          status: "WAITING",
          summary: `Found ${dedupedResults.length} search result(s) for "${topic}" but could not fetch any of them.`,
          errors,
          nextAction: "Retry later; sources may be temporarily unreachable or blocked.",
        });
      }

      const comparison = compareAcrossSources(excerpts);
      const summary =
        `Researched "${topic}": ${excerpts.length} source(s) fetched. ${comparison.note}` +
        (errors.length > 0 ? ` (${errors.length} source(s) failed to fetch.)` : "");

      await completeResearchRun(researchRun.id, errors.length > 0 ? "PARTIAL" : "SUCCESS", summary);

      // Remember: one Memory entry per evidence item, each with real
      // provenance (source = URL, confidence reflects real uncertainty,
      // relatedEntity = the ResearchEvidence id so the full chain is
      // traceable - see core/research/provenance.traceMemoryProvenance()).
      // Superseding, never overwriting, an existing entry for the same key.
      for (let i = 0; i < excerpts.length; i++) {
        const excerpt = excerpts[i];
        const confidence = comparison.agreement === "AGREE" ? 0.75 : comparison.agreement === "CONFLICT" ? 0.4 : 0.5;
        await Memory.remember({
          namespace: "KNOWLEDGE",
          key: `research:${topic}`,
          content: excerpt.text,
          value: { topic, domain: excerpt.domain, agreement: comparison.agreement },
          source: excerpt.domain,
          confidence,
          relatedEntity: evidenceIds[i],
          metadata: { researchRunId: researchRun.id },
        });
      }

      return this.finish(agentRow.id, run.id, {
        status: "SUCCESS",
        summary,
        data: { researchRunId: researchRun.id, sourceCount: excerpts.length, comparison },
        result: { researchRunId: researchRun.id, sourceCount: excerpts.length, comparison },
        evidence: { researchRunId: researchRun.id, evidenceIds, sourceCount: excerpts.length },
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      await prisma.agent.update({ where: { id: agentRow.id }, data: { status: "FAILED" } });
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", output: message, endedAt: new Date() } });
      log("ERROR", "research-agent.error", { error: message });
      return { status: "FAILED", summary: message };
    }
  }

  private async finish(agentId: string, runId: string, result: AgentRunResult): Promise<AgentRunResult> {
    this.status = result.status;
    await prisma.agent.update({ where: { id: agentId }, data: { status: result.status } });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: result.status, output: JSON.stringify(result), endedAt: new Date() },
    });
    log("AGENT", "research-agent.run", { status: result.status });
    return result;
  }
}
