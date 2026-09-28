import { describe, it, expect, beforeAll } from "vitest";
import { getSystemHealth } from "./index";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";

describe("core/health - system health checks", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  it("aggregates all components into an overall status", async () => {
    const report = await getSystemHealth();
    expect(["HEALTHY", "DEGRADED", "FAILED", "UNKNOWN"]).toContain(report.status);
    expect(report.components.database).toBeDefined();
    expect(report.components.toolRegistry.status).toBe("HEALTHY");
  });

  it("never includes a stack trace or file path style leak in reasons", async () => {
    const report = await getSystemHealth();
    for (const component of Object.values(report.components)) {
      expect(component.reason).not.toMatch(/at .*\.(ts|js):\d+/);
      expect(component.reason).not.toMatch(/node_modules/);
    }
  });
});
