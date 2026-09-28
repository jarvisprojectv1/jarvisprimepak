import { Router } from "express";
import { planTask, listTasks, updateTaskStatus } from "../../../../core/planner";
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
