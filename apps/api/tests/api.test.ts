import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";

describe("API smoke tests", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
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
});
