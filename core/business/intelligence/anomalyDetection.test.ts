// core/business/intelligence/anomalyDetection.test.ts - Phase 11, section 27.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { detectAnomalies } from "./anomalyDetection";
import { resolveTimeWindow } from "./timeWindows";

beforeEach(async () => {
  await prisma.lead.deleteMany();
});

describe("detectAnomalies", () => {
  it("returns UNKNOWN (nothing to report) when nothing crosses a threshold", async () => {
    const window = resolveTimeWindow("CUSTOM", new Date(), { start: new Date("2020-01-01"), end: new Date("2020-01-02") });
    const result = await detectAnomalies(window);
    expect(result.type).toBe("UNKNOWN");
  });

  it("flags a spike: current window has far more new leads than the prior equal-length window", async () => {
    const now = new Date();
    const durationMs = 24 * 60 * 60 * 1000;
    const window = resolveTimeWindow("CUSTOM", now, { start: new Date(now.getTime() - durationMs), end: now });
    const prevStart = new Date(window.start.getTime() - durationMs);

    // One lead in the prior window (non-zero baseline).
    const prevLead = await prisma.lead.create({ data: { status: "NEW" } });
    await prisma.lead.update({ where: { id: prevLead.id }, data: { createdAt: new Date(prevStart.getTime() + 1000) } });

    // Many leads in the current window -> should cross the spike threshold.
    for (let i = 0; i < 5; i += 1) {
      const l = await prisma.lead.create({ data: { status: "NEW" } });
      await prisma.lead.update({ where: { id: l.id }, data: { createdAt: new Date(window.start.getTime() + 1000) } });
    }

    const result = await detectAnomalies(window);
    expect(result.type).toBe("OBSERVATION");
    expect(result.value!.some((a) => a.metric === "new_leads")).toBe(true);
  });
});
