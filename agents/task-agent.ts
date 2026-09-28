// agents/task-agent.ts - a thin, real, DB-backed agent wrapping core/planner
// operations, so the Brain can delegate "create/update/list tasks" to an
// agent call (which goes through the same enforcement gate as any other
// agent) instead of the Brain calling core/planner directly.
import type { AgentInterface, AgentRunResult, AgentStatus } from "./types";
import { planTask, updateTaskStatus, listTasks, type TaskStatus } from "../core/planner";
import { log } from "../security/logger";

type TaskAgentAction = "create" | "update_status" | "list";

export class TaskAgent implements AgentInterface {
  name = "task";
  objective = "Create, update, and list tasks on behalf of the Brain or a human request.";
  status: AgentStatus = "IDLE";

  async run(input: Record<string, unknown> = {}): Promise<AgentRunResult> {
    this.status = "RUNNING";
    const action = (input.action as TaskAgentAction) ?? "list";

    try {
      let result: AgentRunResult;
      switch (action) {
        case "create": {
          const title = typeof input.title === "string" ? input.title : undefined;
          if (!title) {
            result = { status: "FAILED", summary: "A 'title' input is required to create a task." };
            break;
          }
          const tasks = await planTask({
            title,
            description: typeof input.description === "string" ? input.description : undefined,
            priority: input.priority as never,
            subtasks: Array.isArray(input.subtasks) ? (input.subtasks as string[]) : undefined,
          });
          result = {
            status: "SUCCESS",
            summary: `Created task "${title}" with ${tasks.length - 1} subtask(s).`,
            data: { tasks },
            result: { tasks },
            evidence: { taskIds: tasks.map((t) => t.id) },
          };
          break;
        }
        case "update_status": {
          const id = typeof input.id === "string" ? input.id : undefined;
          const newStatus = input.status as TaskStatus | undefined;
          if (!id || !newStatus) {
            result = { status: "FAILED", summary: "Both 'id' and 'status' are required to update a task." };
            break;
          }
          const task = await updateTaskStatus(id, newStatus);
          result = {
            status: "SUCCESS",
            summary: `Task ${id} moved to ${newStatus}.`,
            data: { task },
            result: { task },
            evidence: { taskId: task.id, status: task.status },
          };
          break;
        }
        case "list":
        default: {
          const parentId =
            input.parentId === undefined
              ? undefined
              : input.parentId === null
                ? null
                : String(input.parentId);
          const tasks = await listTasks(parentId);
          result = {
            status: "SUCCESS",
            summary: `Found ${tasks.length} task(s).`,
            data: { tasks },
            result: { tasks },
            evidence: { taskCount: tasks.length },
          };
          break;
        }
      }
      this.status = result.status;
      log("AGENT", "task-agent.run", { action, status: result.status });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = "FAILED";
      log("ERROR", "task-agent.error", { error: message });
      return { status: "FAILED", summary: message, errors: [message] };
    }
  }
}
