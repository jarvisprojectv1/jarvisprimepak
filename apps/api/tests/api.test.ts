import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { setSystemState } from "../../../core/state";

describe("API smoke tests", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  afterEach(async () => {
    await setSystemState("RUNNING", "test cleanup", "test");
  });

  it("GET /health returns ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("POST /chat fails cleanly with CONFIGURATION_REQUIRED when no API key is set", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const app = createApp();
    const res = await request(app)
      .post("/chat")
      .send({ message: "Hello JARVIS", conversationId: "test-convo" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.configurationRequired).toBe(true);
    expect(res.body.reply).toContain("CONFIGURATION REQUIRED");

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("GET /tools lists registered tools", async () => {
    const app = createApp();
    const res = await request(app).get("/tools");
    expect(res.status).toBe(200);
    const names = res.body.map((t: { name: string }) => t.name);
    expect(names).toContain("files");
    expect(names).toContain("browser");
  });

  it("GET /system/state reports RUNNING by default", async () => {
    const app = createApp();
    const res = await request(app).get("/system/state");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("RUNNING");
  });

  it("POST /system/pause blocks a subsequent tool execution, /system/resume unblocks it", async () => {
    const app = createApp();

    const pauseRes = await request(app).post("/system/pause").send({ reason: "api test" });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.state).toBe("PAUSED");

    const blockedResult = await request(app)
      .post("/tools/files/execute")
      .send({ action: "list", path: "." });
    expect(blockedResult.body.status).toBe("BLOCKED");

    const resumeRes = await request(app).post("/system/resume").send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.state).toBe("RUNNING");

    const okResult = await request(app)
      .post("/tools/files/execute")
      .send({ action: "list", path: "." });
    expect(okResult.body.status).not.toBe("BLOCKED");
  });
});
