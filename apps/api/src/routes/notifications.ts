// apps/api/src/routes/notifications.ts - authenticated notification routes.
import { Router } from "express";
import { notificationService } from "../../../../core/notifications";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, requireAuthz("notification.read"), async (req, res) => {
  const { type, unreadOnly } = req.query;
  const list = await notificationService.list({
    type: typeof type === "string" ? (type as any) : undefined,
    unreadOnly: unreadOnly === "true",
  });
  res.json(list);
});

notificationsRouter.patch("/:id/read", requireAuth, requireAuthz("notification.write"), async (req, res) => {
  const updated = await notificationService.markRead(req.params.id);
  res.json(updated);
});
