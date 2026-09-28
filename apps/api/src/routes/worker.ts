// apps/api/src/routes/worker.ts - Autonomous Worker observability (Phase 5,
// requirement #12). Read-only: current task, queue size, processed/failed
// counts, last heartbeat, the latest Daily Executive Report, and recent
// autonomous (worker-attributed) actions from the audit log - never raw
// secrets, never the Brain's internal reasoning.
import { Router } from "express";
import { prisma } from "../../../../database/client";
import { getHeartbeat } from "../../../../core/worker/heartbeat";
import { getLatestDailyReport } from "../../../../core/reports/dailyReport";
import { identityToActorString, WORKER_IDENTITY } from "../../../../core/auth/identity";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const workerRouter = Router();

workerRouter.get("/status", requireAuth, requireAuthz("worker.read"), async (_req, res) => {
  const heartbeat = await getHeartbeat("worker-1");
  const queueSize = await prisma.task.count({
    where: { status: { in: ["PENDING", "QUEUED", "RETRYING"] }, parentId: null, stepId: null },
  });
  res.json({
    heartbeat,
    queueSize,
  });
});

workerRouter.get("/report/latest", requireAuth, requireAuthz("report.read"), async (_req, res) => {
  const report = await getLatestDailyReport();
  res.json({ report });
});

workerRouter.get("/actions", requireAuth, requireAuthz("worker.read"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const actor = identityToActorString(WORKER_IDENTITY);
  const rows = await prisma.auditLog.findMany({
    where: { actor },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  // meta is already redacted at write time (security/audit.ts); parse for a
  // clean JSON response instead of a double-encoded string.
  const actions = rows.map((r) => ({
    id: r.id,
    action: r.action,
    target: r.target,
    createdAt: r.createdAt,
    meta: r.meta ? safeParse(r.meta) : null,
  }));
  res.json({ actions });
});

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
