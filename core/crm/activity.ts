// core/crm/activity.ts - CRM activity feed (Phase 7, item 19). Reuses the
// existing Communication table (extended with `activityType`/
// `relatedEntityId`/`metadata`) rather than a parallel Activity table - a
// Communication row already IS "a meaningful interaction with a contact",
// which covers every activity type this phase needs.
import { prisma } from "../../database/client";
import type { ActivityType } from "./pipeline";

export interface RecordActivityInput {
  contactId?: string | null;
  channel?: string;
  direction?: "inbound" | "outbound";
  activityType: ActivityType;
  relatedEntityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function recordActivity(input: RecordActivityInput) {
  return prisma.communication.create({
    data: {
      contactId: input.contactId ?? null,
      channel: input.channel ?? "system",
      direction: input.direction ?? "outbound",
      activityType: input.activityType,
      relatedEntityId: input.relatedEntityId ?? null,
      summary: input.summary,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  });
}

export async function listActivityForEntity(relatedEntityId: string) {
  return prisma.communication.findMany({ where: { relatedEntityId }, orderBy: { createdAt: "desc" } });
}
