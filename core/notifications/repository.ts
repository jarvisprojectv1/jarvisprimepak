// core/notifications/repository.ts - Prisma CRUD for the `notifications` table.
import { prisma } from "../../database/client";
import type { CreateNotificationInput, NotificationRecord, NotificationType } from "./types";

function toRecord(row: {
  id: string;
  userId: string | null;
  title: string;
  body: string | null;
  type: string;
  read: boolean;
  createdAt: Date;
}): NotificationRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    body: row.body,
    type: row.type as NotificationType,
    read: row.read,
    createdAt: row.createdAt,
  };
}

export class NotificationRepository {
  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const row = await prisma.notification.create({
      data: {
        userId: input.userId ?? undefined,
        title: input.title,
        body: input.body,
        type: input.type ?? "INFO",
      },
    });
    return toRecord(row);
  }

  async markRead(id: string): Promise<NotificationRecord> {
    const row = await prisma.notification.update({ where: { id }, data: { read: true } });
    return toRecord(row);
  }

  async list(filter: { userId?: string; type?: NotificationType; unreadOnly?: boolean } = {}): Promise<NotificationRecord[]> {
    const rows = await prisma.notification.findMany({
      where: {
        userId: filter.userId,
        type: filter.type,
        read: filter.unreadOnly ? false : undefined,
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async get(id: string): Promise<NotificationRecord | null> {
    const row = await prisma.notification.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }
}

export const notificationRepository = new NotificationRepository();
