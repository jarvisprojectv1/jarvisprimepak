// core/research/provenance.ts - Source Provenance persistence + traceability
// (Phase 6, item 5). Thin helpers over the ResearchRun/ResearchSource/
// ResearchEvidence Prisma models so callers (the research agent, the web
// event source) never hand-roll the writes.
//
// Traceability contract (documented per the task spec): a Memory row written
// from research sets `relatedEntity` to the ResearchEvidence.id it came
// from. To answer "where did you get this information": read the Memory row
// -> ResearchEvidence.findUnique({ id: memory.relatedEntity }) ->
// .researchSource -> .researchRun. traceMemoryProvenance() below does
// exactly that in one call.
import { prisma } from "../../database/client";
import type { EvidenceClassification } from "./evidence";

export interface StartResearchRunInput {
  taskId?: string;
  query: string;
  createdBy: string; // Identity label
}

export async function startResearchRun(input: StartResearchRunInput) {
  return prisma.researchRun.create({
    data: { taskId: input.taskId, query: input.query, createdBy: input.createdBy, status: "RUNNING" },
  });
}

export async function completeResearchRun(
  id: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "NOT_IMPLEMENTED",
  summary?: string
) {
  return prisma.researchRun.update({
    where: { id },
    data: { status, summary, completedAt: new Date() },
  });
}

export interface RecordSourceInput {
  researchRunId: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  title?: string | null;
  publishedAt?: Date | null;
  contentHash?: string | null;
  sourceType: "search_result" | "fetched_page";
  discoveredByQuery?: string;
}

export async function recordResearchSource(input: RecordSourceInput) {
  return prisma.researchSource.create({
    data: {
      researchRunId: input.researchRunId,
      url: input.url,
      canonicalUrl: input.canonicalUrl,
      domain: input.domain,
      title: input.title ?? null,
      publishedAt: input.publishedAt ?? null,
      contentHash: input.contentHash ?? null,
      sourceType: input.sourceType,
      discoveredByQuery: input.discoveredByQuery,
    },
  });
}

export interface RecordEvidenceInput {
  researchSourceId: string;
  extractedText: string;
  classification: EvidenceClassification;
  relatedTaskId?: string;
}

export async function recordResearchEvidence(input: RecordEvidenceInput) {
  return prisma.researchEvidence.create({
    data: {
      researchSourceId: input.researchSourceId,
      extractedText: input.extractedText,
      classification: input.classification,
      relatedTaskId: input.relatedTaskId,
    },
  });
}

export interface ProvenanceTrace {
  evidence: { id: string; extractedText: string; classification: string };
  source: { id: string; url: string; canonicalUrl: string; domain: string; retrievedAt: Date };
  run: { id: string; query: string; createdBy: string; startedAt: Date };
}

/** Full chain lookup starting from a ResearchEvidence id (what Memory.relatedEntity stores for research-derived memories). */
export async function traceEvidenceProvenance(evidenceId: string): Promise<ProvenanceTrace | null> {
  const evidence = await prisma.researchEvidence.findUnique({
    where: { id: evidenceId },
    include: { researchSource: { include: { researchRun: true } } },
  });
  if (!evidence) return null;
  const source = evidence.researchSource;
  const run = source.researchRun;
  return {
    evidence: { id: evidence.id, extractedText: evidence.extractedText, classification: evidence.classification },
    source: { id: source.id, url: source.url, canonicalUrl: source.canonicalUrl, domain: source.domain, retrievedAt: source.retrievedAt },
    run: { id: run.id, query: run.query, createdBy: run.createdBy, startedAt: run.startedAt },
  };
}

/** Convenience: trace provenance directly from a Memory row's `relatedEntity` field (documented to hold a ResearchEvidence id for research-derived memories). */
export async function traceMemoryProvenance(memoryRelatedEntity: string | null): Promise<ProvenanceTrace | null> {
  if (!memoryRelatedEntity) return null;
  return traceEvidenceProvenance(memoryRelatedEntity);
}

export async function getResearchRun(id: string) {
  return prisma.researchRun.findUnique({
    where: { id },
    include: { sources: { include: { evidence: true } } },
  });
}

export async function listResearchRuns(limit = 50) {
  return prisma.researchRun.findMany({ orderBy: { startedAt: "desc" }, take: limit });
}
