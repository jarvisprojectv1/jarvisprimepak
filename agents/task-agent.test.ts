import { describe, it, expect } from "vitest";
import { TaskAgent } from "./task-agent";
import { prisma } from "../database/client";

describe("agents/task-agent - create_child action (Phase 5, #10)", () => {
  it("creates a genuine child task under the given parent", async () => {
    const agent = new TaskAgent();
    const parent = await prisma.task.create({ data: { title: "agent-parent" } });

    const result = await agent.run({ action: "create_child", parentId: parent.id, title: "follow up on quote" });
    expect(result.status).toBe("SUCCESS");
    expect((result.data as any).task.parentId).toBe(parent.id);

    await prisma.task.deleteMany({ where: { OR: [{ id: parent.id }, { parentId: parent.id }] } });
  });

  it("reports FAILED (never fabricates success) when the spawn is rejected", async () => {
    const agent = new TaskAgent();
    const parent = await prisma.task.create({ data: { title: "agent-parent-2" } });
    await agent.run({ action: "create_child", parentId: parent.id, title: "dup" });
    const second = await agent.run({ action: "create_child", parentId: parent.id, title: "dup" });
    expect(second.status).toBe("FAILED");

    await prisma.task.deleteMany({ where: { OR: [{ id: parent.id }, { parentId: parent.id }] } });
  });
});
