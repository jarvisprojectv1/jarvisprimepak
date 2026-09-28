import { Router } from "express";
import { toolRegistry } from "../../../../tools/registry";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const toolsRouter = Router();

toolsRouter.get("/", requireAuth, (_req, res) => {
  res.json(
    toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  );
});

toolsRouter.post("/:name/execute", requireAuth, requireAuthz("tool.execute"), async (req, res) => {
  const result = await toolRegistry.execute(req.params.name, req.body ?? {}, req.identity);
  res.json(result);
});
