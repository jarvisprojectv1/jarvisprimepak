// apps/api/src/routes/skills.ts - Skill Discovery/Registry observability +
// the OWNER-only activation route (Phase 6, items 11-14/17).
import { Router } from "express";
import {
  createCandidate,
  promoteToCandidate,
  analyzeCandidate,
  runTestingStub,
  verifyCandidate,
  markActivatable,
  activateSkill,
  rejectCandidate,
  disableSkill,
  getCandidate,
  listCandidates,
} from "../../../../core/skills/registry";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const skillsRouter = Router();

skillsRouter.get("/", requireAuth, requireAuthz("skills.read"), async (_req, res) => {
  res.json({ candidates: await listCandidates() });
});

skillsRouter.get("/:id", requireAuth, requireAuthz("skills.read"), async (req, res) => {
  const candidate = await getCandidate(req.params.id);
  if (!candidate) {
    res.status(404).json({ error: "Skill candidate not found." });
    return;
  }
  res.json({ candidate });
});

skillsRouter.post("/", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  const { name, description, source, capabilities, requiredPermissions, dependencies, riskLevel } = req.body ?? {};
  if (typeof name !== "string" || typeof source !== "string") {
    res.status(400).json({ error: "name and source are required strings." });
    return;
  }
  const candidate = await createCandidate(
    { name, description, source, capabilities, requiredPermissions, dependencies, riskLevel },
    req.identity!
  );
  res.status(201).json({ candidate });
});

skillsRouter.post("/:id/promote", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  try {
    res.json({ candidate: await promoteToCandidate(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/analyze", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  const sourceText = typeof req.body?.sourceText === "string" ? req.body.sourceText : "";
  try {
    const result = await analyzeCandidate(req.params.id, sourceText, req.identity!);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/test", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  try {
    res.json({ candidate: await runTestingStub(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/verify", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  try {
    res.json({ candidate: await verifyCandidate(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/mark-activatable", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  try {
    res.json({ candidate: await markActivatable(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// OWNER-only: ACTIVATABLE -> ACTIVE. Never automatic - see
// core/skills/registry.ts's activateSkill() for the double-enforced (route +
// function) OWNER-only check and the explicit "status tracking only" note.
skillsRouter.post("/:id/activate", requireAuth, requireAuthz("skills.activate"), async (req, res) => {
  try {
    res.json({ candidate: await activateSkill(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/reject", requireAuth, requireAuthz("skills.write"), async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Rejected via API.";
  try {
    res.json({ candidate: await rejectCandidate(req.params.id, reason, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

skillsRouter.post("/:id/disable", requireAuth, requireAuthz("skills.activate"), async (req, res) => {
  try {
    res.json({ candidate: await disableSkill(req.params.id, req.identity!) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
