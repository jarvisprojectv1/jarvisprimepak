import { describe, it, expect } from "vitest";
import { evaluateCondition, parseConditionJson } from "./index";
import { runConditionRulesForEvent, seedExampleConditionRules } from "./rules";
import { publish } from "../events";
import { prisma } from "../../database/client";

describe("core/conditions - the declarative condition evaluator", () => {
  it("evaluates eq/gt via 'all'", () => {
    const condition = { all: [{ field: "payload.status", op: "eq", value: "NEW" }, { field: "payload.score", op: "gt", value: 50 }] };
    expect(evaluateCondition(condition, { payload: { status: "NEW", score: 80 } })).toBe(true);
    expect(evaluateCondition(condition, { payload: { status: "NEW", score: 10 } })).toBe(false);
  });

  it("supports any/not/in/contains", () => {
    expect(evaluateCondition({ any: [{ field: "a", op: "eq", value: 1 }, { field: "a", op: "eq", value: 2 }] }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ not: { field: "a", op: "eq", value: 1 } }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: "a", op: "in", value: [1, 2, 3] }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: "a", op: "contains", value: "ell" }, { a: "hello" })).toBe(true);
  });

  it("fails closed on an unknown operator", () => {
    expect(evaluateCondition({ field: "a", op: "exec", value: "x" }, { a: "x" })).toBe(false);
  });

  it("fails closed on a malformed node instead of throwing", () => {
    expect(evaluateCondition("not an object", {})).toBe(false);
    expect(evaluateCondition(null, {})).toBe(false);
    expect(evaluateCondition({ garbage: true }, {})).toBe(false);
  });

  it("SECURITY: never executes injected code and blocks __proto__ traversal", () => {
    // A condition payload trying to look up a "__proto__.polluted" field must
    // never actually walk into the prototype chain, and must fail closed.
    const malicious = { field: "__proto__.polluted", op: "eq", value: "yes" };
    expect(evaluateCondition(malicious, { anything: 1 })).toBe(false);
    // Confirm no pollution actually occurred.
    expect(({} as any).polluted).toBeUndefined();

    // A condition trying to smuggle a function/eval-like string as a value
    // is just treated as inert data - it is never eval'd or invoked.
    const withCodeString = { field: "cmd", op: "eq", value: "require('fs').rmSync('/', {recursive:true})" };
    expect(evaluateCondition(withCodeString, { cmd: "safe" })).toBe(false);
  });

  it("parseConditionJson fails closed on invalid JSON", () => {
    expect(parseConditionJson("{not valid json")).toBeNull();
  });
});

describe("core/conditions - rule wiring (seeded, data-driven rules)", () => {
  it("a CRM lead event with status=NEW and score>threshold creates a research task", async () => {
    await seedExampleConditionRules();
    const before = await prisma.task.count();

    await publish({
      type: "CRM.lead.created",
      payload: { leadId: "lead-1", status: "NEW", score: 90 },
      source: "test",
    });

    const after = await prisma.task.count();
    expect(after).toBeGreaterThan(before);
    const latest = await prisma.task.findFirst({ orderBy: { createdAt: "desc" } });
    expect(latest?.title.toLowerCase()).toContain("research");
  });

  it("a CRM lead event that does not match the condition creates no task via that rule", async () => {
    await seedExampleConditionRules();
    const before = await prisma.task.count();

    await publish({
      type: "CRM.lead.created",
      payload: { leadId: "lead-2", status: "CONTACTED", score: 10 },
      source: "test",
    });

    const after = await prisma.task.count();
    expect(after).toBe(before);
  });

  it("a SCHEDULE.fired event for the morning-briefing job creates a briefing task", async () => {
    await seedExampleConditionRules();
    const before = await prisma.task.count();

    await publish({
      type: "SCHEDULE.fired",
      payload: { jobName: "morning-briefing" },
      source: "test",
    });

    const after = await prisma.task.count();
    expect(after).toBeGreaterThan(before);
  });

  it("Phase 5 (#8): a SCHEDULE.fired event for the daily-report job creates a task tagged toolName:'reports'", async () => {
    await seedExampleConditionRules();

    await publish({
      type: "SCHEDULE.fired",
      payload: { jobName: "daily-report" },
      source: "test",
    });

    const latest = await prisma.task.findFirst({ orderBy: { createdAt: "desc" } });
    expect(latest?.title.toLowerCase()).toContain("daily executive report");
    expect(latest?.toolName).toBe("reports");
  });
});
