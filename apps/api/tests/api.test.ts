import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { setSystemState } from "../../../core/state";
import { createTestOwner, authHeader } from "./testAuth";

describe("API smoke tests", () => {
  let owner: { userId: string; email: string; token: string };

  beforeAll(async () => {
    registerBuiltinTools();
    registerBuiltinAgents();
    owner = await createTestOwner();
  });

  afterEach(async () => {
    await setSystemState("RUNNING", "test cleanup", "test");
  });

  it("GET /health returns ok, unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /tools without a session is rejected (401)", async () => {
    const app = createApp();
    const res = await request(app).get("/tools");
    expect(res.status).toBe(401);
  });

  it("POST /chat fails cleanly with CONFIGURATION_REQUIRED when no API key is set (authenticated)", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const app = createApp();
    const res = await request(app)
      .post("/chat")
      .set(...authHeader(owner.token))
      .send({ message: "Hello JARVIS", conversationId: "test-convo" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.configurationRequired).toBe(true);
    expect(res.body.reply).toContain("CONFIGURATION REQUIRED");

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("GET /tools lists registered tools (authenticated)", async () => {
    const app = createApp();
    const res = await request(app).get("/tools").set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    const names = res.body.map((t: { name: string }) => t.name);
    expect(names).toContain("files");
    expect(names).toContain("browser");
  });

  it("GET /system/state reports RUNNING by default (authenticated)", async () => {
    const app = createApp();
    const res = await request(app).get("/system/state").set(...authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("RUNNING");
  });

  it("POST /system/pause blocks a subsequent tool execution, /system/resume unblocks it", async () => {
    const app = createApp();

    const pauseRes = await request(app)
      .post("/system/pause")
      .set(...authHeader(owner.token))
      .send({ reason: "api test" });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.state).toBe("PAUSED");

    const blockedResult = await request(app)
      .post("/tools/files/execute")
      .set(...authHeader(owner.token))
      .send({ action: "list", path: "." });
    expect(blockedResult.body.status).toBe("BLOCKED");

    const resumeRes = await request(app)
      .post("/system/resume")
      .set(...authHeader(owner.token))
      .send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.state).toBe("RUNNING");

    const okResult = await request(app)
      .post("/tools/files/execute")
      .set(...authHeader(owner.token))
      .send({ action: "list", path: "." });
    expect(okResult.body.status).not.toBe("BLOCKED");
  });
});
