// core/business/intelligence/snapshot.test.ts - Phase 11, section 8: an
// immutable, idempotent-per-period BusinessSnapshot.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../../../database/client";
import { getOrCreateBusinessSnapshot, computePeriodKey } from "./snapshot";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.businessSnapshot.deleteMany();
  await prisma.lead.deleteMany();
});

describe("getOrCreateBusinessSnapshot", () => {
  it("creates exactly one row for a given period+type", async () => {
    const window = resolveTimeWindow("TODAY");
    await getOrCreateBusinessSnapshot("DAILY", window);
    const count = await prisma.businessSnapshot.count();
    expect(count).toBe(1);
  });

  it("is idempotent: a second call for the same period+type returns the SAME row, never a duplicate (worker-retry safety)", async () => {
    const window = resolveTimeWindow("TODAY");
    const first = await getOrCreateBusinessSnapshot("DAILY", window);
    const second = await getOrCreateBusinessSnapshot("DAILY", window);
    expect(second.id).toBe(first.id);
    const count = await prisma.businessSnapshot.count();
    expect(count).toBe(1);
  });

  it("the periodKey is deterministic from snapshotType+window bounds", () => {
    const window = resolveTimeWindow("TODAY");
    const a = computePeriodKey("DAILY", window);
    const b = computePeriodKey("DAILY", window);
    expect(a).toBe(b);
  });

  it("a re-generated snapshot for the same period is never mutated, even if underlying data changes later", async () => {
    const window = resolveTimeWindow("TODAY");
    const first = await getOrCreateBusinessSnapshot("DAILY", window);
    await prisma.lead.create({ data: { status: "NEW" } });
    const second = await getOrCreateBusinessSnapshot("DAILY", window);
    expect(second.generatedAt.getTime()).toBe(first.generatedAt.getTime());
    expect(JSON.stringify(second.statements)).toBe(JSON.stringify(first.statements));
  });
});
