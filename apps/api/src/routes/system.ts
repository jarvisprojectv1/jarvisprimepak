// apps/api/src/routes/system.ts - Global JARVIS State + emergency controls
// (Phase 2 / Step 3, part B). All mutating routes write to the audit log via
// core/state, which itself is the only writer of the underlying `settings`
// rows - so there is exactly one way any of this state changes.
import { Router } from "express";
import {
  getSystemState,
  setSystemState,
  pauseAgent,
  resumeAgent,
  isAgentPaused,
  disableTool,
  enableTool,
  isToolDisabled,
  emergencyStop,
  recover,
} from "../../../../core/state";
import { writeAuditLog } from "../../../../security/audit";

export const systemRouter = Router();

function actorFrom(req: { body?: unknown }): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return typeof body.actor === "string" && body.actor.trim() ? body.actor : "api";
}

systemRouter.get("/state", async (_req, res) => {
  res.json(await getSystemState());
});

systemRouter.post("/pause", async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Manual pause via API.";
  const state = await setSystemState("PAUSED", reason, actor);
  await writeAuditLog({ actor, action: "system.pause", meta: { reason } });
  res.json(state);
});

systemRouter.post("/resume", async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const state = await recover(actor, reason);
  await writeAuditLog({ actor, action: "system.resume", meta: { reason } });
  res.json(state);
});

systemRouter.post("/emergency-stop", async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Emergency stop requested via API.";
  await emergencyStop(actor, reason);
  await writeAuditLog({ actor, action: "system.emergency_stop", meta: { reason } });
  res.json(await getSystemState());
});

systemRouter.post("/agents/:name/pause", async (req, res) => {
  const actor = actorFrom(req);
  await pauseAgent(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.agent_pause", target: req.params.name });
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.post("/agents/:name/resume", async (req, res) => {
  const actor = actorFrom(req);
  await resumeAgent(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.agent_resume", target: req.params.name });
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.get("/agents/:name/paused", async (req, res) => {
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.post("/tools/:name/disable", async (req, res) => {
  const actor = actorFrom(req);
  await disableTool(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.tool_disable", target: req.params.name });
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});

systemRouter.post("/tools/:name/enable", async (req, res) => {
  const actor = actorFrom(req);
  await enableTool(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.tool_enable", target: req.params.name });
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});

systemRouter.get("/tools/:name/disabled", async (req, res) => {
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});
