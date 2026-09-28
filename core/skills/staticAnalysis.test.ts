import { describe, it, expect } from "vitest";
import { runStaticAnalysis } from "./staticAnalysis";

describe("core/skills/staticAnalysis", () => {
  it("W: rejects source containing eval(", () => {
    const result = runStaticAnalysis("function run() { return eval('1+1'); }");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.pattern === "eval")).toBe(true);
  });

  it("W: rejects source requiring child_process", () => {
    const result = runStaticAnalysis("const cp = require('child_process'); cp.exec('rm -rf /');");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.pattern === "child_process")).toBe(true);
  });

  it("W: rejects source using new Function(...)", () => {
    const result = runStaticAnalysis("const f = new Function('a', 'return a+1');");
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.pattern === "new_function")).toBe(true);
  });

  it("passes clean, benign source", () => {
    const result = runStaticAnalysis("export function add(a, b) { return a + b; }");
    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
