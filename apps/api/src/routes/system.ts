// apps/api/src/routes/system.ts - Global JARVIS State + emergency controls
// (Phase 2 / Step 3, part B; Phase 3 wires real identity in). All mutating
// routes write to the audit log via core/state, which itself is the only
// writer of the underlying `settings` rows - so there is exactly one way any
// of this state changes. The audit `actor` is now derived from the
// authenticated req.identity (set by requireAuth), never a client-supplied
// body field - the old `actorFrom(req.body)` self-reported string is gone.
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
import { identityToActorString, SYSTEM_IDENTITY } from "../../../../core/auth/identity";
import { requireAuth, requireRole } from "../middleware/auth";
import { getSystemHealth } from "../../../../core/health";
import { scheduler } from "../../../../scheduler";

export const systemRouter = Router();

function actorFrom(req: { identity?: { kind: string; id: string; label: string } }): string {
  return req.identity ? identityToActorString(req.identity as any) : identityToActorString(SYSTEM_IDENTITY);
}

// Reads: any authenticated identity.
systemRouter.get("/state", requireAuth, async (_req, res) => {
  res.json(await getSystemState());
});

systemRouter.get("/health", requireAuth, async (_req, res) => {
  res.json(await getSystemHealth());
});

// Mutations: OWNER only (Phase 3 requirement - only a human operator may
// change global system state, pause/resume agents, or disable/enable tools).
systemRouter.post("/pause", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Manual pause via API.";
  const state = await setSystemState("PAUSED", reason, actor);
  await writeAuditLog({ actor, action: "system.pause", meta: { reason } });
  res.json(state);
});

systemRouter.post("/resume", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const state = await recover(actor, reason);
  await writeAuditLog({ actor, action: "system.resume", meta: { reason } });
  res.json(state);
});

systemRouter.post("/emergency-stop", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Emergency stop requested via API.";
  await emergencyStop(actor, reason);
  await writeAuditLog({ actor, action: "system.emergency_stop", meta: { reason } });
  res.json(await getSystemState());
});

systemRouter.post("/agents/:name/pause", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  await pauseAgent(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.agent_pause", target: req.params.name });
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.post("/agents/:name/resume", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  await resumeAgent(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.agent_resume", target: req.params.name });
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.get("/agents/:name/paused", requireAuth, async (req, res) => {
  res.json({ agent: req.params.name, paused: await isAgentPaused(req.params.name) });
});

systemRouter.post("/tools/:name/disable", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  await disableTool(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.tool_disable", target: req.params.name });
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});

systemRouter.post("/tools/:name/enable", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  await enableTool(req.params.name, actor);
  await writeAuditLog({ actor, action: "system.tool_enable", target: req.params.name });
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});

systemRouter.get("/tools/:name/disabled", requireAuth, async (req, res) => {
  res.json({ tool: req.params.name, disabled: await isToolDisabled(req.params.name) });
});

// Live scheduler enable/disable - stops/starts the cron task without a
// process restart (Scheduler.setEnabled re-registers from the stored job
// definition, per scheduler/index.ts).
systemRouter.post("/scheduler/:name/disable", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  const ok = await scheduler.setEnabled(req.params.name, false);
  if (!ok) {
    res.status(404).json({ error: `No scheduled job named "${req.params.name}" is registered.` });
    return;
  }
  await writeAuditLog({ actor, action: "system.scheduler_disable", target: req.params.name });
  res.json({ job: req.params.name, running: scheduler.isRunning(req.params.name) });
});

systemRouter.post("/scheduler/:name/enable", requireAuth, requireRole("OWNER"), async (req, res) => {
  const actor = actorFrom(req);
  const ok = await scheduler.setEnabled(req.params.name, true);
  if (!ok) {
    res.status(404).json({ error: `No scheduled job named "${req.params.name}" is registered.` });
    return;
  }
  await writeAuditLog({ actor, action: "system.scheduler_enable", target: req.params.name });
  res.json({ job: req.params.name, running: scheduler.isRunning(req.params.name) });
});
