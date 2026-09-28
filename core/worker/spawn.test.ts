import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { spawnChildTask } from "./spawn";
import { setWorkerConfig, DEFAULT_WORKER_CONFIG } from "./config";

describe("core/worker/spawn - autonomous follow-up task creation (#10, #15)", () => {
  afterEach(async () => {
    await setWorkerConfig({ ...DEFAULT_WORKER_CONFIG });
  });

  it("creates a genuine child task with parentId set to the originating task", async () => {
    const parent = await prisma.task.create({ data: { title: "root-task" } });
    const result = await spawnChildTask({ parentId: parent.id, title: "verify company information" });
    expect(result.created).toBe(true);
    expect(result.task?.parentId).toBe(parent.id);
    await prisma.task.deleteMany({ where: { OR: [{ id: parent.id }, { parentId: parent.id }] } });
  });

  it("rejects (never truncates) once max child tasks per parent is reached", async () => {
    await setWorkerConfig({ maxChildTasksPerParent: 2 });
    const parent = await prisma.task.create({ data: { title: "limited-parent" } });

    const first = await spawnChildTask({ parentId: parent.id, title: "child one" });
    const second = await spawnChildTask({ parentId: parent.id, title: "child two" });
    const third = await spawnChildTask({ parentId: parent.id, title: "child three" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(third.created).toBe(false);
    expect(third.reason).toMatch(/max child tasks/i);

    const count = await prisma.task.count({ where: { parentId: parent.id } });
    expect(count).toBe(2);

    await prisma.task.deleteMany({ where: { OR: [{ id: parent.id }, { parentId: parent.id }] } });
  });

  it("rejects once max recursion depth is exceeded", async () => {
    await setWorkerConfig({ maxRecursionDepth: 1, maxChildTasksPerParent: 10, maxTasksPerTree: 50 });
    const root = await prisma.task.create({ data: { title: "root" } });
    const level1 = await spawnChildTask({ parentId: root.id, title: "level1" });
    expect(level1.created).toBe(true);

    const level2 = await spawnChildTask({ parentId: level1.task!.id, title: "level2" });
    expect(level2.created).toBe(false);
    expect(level2.reason).toMatch(/recursion depth/i);

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }, { parentId: level1.task!.id }] } });
  });

  it("rejects once max total tasks per tree is reached", async () => {
    await setWorkerConfig({ maxTasksPerTree: 3, maxChildTasksPerParent: 10, maxRecursionDepth: 10 });
    const root = await prisma.task.create({ data: { title: "tree-root" } });
    const a = await spawnChildTask({ parentId: root.id, title: "tree-child-a" });
    expect(a.created).toBe(true);
    const b = await spawnChildTask({ parentId: root.id, title: "tree-child-b" });
    expect(b.created).toBe(true);
    // root + a + b == 3 tasks == maxTasksPerTree, so the next one is rejected.
    const c = await spawnChildTask({ parentId: root.id, title: "tree-child-c" });
    expect(c.created).toBe(false);
    expect(c.reason).toMatch(/max total tasks/i);

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });

  it("rejects a duplicate title anywhere in the same tree", async () => {
    const root = await prisma.task.create({ data: { title: "dup-root" } });
    await spawnChildTask({ parentId: root.id, title: "Research the vendor" });
    const dup = await spawnChildTask({ parentId: root.id, title: "  research THE vendor  " });
    expect(dup.created).toBe(false);
    expect(dup.reason).toMatch(/duplicate/i);

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });

  it("rejecting a spawn also raises a WARNING notification and an audit log entry", async () => {
    await setWorkerConfig({ maxChildTasksPerParent: 0 });
    const parent = await prisma.task.create({ data: { title: "notif-parent" } });

    const notifBefore = await prisma.notification.count({ where: { type: "WARNING" } });
    const auditBefore = await prisma.auditLog.count({ where: { action: "worker.spawn_rejected" } });

    const result = await spawnChildTask({ parentId: parent.id, title: "will be rejected" });
    expect(result.created).toBe(false);

    const notifAfter = await prisma.notification.count({ where: { type: "WARNING" } });
    const auditAfter = await prisma.auditLog.count({ where: { action: "worker.spawn_rejected" } });
    expect(notifAfter).toBeGreaterThan(notifBefore);
    expect(auditAfter).toBeGreaterThan(auditBefore);

    await prisma.task.delete({ where: { id: parent.id } });
  });
});
