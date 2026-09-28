// core/crm/pipeline.ts - Lead.status's extended allowed values (Phase 7,
// item 6). SQLite has no enums; validated here in application code, same
// convention as Task.status/etc (see database/schema.prisma's comment on
// Lead.status).
export const LEAD_STATUSES = [
  "NEW",
  "RESEARCHING",
  "QUALIFIED",
  "CONTACTED",
  "RESPONDED",
  "SAMPLE_REQUESTED",
  "QUOTING",
  "NEGOTIATION",
  "WON",
  "LOST",
  "NURTURE",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isValidLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export const QUOTE_STATUSES = ["DRAFT", "REQUIRES_APPROVAL", "SENT", "ACCEPTED", "REJECTED"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export function isValidQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

export const ACTIVITY_TYPES = [
  "NOTE",
  "EMAIL_SENT",
  "EMAIL_RECEIVED",
  "CALL_LOGGED",
  "STATUS_CHANGE",
  "QUOTE_PREPARED",
  "SAMPLE_REQUESTED",
  "FOLLOW_UP",
  "TASK_LINKED",
  // Phase 8 (WhatsApp): the same activity-feed shape as EMAIL_SENT/
  // EMAIL_RECEIVED, recorded through the SAME recordActivity() every other
  // channel uses (core/crm/activity.ts) - no parallel activity system.
  "WHATSAPP_SENT",
  "WHATSAPP_RECEIVED",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
