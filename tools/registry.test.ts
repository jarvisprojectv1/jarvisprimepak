import { describe, it, expect, beforeAll } from "vitest";
import { ToolRegistry, type Tool } from "./registry";

describe("tools/registry", () => {
  let registry: ToolRegistry;

  beforeAll(() => {
    registry = new ToolRegistry();
  });

  const echoTool: Tool = {
    name: "echo-test",
    description: "Echoes its input.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    async execute(input) {
      return { status: "OK", message: "echoed", data: input };
    },
  };

  const notImplementedTool: Tool = {
    name: "phase4-test",
    description: "A tool for a later phase.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { status: "NOT_IMPLEMENTED", message: "Not implemented yet." };
    },
  };

  it("registers a tool and lists it", () => {
    registry.register(echoTool);
    expect(registry.list().map((t) => t.name)).toContain("echo-test");
  });

  it("refuses to register the same tool name twice", () => {
    expect(() => registry.register(echoTool)).toThrow();
  });

  it("executes a registered tool and returns its result", async () => {
    const result = await registry.execute("echo-test", { text: "hi" });
    expect(result.status).toBe("OK");
    expect(result.data).toEqual({ text: "hi" });
  });

  it("returns ERROR for an unregistered tool name", async () => {
    const result = await registry.execute("does-not-exist");
    expect(result.status).toBe("ERROR");
  });

  it("surfaces NOT_IMPLEMENTED from a stub tool without throwing", async () => {
    registry.register(notImplementedTool);
    const result = await registry.execute("phase4-test");
    expect(result.status).toBe("NOT_IMPLEMENTED");
  });

  it("catches a throwing tool and returns status ERROR", async () => {
    registry.register({
      name: "throws",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        throw new Error("boom");
      },
    });
    const result = await registry.execute("throws");
    expect(result.status).toBe("ERROR");
    expect(result.message).toContain("boom");
  });
});
