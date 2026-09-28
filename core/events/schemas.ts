// core/events/schemas.ts - typed event categories + basic shape validation
// (Phase 3 / Identity & Events). Categories are a small, fixed set; each
// implemented category has a minimal real payload shape checked before the
// event is persisted/routed. EMAIL/WEB/MARKET/VOICE/CALENDAR are RESERVED
// category names only - valid strings for forward compatibility, but no
// event source for them exists yet (do not build one; see the non-negotiables
// in docs/PHASE3_IDENTITY_EVENTS.md).
export type EventCategory =
  | "SYSTEM"
  | "SCHEDULE"
  | "USER"
  | "TASK"
  | "AGENT"
  | "CRM"
  | "NOTIFICATION"
  // Reserved, forward-compatible only - no source implemented in this phase.
  | "EMAIL"
  | "WEB"
  | "MARKET"
  | "VOICE"
  | "CALENDAR";

export const ALL_EVENT_CATEGORIES: EventCategory[] = [
  "SYSTEM",
  "SCHEDULE",
  "USER",
  "TASK",
  "AGENT",
  "CRM",
  "NOTIFICATION",
  "EMAIL",
  "WEB",
  "MARKET",
  "VOICE",
  "CALENDAR",
];

// Categories with an implemented, validated payload shape in this phase.
// EMAIL/MARKET/VOICE/CALENDAR remain reserved names with no schema (and
// therefore no publishable event) yet. WEB is now implemented for real
// (Phase 6, item 7 - core/events/webEventSource.ts), a bounded, configured
// polling source - never unrestricted crawling.
const IMPLEMENTED_CATEGORIES = new Set<EventCategory>([
  "SYSTEM",
  "SCHEDULE",
  "USER",
  "TASK",
  "AGENT",
  "CRM",
  "NOTIFICATION",
  "WEB",
]);

/**
 * Every published event's `type` is "CATEGORY.rest.of.name", e.g.
 * "SCHEDULE.fired" or "CRM.lead.created". This lets validation and routing
 * work off the category prefix without a giant literal union of every exact
 * type string.
 */
export function categoryOf(eventType: string): EventCategory | undefined {
  const prefix = eventType.split(".")[0];
  return (ALL_EVENT_CATEGORIES as string[]).includes(prefix) ? (prefix as EventCategory) : undefined;
}

export interface ShapeCheckResult {
  valid: boolean;
  reason?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Minimal, real per-category payload shape checks. Deliberately loose (this
// is not a full JSON-schema system) - just enough to reject obviously
// malformed or wrong-category payloads before they're persisted/routed.
const SHAPE_CHECKS: Record<string, (payload: unknown) => ShapeCheckResult> = {
  SYSTEM: (p) => (isPlainObject(p) ? { valid: true } : { valid: false, reason: "SYSTEM payload must be an object." }),
  SCHEDULE: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "SCHEDULE payload must be an object." };
    if (typeof p.jobName !== "string") return { valid: false, reason: "SCHEDULE payload requires a string 'jobName'." };
    return { valid: true };
  },
  USER: (p) => (isPlainObject(p) ? { valid: true } : { valid: false, reason: "USER payload must be an object." }),
  TASK: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "TASK payload must be an object." };
    if (typeof p.taskId !== "string") return { valid: false, reason: "TASK payload requires a string 'taskId'." };
    return { valid: true };
  },
  AGENT: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "AGENT payload must be an object." };
    if (typeof p.agentName !== "string") return { valid: false, reason: "AGENT payload requires a string 'agentName'." };
    return { valid: true };
  },
  CRM: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "CRM payload must be an object." };
    if (typeof p.leadId !== "string" && typeof p.status !== "string") {
      return { valid: false, reason: "CRM payload requires at least a 'leadId' or 'status' field." };
    }
    return { valid: true };
  },
  NOTIFICATION: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "NOTIFICATION payload must be an object." };
    if (typeof p.title !== "string") return { valid: false, reason: "NOTIFICATION payload requires a string 'title'." };
    return { valid: true };
  },
  WEB: (p) => {
    if (!isPlainObject(p)) return { valid: false, reason: "WEB payload must be an object." };
    if (typeof p.topicName !== "string") return { valid: false, reason: "WEB payload requires a string 'topicName'." };
    return { valid: true };
  },
};

/**
 * Validates an event before it's persisted: the category prefix must be one
 * of the known categories, the category must be an IMPLEMENTED one (not a
 * reserved forward-compat name with no real source yet), and the payload
 * must pass that category's minimal shape check.
 */
export function validateEvent(eventType: string, payload: unknown): ShapeCheckResult {
  const category = categoryOf(eventType);
  if (!category) {
    return { valid: false, reason: `Unknown event category for type "${eventType}".` };
  }
  if (!IMPLEMENTED_CATEGORIES.has(category)) {
    return {
      valid: false,
      reason: `Event category "${category}" is reserved for a future phase; no event source publishes it yet.`,
    };
  }
  const check = SHAPE_CHECKS[category];
  return check ? check(payload) : { valid: true };
}
