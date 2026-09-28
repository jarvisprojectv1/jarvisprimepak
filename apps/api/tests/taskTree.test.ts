// apps/api/tests/taskTree.test.ts - hardening pass (#9): GET /tasks/:id/tree
// reconstructs one connected task tree (root + real children + statuses) and
// the AuditLog entries recorded against it, matching what's actually in the
// DB. Uses the existing `task.read` authz action (no new AuthzAction needed).
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { prisma } from "../../../database/client";
import { writeAuditLog } from "../../../security/audit";
import { createTestOwner, authHeader } from "./testAuth";

describe("GET /tasks/:id/tree - hardening pass task-tree observability", () => {
  let owner: { userId: string; email: string; token: string };

  beforeAll(async () => {
    registerBuiltinTools();
    registerBuiltinAgents();
    owner = await createTestOwner();
  });

  it("requires authentication", async () => {
    const app = createApp();
    const root = await prisma.task.create({ data: { title: "auth-check-root" } });
    const res = await request(app).get(`/tasks/${root.id}/tree`);
    expect(res.status).toBe(401);
    await prisma.task.delete({ where: { id: root.id } });
  });

  it("404s for a task id that doesn't exist", async () => {
    const app = createApp();
    const res = await request(app).get("/tasks/does-not-exist/tree").set(...authHeader(owner.token));
    expect(res.status).toBe(404);
  });

  it("returns a reconstructable tree (root + children + statuses) matching what's actually in the DB, plus the audit trail filtered by those task ids", async () => {
    const root = await prisma.task.create({ data: { title: "tree-root-task", status: "DONE" } });
    const child1 = await prisma.task.create({
      data: { title: "step one", parentId: root.id, stepId: "s1", toolName: "files", status: "DONE" },
    });
    const child2 = await prisma.task.create({
      data: { title: "step two", parentId: root.id, stepId: "s2", agentName: "research", status: "FAILED", failureReason: "simulated" },
    });
    await writeAuditLog({ actor: "service:worker", action: "worker.task_claimed", target: root.id, meta: { title: root.title } });
    await writeAuditLog({ actor: "service:worker", action: "brain.step_outcome", target: child1.id, meta: { stepId: "s1", status: "SUCCESS" } });
    await writeAuditLog({ actor: "service:worker", action: "brain.step_outcome", target: child2.id, meta: { stepId: "s2", status: "FAILED" } });

    const app = createApp();
    const res = await request(app).get(`/tasks/${root.id}/tree`).set(...authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.root.id).toBe(root.id);
    expect(res.body.root.status).toBe("DONE");

    const childIds = res.body.children.map((c: { id: string }) => c.id).sort();
    expect(childIds).toEqual([child1.id, child2.id].sort());

    const returnedChild2 = res.body.children.find((c: { id: string }) => c.id === child2.id);
    expect(returnedChild2.status).toBe("FAILED");
    expect(returnedChild2.stepId).toBe("s2");
    expect(returnedChild2.agentName).toBe("research");

    // rootOutcome: one DONE + one FAILED child -> PARTIAL (some succeeded).
    expect(res.body.rootOutcome).toBe("PARTIAL");

    const auditTargets = res.body.auditTrail.map((a: { target: string }) => a.target).sort();
    expect(auditTargets).toEqual([root.id, child1.id, child2.id].sort());

    // Never leaks anything secret-shaped: meta only ever contains what was
    // written above (plain task titles/statuses), nothing resembling a
    // token/password/API key.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(serialized.toLowerCase()).not.toMatch(/password|passwordhash/);

    await prisma.task.deleteMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] } });
  });
});
