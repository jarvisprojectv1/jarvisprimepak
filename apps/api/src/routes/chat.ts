import { Router } from "express";
import { orchestrator } from "../../../../core/orchestrator";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const chatRouter = Router();

// /chat requires authentication, restricted to OWNER (chat.use is not
// granted to SYSTEM/AGENT/SERVICE in core/authz) - the safer default for a
// personal system like this, per docs/PHASE3_IDENTITY_EVENTS.md.
chatRouter.post("/", requireAuth, requireAuthz("chat.use"), async (req, res) => {
  const { message, toolCall, conversationId } = req.body ?? {};

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Body must include a 'message' string." });
    return;
  }

  const response = await orchestrator.handleChat({ message, toolCall, conversationId });

  if (response.configurationRequired) {
    res.status(200).json({ ...response, ok: false });
    return;
  }

  res.json({ ...response, ok: true });
});
