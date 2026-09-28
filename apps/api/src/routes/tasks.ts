import { Router } from "express";
import { planTask, listTasks, updateTaskStatus, getTask } from "../../../../core/planner";
import { publish } from "../../../../core/events";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const tasksRouter = Router();

tasksRouter.get("/", requireAuth, requireAuthz("task.read"), async (_req, res) => {
  res.json(await listTasks());
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
