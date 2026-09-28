// core/business/intelligence/timeWindows.test.ts - Phase 11, section 9:
// time-window boundary tests, all in Asia/Karachi (fixed UTC+5, no DST).
import { describe, it, expect } from "vitest";
import { resolveTimeWindow } from "./timeWindows";

describe("timeWindows - resolveTimeWindow (Asia/Karachi, never server-local)", () => {
  it("TODAY: a UTC instant just after Karachi midnight resolves to that Karachi calendar day", () => {
    // 2026-09-28T00:30:00Z = 2026-09-28 05:30 Karachi -> TODAY should start at 2026-09-27T19:00:00Z (00:00 Karachi).
    const now = new Date("2026-09-28T00:30:00.000Z");
    const w = resolveTimeWindow("TODAY", now);
    expect(w.start.toISOString()).toBe("2026-09-27T19:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-09-28T19:00:00.000Z");
    expect(w.label).toBe("2026-09-28");
  });

  it("TODAY: a UTC instant just before Karachi midnight still belongs to the NEXT Karachi day (never implicit UTC boundary)", () => {
    // 2026-09-27T20:00:00Z = 2026-09-28 01:00 Karachi.
    const now = new Date("2026-09-27T20:00:00.000Z");
    const w = resolveTimeWindow("TODAY", now);
    expect(w.label).toBe("2026-09-28");
  });

  it("YESTERDAY is exactly one Karachi calendar day before TODAY", () => {
    const now = new Date("2026-09-28T10:00:00.000Z");
    const today = resolveTimeWindow("TODAY", now);
    const yesterday = resolveTimeWindow("YESTERDAY", now);
    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(yesterday.label).toBe("2026-09-27");
  });

  it("THIS_WEEK starts on Monday (Karachi-local)", () => {
    // 2026-09-28 is a Monday.
    const now = new Date("2026-09-30T10:00:00.000Z"); // Wednesday
    const w = resolveTimeWindow("THIS_WEEK", now);
    const startLocalDay = new Date(w.start.getTime() + 5 * 60 * 60 * 1000).getUTCDay();
    expect(startLocalDay).toBe(1); // Monday
  });

  it("LAST_WEEK ends exactly where THIS_WEEK begins", () => {
    const now = new Date("2026-09-30T10:00:00.000Z");
    const thisWeek = resolveTimeWindow("THIS_WEEK", now);
    const lastWeek = resolveTimeWindow("LAST_WEEK", now);
    expect(lastWeek.end.getTime()).toBe(thisWeek.start.getTime());
  });

  it("THIS_MONTH / LAST_MONTH boundaries are contiguous and correct across a year boundary", () => {
    const now = new Date("2027-01-05T10:00:00.000Z");
    const thisMonth = resolveTimeWindow("THIS_MONTH", now);
    const lastMonth = resolveTimeWindow("LAST_MONTH", now);
    expect(lastMonth.end.getTime()).toBe(thisMonth.start.getTime());
    expect(lastMonth.label).toBe("2026-12");
    expect(thisMonth.label).toBe("2027-01");
  });

  it("THIS_QUARTER / LAST_QUARTER are contiguous", () => {
    const now = new Date("2026-04-15T10:00:00.000Z"); // Q2
    const thisQ = resolveTimeWindow("THIS_QUARTER", now);
    const lastQ = resolveTimeWindow("LAST_QUARTER", now);
    expect(lastQ.end.getTime()).toBe(thisQ.start.getTime());
    expect(thisQ.label).toBe("2026-Q2");
    expect(lastQ.label).toBe("2026-Q1");
  });

  it("CUSTOM passes through the given bounds unchanged", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-02T00:00:00.000Z");
    const w = resolveTimeWindow("CUSTOM", new Date(), { start, end });
    expect(w.start).toBe(start);
    expect(w.end).toBe(end);
  });

  it("CUSTOM without bounds throws rather than guessing", () => {
    expect(() => resolveTimeWindow("CUSTOM")).toThrow();
  });
});
