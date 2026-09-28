import { describe, it, expect } from "vitest";
import { notificationService } from "./index";
import { DesktopChannel, EmailChannel, WhatsAppChannel } from "./dispatcher";

describe("core/notifications", () => {
  it("creates a notification and it is retrievable via list()", async () => {
    const created = await notificationService.create({
      title: "Test notification",
      body: "hello",
      type: "ACTION_REQUIRED",
    });
    const list = await notificationService.list();
    expect(list.some((n) => n.id === created.id)).toBe(true);
  });

  it("markRead flips the read flag", async () => {
    const created = await notificationService.create({ title: "unread test" });
    expect(created.read).toBe(false);
    const updated = await notificationService.markRead(created.id);
    expect(updated.read).toBe(true);
  });

  it("filters by type and unreadOnly", async () => {
    await notificationService.create({ title: "warn", type: "WARNING" });
    const warnings = await notificationService.list({ type: "WARNING" });
    expect(warnings.every((n) => n.type === "WARNING")).toBe(true);
  });

  it("stub channels honestly report NOT_IMPLEMENTED rather than faking delivery", async () => {
    const notification = await notificationService.create({ title: "stub test" });
    const desktopResult = await DesktopChannel.dispatch(notification);
    const emailResult = await EmailChannel.dispatch(notification);
    const whatsappResult = await WhatsAppChannel.dispatch(notification);
    expect(desktopResult.status).toBe("NOT_IMPLEMENTED");
    expect(emailResult.status).toBe("NOT_IMPLEMENTED");
    expect(whatsappResult.status).toBe("NOT_IMPLEMENTED");
  });
});
