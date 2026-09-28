// core/notifications/types.ts - shared notification types.
export type NotificationType = "INFO" | "WARNING" | "ACTION_REQUIRED" | "ERROR" | "CRITICAL";

export interface NotificationRecord {
  id: string;
  userId: string | null;
  title: string;
  body: string | null;
  type: NotificationType;
  read: boolean;
  createdAt: Date;
}

export interface CreateNotificationInput {
  userId?: string | null;
  title: string;
  body?: string;
  type?: NotificationType;
}
