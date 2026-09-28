import { describe, it, expect } from "vitest";
import {
  startResearchRun,
  completeResearchRun,
  recordResearchSource,
  recordResearchEvidence,
  traceEvidenceProvenance,
  traceMemoryProvenance,
  getResearchRun,
} from "./provenance";
import { Memory } from "../memory";

describe("core/research/provenance - Source Provenance (item 5)", () => {
  it("K: a research run + source + evidence chain is persisted and queryable end-to-end", async () => {
    const run = await startResearchRun({ query: "provenance-test", createdBy: "test:provenance" });
    const source = await recordResearchSource({
      researchRunId: run.id,
      url: "https://news.example.com/article-1",
      canonicalUrl: "https://news.example.com/article-1",
      domain: "news.example.com",
      title: "Article One",
      sourceType: "fetched_page",
      discoveredByQuery: "provenance-test",
    });
    const evidence = await recordResearchEvidence({
      researchSourceId: source.id,
      extractedText: "The market grew 4% according to the report.",
      classification: "SOURCE_CLAIM",
    });
    await completeResearchRun(run.id, "SUCCESS", "done");

    const fetchedRun = await getResearchRun(run.id);
    expect(fetchedRun?.status).toBe("SUCCESS");
    expect(fetchedRun?.sources).toHaveLength(1);
    expect(fetchedRun?.sources[0].evidence).toHaveLength(1);
    expect(fetchedRun?.sources[0].evidence[0].id).toBe(evidence.id);
  });

  it("K: traceEvidenceProvenance walks evidence -> source -> run", async () => {
    const run = await startResearchRun({ query: "trace-test", createdBy: "test:provenance" });
    const source = await recordResearchSource({
      researchRunId: run.id,
      url: "https://news.example.com/article-2",
      canonicalUrl: "https://news.example.com/article-2",
      domain: "news.example.com",
      sourceType: "fetched_page",
    });
    const evidence = await recordResearchEvidence({
      researchSourceId: source.id,
      extractedText: "some claim",
      classification: "FACT",
    });

    const trace = await traceEvidenceProvenance(evidence.id);
    expect(trace?.evidence.id).toBe(evidence.id);
    expect(trace?.source.id).toBe(source.id);
    expect(trace?.run.id).toBe(run.id);
    expect(trace?.run.query).toBe("trace-test");
  });

  it("L: a Memory entry written from research carries real provenance and traces back via relatedEntity", async () => {
    const run = await startResearchRun({ query: "memory-provenance-test", createdBy: "agent:research" });
    const source = await recordResearchSource({
      researchRunId: run.id,
      url: "https://news.example.com/article-3",
      canonicalUrl: "https://news.example.com/article-3",
      domain: "news.example.com",
      sourceType: "fetched_page",
    });
    const evidence = await recordResearchEvidence({
      researchSourceId: source.id,
      extractedText: "Packaging demand is rising.",
      classification: "SOURCE_CLAIM",
    });

    const memory = await Memory.remember({
      namespace: "KNOWLEDGE",
      key: `research:memory-provenance-test-${Date.now()}`,
      content: "Packaging demand is rising.",
      source: "news.example.com",
      confidence: 0.6,
      relatedEntity: evidence.id,
    });

    expect(memory.confidence).toBe(0.6);
    expect(memory.source).toBe("news.example.com");

    const trace = await traceMemoryProvenance(memory.relatedEntity);
    expect(trace?.evidence.id).toBe(evidence.id);
    expect(trace?.source.url).toBe("https://news.example.com/article-3");
    expect(trace?.run.id).toBe(run.id);
  });

  it("returns null when a memory has no research provenance recorded", async () => {
    const trace = await traceMemoryProvenance(null);
    expect(trace).toBeNull();
  });
});
