import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { prisma } from "../../../database/client";
import { createTestOwner, authHeader } from "./testAuth";

describe("Phase 5 API - Autonomous Worker observability & owner resume (#9, #12)", () => {
  let owner: { userId: string; email: string; token: string };

  beforeAll(async () => {
    registerBuiltinTools();
    registerBuiltinAgents();
    owner = await createTestOwner();
  });

  it("GET /worker/status is authenticated and reports a queue size", async () => {
    const app = createApp();
    const unauth = await request(app).get("/worker/status");
    expect(unauth.status).toBe(401);

    const res = await request(app).get("/worker/status").set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(typeof res.body.queueSize).toBe("number");
  });

  it("GET /worker/report/latest returns the most recently generated report (or null)", async () => {
    const app = createApp();
    const res = await request(app).get("/worker/report/latest").set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect("report" in res.body).toBe(true);
  });

  it("#9: POST /tasks/:id/resume moves a WAITING task back to PENDING so the worker can pick it up", async () => {
    const app = createApp();
    const task = await prisma.task.create({
      data: { title: "waiting-for-owner", status: "WAITING", waitingReason: "need company name" },
    });

    const res = await request(app)
      .post(`/tasks/${task.id}/resume`)
      .set(...authHeader(owner.token))
      .send({ info: "Prime Pak Packages" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.waitingReason).toBeNull();

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("PENDING");

    await prisma.task.delete({ where: { id: task.id } });
  });

  it("resume is a no-op error for a task that isn't WAITING/BLOCKED", async () => {
    const app = createApp();
    const task = await prisma.task.create({ data: { title: "already-pending", status: "PENDING" } });

    const res = await request(app)
      .post(`/tasks/${task.id}/resume`)
      .set(...authHeader(owner.token))
      .send({});

    expect(res.status).toBe(400);
    await prisma.task.delete({ where: { id: task.id } });
  });

  it("GET /system/health includes an 11th 'worker' component", async () => {
    const app = createApp();
    const res = await request(app).get("/system/health").set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.components.worker).toBeDefined();
  });
});
