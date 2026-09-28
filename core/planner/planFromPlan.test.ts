// core/planner/planFromPlan.test.ts - hardening pass: closing the generic
// worker -> Brain task-tree seam (planner-level: the `rootTaskId` option and
// the retry-duplication guard) plus `deriveRootOutcome`'s aggregation rules.
import { describe, it, expect } from "vitest";
import { prisma } from "../../database/client";
import { planFromPlan, deriveRootOutcome, updateTaskStatus, type TaskStatus } from "./index";

const SAMPLE_PLAN = {
  goal: "Do a two-step thing",
  steps: [
    { stepId: "s1", description: "Step one", tool: "files" },
    { stepId: "s2", description: "Step two", agent: "research" },
  ],
};

describe("core/planner.planFromPlan - rootTaskId option (hardening pass)", () => {
  it("A/B: attaches every step-subtask as a real child (parentId) of the supplied rootTaskId - no new, unrelated parent task is created", async () => {
    const root = await prisma.task.create({ data: { title: "worker-triggered task" } });

    const { parent, subtasks } = await planFromPlan(SAMPLE_PLAN, { rootTaskId: root.id });

    // No duplicate parent row: the returned "parent" IS the caller's own task.
    expect(parent.id).toBe(root.id);
    const rowCount = await prisma.task.count();
    // root + 2 subtasks only - no extra Brain-created parent task.
    expect(subtasks.length).toBe(2);

    for (const sub of subtasks) {
      expect(sub.parentId).toBe(root.id);
    }
    const childrenInDb = await prisma.task.findMany({ where: { parentId: root.id } });
    expect(childrenInDb.length).toBe(2);
    expect(childrenInDb.map((c) => c.stepId).sort()).toEqual(["s1", "s2"]);

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });

  it("throws for a rootTaskId that does not exist (fails closed, never silently creates an orphan tree)", async () => {
    await expect(planFromPlan(SAMPLE_PLAN, { rootTaskId: "does-not-exist" })).rejects.toThrow();
  });

  it("E: reuses existing non-terminal children under the same root instead of creating a second, duplicate set (retry-duplication guard)", async () => {
    const root = await prisma.task.create({ data: { title: "retried root task" } });

    const first = await planFromPlan(SAMPLE_PLAN, { rootTaskId: root.id });
    expect(first.subtasks.length).toBe(2);
    const countAfterFirst = await prisma.task.count({ where: { parentId: root.id } });
    expect(countAfterFirst).toBe(2);

    // Simulate a worker retry re-invoking the Brain against the SAME root
    // while the previous attempt's children are still non-terminal (PENDING).
    const second = await planFromPlan(SAMPLE_PLAN, { rootTaskId: root.id });
    expect(second.reusedExisting).toBe(true);
    expect(second.subtasks.map((s) => s.id).sort()).toEqual(first.subtasks.map((s) => s.id).sort());

    const countAfterSecond = await prisma.task.count({ where: { parentId: root.id } });
    expect(countAfterSecond).toBe(2); // unchanged - no duplicate set appeared

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });

  it("allows a genuine fresh re-plan once every existing child has reached a terminal status", async () => {
    const root = await prisma.task.create({ data: { title: "finished-then-replanned root" } });
    const first = await planFromPlan(SAMPLE_PLAN, { rootTaskId: root.id });
    for (const sub of first.subtasks) {
      await updateTaskStatus(sub.id, "DONE");
    }

    const second = await planFromPlan(SAMPLE_PLAN, { rootTaskId: root.id });
    expect(second.reusedExisting).toBeUndefined();
    const total = await prisma.task.count({ where: { parentId: root.id } });
    expect(total).toBe(4); // first set (2, now DONE) + a genuinely fresh set (2)

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });
});

describe("core/planner.deriveRootOutcome - failure-propagation rules", () => {
  const S = (...statuses: TaskStatus[]) => statuses;

  it("all children DONE -> DONE", () => {
    expect(deriveRootOutcome(S("DONE", "DONE"))).toBe("DONE");
  });

  it("any child BLOCKED -> BLOCKED (highest precedence)", () => {
    expect(deriveRootOutcome(S("DONE", "BLOCKED", "FAILED"))).toBe("BLOCKED");
  });

  it("any child WAITING -> WAITING", () => {
    expect(deriveRootOutcome(S("DONE", "WAITING"))).toBe("WAITING");
  });

  it("some FAILED, some DONE -> PARTIAL", () => {
    expect(deriveRootOutcome(S("DONE", "FAILED"))).toBe("PARTIAL");
  });

  it("all FAILED, none DONE -> FAILED", () => {
    expect(deriveRootOutcome(S("FAILED", "FAILED"))).toBe("FAILED");
  });

  it("no children yet -> PENDING", () => {
    expect(deriveRootOutcome([])).toBe("PENDING");
  });

  it("a still in-flight child (RETRYING) with no WAITING/BLOCKED -> PENDING (tree not finished)", () => {
    expect(deriveRootOutcome(S("DONE", "RETRYING"))).toBe("PENDING");
  });
});
