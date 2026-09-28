import { Router } from "express";
import { brain } from "../../../../core/brain";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const chatRouter = Router();

// /chat requires authentication, restricted to OWNER (chat.use is not
// granted to SYSTEM/AGENT/SERVICE in core/authz) - the safer default for a
// personal system like this, per docs/PHASE3_IDENTITY_EVENTS.md.
//
// Phase 4: /chat is now the Brain's entrypoint (core/brain), not the older
// core/orchestrator directly - the Brain is a strict superset (context
// retrieval, structured planning, tool/agent execution through the same
// enforcement gate, memory persistence) and a plain conversational message
// with no action needed produces the exact same reply shape as before (see
// docs/PHASE4_BRAIN_MEMORY.md "Why /chat routes through the Brain").
chatRouter.post("/", requireAuth, requireAuthz("chat.use"), async (req, res) => {
  const { message, toolCall, conversationId } = req.body ?? {};

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Body must include a 'message' string." });
    return;
  }

  const result = await brain.handle({ message, toolCall, conversationId }, req.identity);

  const ok = !result.configurationRequired && result.status !== "FAILED" && result.status !== "BLOCKED";

  res.status(200).json({
    ok,
    reply: result.reply,
    configurationRequired: result.configurationRequired ?? false,
    model: result.model,
    status: result.status,
    plan: result.plan,
    steps: result.steps,
    taskId: result.taskId,
  });
});
