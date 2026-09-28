// core/business/intelligence/memoryIntegration.test.ts - Phase 11, sections
// 38-40: memory fact-vs-assumption distinction.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { recordStatementToMemory, recordConfirmedFacts } from "./memoryIntegration";
import type { IntelligenceStatement } from "./types";

beforeEach(async () => {
  await prisma.memory.deleteMany();
});

function stmt(overrides: Partial<IntelligenceStatement>): IntelligenceStatement {
  return {
    id: "x1",
    type: "FACT",
    label: "L",
    value: 1,
    narrative: "n",
    provenance: { sourceIds: [], calculationMethod: "m" },
    ...overrides,
  };
}

describe("recordStatementToMemory - FACT vs assumption distinction", () => {
  it("writes a FACT with confidence 1 under a fact: key", async () => {
    const outcome = await recordStatementToMemory(stmt({ type: "FACT" }));
    expect(outcome.written).toBe(true);
    expect(outcome.key).toContain("fact:");
    const row = await prisma.memory.findFirst({ where: { key: outcome.key! } });
    expect(row?.confidence).toBe(1);
  });

  it("never writes UNKNOWN statements", async () => {
    const outcome = await recordStatementToMemory(stmt({ type: "UNKNOWN", value: null }));
    expect(outcome.written).toBe(false);
    const count = await prisma.memory.count();
    expect(count).toBe(0);
  });

  it("does NOT write a FORECAST/RECOMMENDATION unless includeAssumptions is explicitly set", async () => {
    const outcome = await recordStatementToMemory(stmt({ type: "FORECAST" }));
    expect(outcome.written).toBe(false);
  });

  it("writes a FORECAST as a lower-confidence assumption, under a distinct key, when opted in", async () => {
    const outcome = await recordStatementToMemory(stmt({ type: "FORECAST" }), { includeAssumptions: true });
    expect(outcome.written).toBe(true);
    expect(outcome.key).toContain("assumption:");
    const row = await prisma.memory.findFirst({ where: { key: outcome.key! } });
    expect(row?.confidence).toBeLessThan(1);
  });
});

describe("recordConfirmedFacts", () => {
  it("only records FACT-typed statements, skipping everything else", async () => {
    const statements = [stmt({ id: "a", type: "FACT" }), stmt({ id: "b", type: "FORECAST" }), stmt({ id: "c", type: "UNKNOWN", value: null })];
    const outcomes = await recordConfirmedFacts(statements);
    expect(outcomes.length).toBe(1);
    const count = await prisma.memory.count();
    expect(count).toBe(1);
  });
});
