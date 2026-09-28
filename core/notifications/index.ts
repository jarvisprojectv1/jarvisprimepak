// core/notifications - Notification Service (Phase 3 / Identity & Events).
//
// Split: NotificationRepository (Prisma CRUD) -> NotificationService
// (business logic) -> NotificationDispatcher (pluggable delivery channels).
// This replaces core/enforcement's old ad-hoc, local createNotification()
// helper - NOTIFY-level policy outcomes now call NotificationService.create()
// with a real `type`.
import { notificationRepository } from "./repository";
import { defaultDispatcher } from "./dispatcher";
import type { CreateNotificationInput, NotificationRecord, NotificationType } from "./types";
import { log } from "../../security/logger";

export class NotificationService {
  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const record = await notificationRepository.create(input);
    await defaultDispatcher.dispatch(record);
    log("INFO", "notifications.created", { id: record.id, type: record.type, title: record.title });
    return record;
  }

  async markRead(id: string): Promise<NotificationRecord> {
    return notificationRepository.markRead(id);
  }

  async list(filter?: { userId?: string; type?: NotificationType; unreadOnly?: boolean }): Promise<NotificationRecord[]> {
    return notificationRepository.list(filter);
  }

  async get(id: string): Promise<NotificationRecord | null> {
    return notificationRepository.get(id);
  }
}

export const notificationService = new NotificationService();

export {
  NotificationDispatcher,
  DashboardChannel,
  DesktopChannel,
  EmailChannel,
  WhatsAppChannel,
  SmsChannel,
  PhoneChannel,
  PushChannel,
} from "./dispatcher";
export type { NotificationChannel } from "./dispatcher";
export { NotificationRepository, notificationRepository } from "./repository";
export type { CreateNotificationInput, NotificationRecord, NotificationType } from "./types";
