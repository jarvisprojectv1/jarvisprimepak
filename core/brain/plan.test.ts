import { describe, it, expect, beforeAll } from "vitest";
import { validatePlan, parseAndValidatePlan } from "./plan";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";

describe("core/brain/plan - validatePlan", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  function validPlan() {
    return {
      goal: "Test goal",
      reasoning_summary: "Because it's a test.",
      successCriteria: "All steps succeed.",
      steps: [
        {
          stepId: "s1",
          description: "List sandbox files",
          tool: "files",
          arguments: { action: "list", path: "." },
          expectedResult: "A list of files",
          verification: "The tool returns status OK",
        },
      ],
    };
  }

  it("accepts a well-formed plan naming a real, registered tool", () => {
    const result = validatePlan(validPlan());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a well-formed plan naming a real, registered agent", () => {
    const plan = validPlan();
    plan.steps[0] = {
      stepId: "s1",
      description: "Research something",
      agent: "research",
      arguments: { topic: "packaging" },
      expectedResult: "Research findings",
      verification: "Agent returns SUCCESS or NOT_IMPLEMENTED",
    } as any;
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
  });

  it("rejects a plan with zero steps", () => {
    const plan = validPlan();
    plan.steps = [];
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("non-empty"))).toBe(true);
  });

  it("rejects a step naming a tool that doesn't exist in the registry", () => {
    const plan = validPlan();
    (plan.steps[0] as any).tool = "not-a-real-tool";
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not a registered tool"))).toBe(true);
  });

  it("rejects a step naming an agent that doesn't exist in the registry", () => {
    const plan = validPlan();
    delete (plan.steps[0] as any).tool;
    (plan.steps[0] as any).agent = "not-a-real-agent";
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not a registered agent"))).toBe(true);
  });

  it("rejects a step naming both a tool and an agent", () => {
    const plan = validPlan();
    (plan.steps[0] as any).agent = "research";
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must not name both"))).toBe(true);
  });

  it("rejects a step naming neither a tool nor an agent", () => {
    const plan = validPlan();
    delete (plan.steps[0] as any).tool;
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must name exactly one"))).toBe(true);
  });

  it("rejects missing required top-level fields", () => {
    const result = validatePlan({ steps: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("goal"))).toBe(true);
  });

  it("rejects a dependsOn reference to an unknown stepId", () => {
    const plan = validPlan();
    plan.steps.push({
      stepId: "s2",
      description: "Depends on a made-up step",
      tool: "files",
      arguments: { action: "list" },
      expectedResult: "ok",
      verification: "ok",
      dependsOn: ["does-not-exist"],
    } as any);
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown stepId"))).toBe(true);
  });

  it("parseAndValidatePlan fails closed on malformed JSON", () => {
    const result = parseAndValidatePlan("{ not valid json");
    expect(result.plan).toBeNull();
  });

  it("parseAndValidatePlan accepts JSON wrapped in a fenced code block", () => {
    const wrapped = "```json\n" + JSON.stringify(validPlan()) + "\n```";
    const result = parseAndValidatePlan(wrapped);
    expect(result.plan).not.toBeNull();
  });
});
