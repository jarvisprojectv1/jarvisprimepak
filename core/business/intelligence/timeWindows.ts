// core/business/intelligence/timeWindows.ts - Phase 11, section 9: time
// windows resolved in Asia/Karachi, never implicit server-local time.
//
// Mechanism: scheduler/index.ts already established (and documented, with
// its own verification comment on the "morning-briefing"/"daily-report"
// jobs) that Pakistan Standard Time is a FIXED UTC+5 offset with no daylight
// saving - Pakistan abolished DST after a brief 2008-2009 trial. That is a
// genuinely fixed offset (unlike most IANA zones), so date-boundary
// arithmetic can be done with a plain +05:00 offset rather than needing a
// full tz-database dependency. This file is the one place that arithmetic
// lives; every BI module resolves its window through here rather than
// re-deriving Karachi-local date boundaries itself.
export const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, fixed, no DST (see header)

export type TimeWindowName =
  | "TODAY"
  | "YESTERDAY"
  | "THIS_WEEK"
  | "LAST_WEEK"
  | "THIS_MONTH"
  | "LAST_MONTH"
  | "THIS_QUARTER"
  | "LAST_QUARTER"
  | "CUSTOM";

export interface ResolvedWindow {
  name: TimeWindowName;
  /** UTC instants marking the window bounds - start inclusive, end exclusive. */
  start: Date;
  end: Date;
  /** Karachi-local calendar label, e.g. "2026-09-28" or "2026-09-22..2026-09-28". */
  label: string;
}

function toKarachiParts(utcMs: number): { y: number; m: number; d: number } {
  const local = new Date(utcMs + KARACHI_OFFSET_MS);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
}

/** Karachi-local midnight (as a UTC Date) for the given Karachi calendar date. */
function karachiMidnightUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - KARACHI_OFFSET_MS);
}

function dateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Resolves a named window to concrete UTC [start, end) instants, anchored to
 * "now" interpreted in Asia/Karachi. CUSTOM requires explicit `customStart`/
 * `customEnd` (UTC instants) and is passed through unchanged.
 */
export function resolveTimeWindow(
  name: TimeWindowName,
  now: Date = new Date(),
  custom?: { start: Date; end: Date }
): ResolvedWindow {
  if (name === "CUSTOM") {
    if (!custom) throw new Error("resolveTimeWindow('CUSTOM', ...) requires a custom { start, end }.");
    return { name, start: custom.start, end: custom.end, label: `${custom.start.toISOString()}..${custom.end.toISOString()}` };
  }

  const { y, m, d } = toKarachiParts(now.getTime());
  const todayStart = karachiMidnightUtc(y, m, d);

  switch (name) {
    case "TODAY": {
      const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      return { name, start: todayStart, end, label: dateKey(y, m, d) };
    }
    case "YESTERDAY": {
      const start = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const yParts = toKarachiParts(start.getTime());
      return { name, start, end: todayStart, label: dateKey(yParts.y, yParts.m, yParts.d) };
    }
    case "THIS_WEEK": {
      // ISO week: Monday start. getUTCDay() on the Karachi-local midnight
      // instant gives the Karachi-local weekday (0=Sun..6=Sat).
      const weekday = new Date(todayStart.getTime() + KARACHI_OFFSET_MS).getUTCDay();
      const daysSinceMonday = (weekday + 6) % 7;
      const start = new Date(todayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
      const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      const sp = toKarachiParts(start.getTime());
      return { name, start, end, label: `week-of-${dateKey(sp.y, sp.m, sp.d)}` };
    }
    case "LAST_WEEK": {
      const thisWeek = resolveTimeWindow("THIS_WEEK", now);
      const start = new Date(thisWeek.start.getTime() - 7 * 24 * 60 * 60 * 1000);
      const end = thisWeek.start;
      const sp = toKarachiParts(start.getTime());
      return { name, start, end, label: `week-of-${dateKey(sp.y, sp.m, sp.d)}` };
    }
    case "THIS_MONTH": {
      const start = karachiMidnightUtc(y, m, 1);
      const end = karachiMidnightUtc(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1);
      return { name, start, end, label: `${y}-${String(m + 1).padStart(2, "0")}` };
    }
    case "LAST_MONTH": {
      const lm = m === 0 ? 11 : m - 1;
      const ly = m === 0 ? y - 1 : y;
      const start = karachiMidnightUtc(ly, lm, 1);
      const end = karachiMidnightUtc(y, m, 1);
      return { name, start, end, label: `${ly}-${String(lm + 1).padStart(2, "0")}` };
    }
    case "THIS_QUARTER": {
      const qStartMonth = Math.floor(m / 3) * 3;
      const start = karachiMidnightUtc(y, qStartMonth, 1);
      const endMonth = qStartMonth + 3;
      const end = endMonth >= 12 ? karachiMidnightUtc(y + 1, endMonth - 12, 1) : karachiMidnightUtc(y, endMonth, 1);
      return { name, start, end, label: `${y}-Q${Math.floor(qStartMonth / 3) + 1}` };
    }
    case "LAST_QUARTER": {
      const thisQ = resolveTimeWindow("THIS_QUARTER", now);
      const start = new Date(thisQ.start.getTime());
      // Step back exactly one quarter by re-deriving from the month before this quarter's start.
      const sp = toKarachiParts(thisQ.start.getTime() - 24 * 60 * 60 * 1000); // a day inside the previous quarter
      const qStartMonth = Math.floor(sp.m / 3) * 3;
      const qStart = karachiMidnightUtc(sp.y, qStartMonth, 1);
      return { name, start: qStart, end: start, label: `${sp.y}-Q${Math.floor(qStartMonth / 3) + 1}` };
    }
    default:
      throw new Error(`Unhandled time window: ${name}`);
  }
}
