import { Router } from "express";
import { planTask, listTasks, updateTaskStatus, getTask, deriveRootOutcome } from "../../../../core/planner";
import { publish } from "../../../../core/events";
import { prisma } from "../../../../database/client";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const tasksRouter = Router();

tasksRouter.get("/", requireAuth, requireAuthz("task.read"), async (_req, res) => {
  res.json(await listTasks());
});

/**
 * Hardening pass: reconstructs one connected task tree - the root task, its
 * real children (each tagged with its own agent/tool/status/result, now
 * genuinely linked via `parentId` rather than living in a separate, orphan
 * Brain task tree), a derived aggregate root outcome (see
 * `core/planner.deriveRootOutcome`), and the AuditLog entries recorded
 * against the root or any of its children (queryable because every
 * task-related `writeAuditLog` call in this flow sets `target` to the
 * relevant task id - see core/brain/runPlan.ts and core/worker/index.ts).
 * Uses the existing `task.read` authz action - no new AuthzAction was needed.
 * Never returns raw audit `meta` beyond what was already redacted at write
 * time (security/redact.ts), and never includes anything secret-shaped.
 */
tasksRouter.get("/:id/tree", requireAuth, requireAuthz("task.read"), async (req, res) => {
  const root = await getTask(req.params.id);
  if (!root) {
    res.status(404).json({ error: "No such task." });
    return;
  }

  const children = await listTasks(root.id);
  const rootOutcome = deriveRootOutcome(children.map((c) => c.status));

  const taskIds = [root.id, ...children.map((c) => c.id)];
  const auditEntries = await prisma.auditLog.findMany({
    where: { target: { in: taskIds } },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    root: {
      id: root.id,
      title: root.title,
      status: root.status,
      priority: root.priority,
      stepId: root.stepId,
      agentName: root.agentName,
      toolName: root.toolName,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    },
    rootOutcome,
    children: children.map((c) => ({
      id: c.id,
      title: c.title,
      stepId: c.stepId,
      agentName: c.agentName,
      toolName: c.toolName,
      status: c.status,
      waitingReason: c.waitingReason,
      blockedReason: c.blockedReason,
      failureReason: c.failureReason,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    auditTrail: auditEntries.map((a) => ({
      id: a.id,
      actor: a.actor,
      action: a.action,
      target: a.target,
      createdAt: a.createdAt,
      meta: a.meta ? JSON.parse(a.meta) : null,
    })),
  });
});

tasksRouter.post("/", requireAuth, requireAuthz("task.write"), async (req, res) => {
  const { title, description, priority, subtasks } = req.body ?? {};
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "Body must include a 'title' string." });
    return;
  }
  const tasks = await planTask({ title, description, priority, subtasks });
  res.status(201).json(tasks);
});

tasksRouter.patch("/:id/status", requireAuth, requireAuthz("task.write"), async (req, res) => {
  const { status } = req.body ?? {};
  if (!status) {
    res.status(400).json({ error: "Body must include a 'status' string." });
    return;
  }
  const task = await updateTaskStatus(req.params.id, status);
  res.json(task);
});

/**
 * Phase 5 (#9 Owner Interruptions): the owner supplying missing information
 * for a WAITING task. Publishes a real USER.task_resumed event (audit trail
 * + a real event source, per requirement #13) and moves the task back to
 * PENDING so the worker picks it up on a subsequent tick - it does NOT
 * execute anything itself.
 */
tasksRouter.post("/:id/resume", requireAuth, requireAuthz("task.write"), async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "No such task." });
    return;
  }
  if (task.status !== "WAITING" && task.status !== "BLOCKED") {
    res.status(400).json({ error: `Task is "${task.status}", not WAITING/BLOCKED - nothing to resume.` });
    return;
  }
  const info = req.body?.info;
  await publish({
    type: "USER.task_resumed",
    payload: { taskId: task.id, info: info ?? null },
    source: "api:tasks.resume",
  });
  const updated = await updateTaskStatus(task.id, "PENDING");
  res.json(updated);
});
