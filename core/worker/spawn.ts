// core/worker/spawn.ts - Autonomous follow-up task creation, with hard limits
// (Phase 5 / Autonomous Worker, requirements #10 and #15).
//
// Reuses core/planner.planTask() (never a second task-creation code path),
// with the new task's parentId set to the originating task - exactly what
// #10 asks for. Enforced IN CODE (not just documented): max child tasks per
// parent, max recursion depth, max total tasks in a tree, and duplicate
// detection (exact-match-on-normalized-title, no embeddings needed for this
// scope). Any violation REJECTS the creation - it never silently truncates
// or crashes - and both logs a WARNING and raises a real Notification, plus
// an audit log entry, per the "every automatic stop" requirement (#15).
import { prisma } from "../../database/client";
import { planTask, type PlannedTask, type TaskPriority } from "../planner";
import { getWorkerConfig } from "./config";
import { notificationService } from "../notifications";
import { writeAuditLog } from "../../security/audit";
import { WORKER_IDENTITY, identityToActorString } from "../auth/identity";
import { log } from "../../security/logger";

export interface SpawnChildTaskInput {
  parentId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
}

export interface SpawnResult {
  created: boolean;
  task?: PlannedTask;
  reason?: string;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Walks parentId links to the tree root, returning [root, ...allDescendantsCollected]. Bounded by maxDepth+2 hops as a safety net against a corrupt cycle. */
async function computeDepthAndRoot(parentId: string, maxDepth: number): Promise<{ depth: number; rootId: string }> {
  let depth = 1; // the new child would be at parent's depth + 1
  let currentId = parentId;
  let rootId = parentId;
  for (let hops = 0; hops <= maxDepth + 2; hops++) {
    const row = await prisma.task.findUnique({ where: { id: currentId }, select: { parentId: true } });
    if (!row || !row.parentId) {
      rootId = currentId;
      break;
    }
    currentId = row.parentId;
    rootId = currentId;
    depth += 1;
  }
  return { depth, rootId };
}

async function collectTree(rootId: string, cap: number): Promise<{ id: string; title: string }[]> {
  const collected: { id: string; title: string }[] = [];
  let frontier = [rootId];
  while (frontier.length > 0 && collected.length < cap) {
    const rows = await prisma.task.findMany({
      where: { OR: [{ id: { in: frontier } }, { parentId: { in: frontier } }] },
      select: { id: true, title: true, parentId: true },
    });
    const newIds: string[] = [];
    for (const r of rows) {
      if (!collected.find((c) => c.id === r.id)) {
        collected.push({ id: r.id, title: r.title });
        newIds.push(r.id);
      }
    }
    frontier = rows.filter((r) => r.parentId && newIds.includes(r.id)).map((r) => r.id);
    if (newIds.length === 0) break;
  }
  return collected;
}

async function rejectSpawn(parentId: string, title: string, reason: string): Promise<SpawnResult> {
  log("WARNING", "worker.spawn_rejected", { parentId, title, reason });
  await notificationService.create({
    title: "Autonomous task creation rejected",
    body: `JARVIS declined to create follow-up task "${title}" (parent ${parentId}): ${reason}`,
    type: "WARNING",
  });
  await writeAuditLog({
    actor: identityToActorString(WORKER_IDENTITY),
    action: "worker.spawn_rejected",
    target: parentId,
    meta: { title, reason },
  });
  return { created: false, reason };
}

/**
 * Creates a genuine follow-up task under `input.parentId`, enforcing (in
 * order): max recursion depth, max child tasks per parent, max total tasks
 * per tree, and duplicate detection (case/whitespace-insensitive exact title
 * match anywhere in the same tree). The Brain/TaskAgent should call this
 * (via TaskAgent's "create_child" action) rather than core/planner.planTask
 * directly whenever a plan step wants to spawn genuinely new follow-up work.
 */
export async function spawnChildTask(input: SpawnChildTaskInput): Promise<SpawnResult> {
  const config = await getWorkerConfig();
  const parent = await prisma.task.findUnique({ where: { id: input.parentId } });
  if (!parent) {
    return rejectSpawn(input.parentId, input.title, "Parent task does not exist.");
  }

  const { depth, rootId } = await computeDepthAndRoot(input.parentId, config.maxRecursionDepth);
  if (depth > config.maxRecursionDepth) {
    return rejectSpawn(
      input.parentId,
      input.title,
      `Max recursion depth (${config.maxRecursionDepth}) would be exceeded (new task would be at depth ${depth}).`
    );
  }

  const directChildren = await prisma.task.count({ where: { parentId: input.parentId } });
  if (directChildren >= config.maxChildTasksPerParent) {
    return rejectSpawn(
      input.parentId,
      input.title,
      `Max child tasks per parent (${config.maxChildTasksPerParent}) already reached.`
    );
  }

  const tree = await collectTree(rootId, config.maxTasksPerTree + 1);
  if (tree.length >= config.maxTasksPerTree) {
    return rejectSpawn(
      input.parentId,
      input.title,
      `Max total tasks per tree (${config.maxTasksPerTree}) already reached.`
    );
  }

  const normalizedNew = normalizeTitle(input.title);
  const duplicate = tree.find((t) => normalizeTitle(t.title) === normalizedNew);
  if (duplicate) {
    return rejectSpawn(
      input.parentId,
      input.title,
      `Duplicate task rejected: a task with the same title already exists in this tree (task ${duplicate.id}).`
    );
  }

  const [created] = await planTask({
    title: input.title,
    description: input.description,
    priority: input.priority,
    parentId: input.parentId,
  });

  log("ACTION", "worker.spawn_created", { parentId: input.parentId, taskId: created.id, title: input.title });
  return { created: true, task: created };
}
