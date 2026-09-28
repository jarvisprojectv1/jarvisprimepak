import { Router } from "express";
import { orchestrator } from "../../../../core/orchestrator";

export const chatRouter = Router();

chatRouter.post("/", async (req, res) => {
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
