import { Router } from "express";
import { listAgents, getAgent } from "../../../../agents/registry";

export const agentsRouter = Router();

agentsRouter.get("/", (_req, res) => {
  res.json(
    listAgents().map((a) => ({ name: a.name, objective: a.objective, status: a.status }))
  );
});

agentsRouter.post("/:name/run", async (req, res) => {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: `No agent named "${req.params.name}".` });
    return;
  }
  const result = await agent.run(req.body ?? {});
  res.json(result);
});
