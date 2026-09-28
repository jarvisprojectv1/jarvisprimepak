// apps/api/src/routes/brain.ts - read-only observability for the Brain
// (Phase 4). Never exposes raw internal reasoning/chain-of-thought - only
// concise summaries (goal, status, step count, result summary).
import { Router } from "express";
import { listTasks } from "../../../../core/planner";
import { summarizeUsageSince, startOfDayUtc, startOfMonthUtc } from "../../../../core/ai/usage";
import { getCostControlConfig } from "../../../../core/ai/costControl";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const brainRouter = Router();

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

brainRouter.get("/tasks", requireAuth, requireAuthz("brain.read"), async (_req, res) => {
  const all = await listTasks();
  const parents = all.filter((t) => !t.parentId);

  const summaries = await Promise.all(
    parents.map(async (parent) => {
      const subtasks = all.filter((t) => t.parentId === parent.id);
      return {
        id: parent.id,
        goal: parent.title,
        status: parent.status,
        stepCount: subtasks.length,
        stepsSummary: subtasks.map((s) => ({ stepId: s.stepId, title: s.title, status: s.status })),
        createdAt: parent.createdAt,
      };
    })
  );

  res.json({
    active: summaries.filter((s) => !TERMINAL.has(s.status)),
    completed: summaries.filter((s) => TERMINAL.has(s.status)),
  });
});

brainRouter.get("/usage", requireAuth, requireAuthz("brain.read"), async (_req, res) => {
  const [today, month, config] = await Promise.all([
    summarizeUsageSince(startOfDayUtc()),
    summarizeUsageSince(startOfMonthUtc()),
    getCostControlConfig(),
  ]);
  res.json({ today, month, limits: config });
});
