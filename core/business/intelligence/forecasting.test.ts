// core/business/intelligence/forecasting.test.ts - Phase 11, sections 28-30:
// forecast confidence labeling.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { forecastNewLeads } from "./forecasting";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.lead.deleteMany();
});

describe("forecastNewLeads", () => {
  it("returns UNKNOWN with no historical data at all", async () => {
    const window = resolveTimeWindow("CUSTOM", new Date(), { start: new Date("2020-01-01"), end: new Date("2020-01-02") });
    const result = await forecastNewLeads(window, 4);
    expect(result.type).toBe("UNKNOWN");
  });

  it("labels confidence LOW with sparse historical data, never a bare unlabeled number", async () => {
    const now = new Date();
    const durationMs = 24 * 60 * 60 * 1000;
    const window = resolveTimeWindow("CUSTOM", now, { start: new Date(now.getTime() - durationMs), end: now });
    // Exactly one non-zero historical period out of 8.
    const l = await prisma.lead.create({ data: { status: "NEW" } });
    await prisma.lead.update({ where: { id: l.id }, data: { createdAt: new Date(window.start.getTime() - durationMs + 1000) } });

    const result = await forecastNewLeads(window, 8);
    expect(result.type).toBe("FORECAST");
    expect(result.confidence).toBe("LOW");
    expect(typeof result.value!.projectedNextWindow).toBe("number");
  });
});
