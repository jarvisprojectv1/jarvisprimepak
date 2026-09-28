// core/notifications/dispatcher.ts - pluggable delivery channels for
// notifications. Exactly ONE channel is real in this phase (DashboardChannel,
// which persists via the repository so the web dashboard can poll/display
// it). The rest are honest NOT_IMPLEMENTED stubs so the interface exists
// without pretending delivery works - never call these and report success.
import { log } from "../../security/logger";
import { notificationRepository } from "./repository";
import type { CreateNotificationInput, NotificationRecord } from "./types";

export interface NotificationChannel {
  name: string;
  /** Delivers a notification that has ALREADY been persisted (dashboard) or is about to be attempted (other channels). */
  dispatch(notification: NotificationRecord): Promise<{ status: "OK" | "NOT_IMPLEMENTED"; message: string }>;
}

/** The one real channel: persists via the repository so the dashboard can poll GET /notifications. */
export class DashboardChannel implements NotificationChannel {
  name = "dashboard";
  async dispatch(notification: NotificationRecord) {
    // Already persisted by NotificationService.create() before dispatch() is
    // called - this channel's job is simply to confirm it's queryable.
    return { status: "OK" as const, message: `Notification ${notification.id} available on dashboard.` };
  }
}

function notImplementedChannel(name: string): NotificationChannel {
  return {
    name,
    async dispatch() {
      log("WARNING", `notifications.channel_not_implemented:${name}`, {});
      return { status: "NOT_IMPLEMENTED" as const, message: `Channel "${name}" is not implemented yet.` };
    },
  };
}

// Stubs for future channels - interfaces only, never fake delivery.
export const DesktopChannel = notImplementedChannel("desktop");
export const EmailChannel = notImplementedChannel("email");
export const WhatsAppChannel = notImplementedChannel("whatsapp");
export const SmsChannel = notImplementedChannel("sms");
export const PhoneChannel = notImplementedChannel("phone");
export const PushChannel = notImplementedChannel("push");

export class NotificationDispatcher {
  private channels: NotificationChannel[];

  constructor(channels: NotificationChannel[] = [new DashboardChannel()]) {
    this.channels = channels;
  }

  async dispatch(notification: NotificationRecord): Promise<void> {
    for (const channel of this.channels) {
      try {
        const result = await channel.dispatch(notification);
        log("INFO", `notifications.dispatched:${channel.name}`, {
          notificationId: notification.id,
          status: result.status,
        });
      } catch (err) {
        log("ERROR", `notifications.dispatch_failed:${channel.name}`, {
          notificationId: notification.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export const defaultDispatcher = new NotificationDispatcher();

export type { CreateNotificationInput };
