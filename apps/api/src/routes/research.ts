// apps/api/src/routes/research.ts - Observability for Phase 6 research
// (item 17): research runs (with sources+evidence), the Business
// Intelligence topic list, and a rate-limit/error summary. Follows the same
// requireAuth + requireAuthz pattern as every other route. No secrets in any
// response (URLs/domains/text only - never raw credentials/env values).
import { Router } from "express";
import { prisma } from "../../../../database/client";
import { listResearchRuns, getResearchRun, traceMemoryProvenance } from "../../../../core/research/provenance";
import { getResearchLimitsConfig, setResearchLimitsConfig } from "../../../../core/research/limits";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const researchRouter = Router();

researchRouter.get("/runs", requireAuth, requireAuthz("research.read"), async (_req, res) => {
  const runs = await listResearchRuns(50);
  res.json({ runs });
});

researchRouter.get("/runs/:id", requireAuth, requireAuthz("research.read"), async (req, res) => {
  const run = await getResearchRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Research run not found." });
    return;
  }
  res.json({ run });
});

// "Where did you get this information" - traces a Memory row's
// relatedEntity (a ResearchEvidence id) back through source -> run.
researchRouter.get("/provenance/:memoryId", requireAuth, requireAuthz("research.read"), async (req, res) => {
  const memory = await prisma.memory.findUnique({ where: { id: req.params.memoryId } });
  if (!memory) {
    res.status(404).json({ error: "Memory not found." });
    return;
  }
  const trace = await traceMemoryProvenance(memory.relatedEntity);
  if (!trace) {
    res.json({ memory: { id: memory.id, content: memory.content }, trace: null, note: "No research provenance recorded for this memory." });
    return;
  }
  res.json({ memory: { id: memory.id, content: memory.content }, trace });
});

researchRouter.get("/topics", requireAuth, requireAuthz("research.read"), async (_req, res) => {
  const topics = await prisma.researchTopic.findMany({ orderBy: { name: "asc" } });
  res.json({ topics });
});

researchRouter.post("/topics", requireAuth, requireAuthz("research.write"), async (req, res) => {
  const { name, query, enabled, pollIntervalMinutes } = req.body ?? {};
  if (typeof name !== "string" || typeof query !== "string") {
    res.status(400).json({ error: "name and query are required strings." });
    return;
  }
  const topic = await prisma.researchTopic.upsert({
    where: { name },
    update: { query, enabled: enabled ?? undefined, pollIntervalMinutes: pollIntervalMinutes ?? undefined },
    create: { name, query, enabled: enabled ?? true, pollIntervalMinutes: pollIntervalMinutes ?? 1440 },
  });
  res.json({ topic });
});

researchRouter.patch("/topics/:id", requireAuth, requireAuthz("research.write"), async (req, res) => {
  const { enabled, pollIntervalMinutes, query } = req.body ?? {};
  try {
    const topic = await prisma.researchTopic.update({
      where: { id: req.params.id },
      data: { enabled, pollIntervalMinutes, query },
    });
    res.json({ topic });
  } catch {
    res.status(404).json({ error: "Topic not found." });
  }
});

researchRouter.get("/limits", requireAuth, requireAuthz("research.read"), async (_req, res) => {
  const limits = await getResearchLimitsConfig();
  res.json({ limits });
});

researchRouter.patch("/limits", requireAuth, requireAuthz("research.write"), async (req, res) => {
  const updated = await setResearchLimitsConfig(req.body ?? {});
  res.json({ limits: updated });
});

// Error summary: counts of research runs by status, and recent web tool
// call outcomes (only ACTION/AGENT/TOOL/SECURITY/CRITICAL categories are
// persisted to system_logs - see security/logger.ts - so this reads the
// TOOL-category entries tools/registry.ts already writes for every
// web_search/web_fetch call). No secrets - the logger already redacts
// before persisting.
researchRouter.get("/errors", requireAuth, requireAuthz("research.read"), async (_req, res) => {
  const [statusCounts, recentLogs] = await Promise.all([
    prisma.researchRun.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.systemLog.findMany({
      where: { category: "TOOL", OR: [{ message: { contains: "web_search" } }, { message: { contains: "web_fetch" } }] },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  res.json({
    runStatusCounts: statusCounts.map((s) => ({ status: s.status, count: s._count.status })),
    recentWebToolCalls: recentLogs.map((l) => ({ message: l.message, createdAt: l.createdAt, meta: l.meta ? JSON.parse(l.meta) : null })),
  });
});
