import { Router } from "express";
import { toolRegistry } from "../../../../tools/registry";

export const toolsRouter = Router();

toolsRouter.get("/", (_req, res) => {
  res.json(
    toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  );
});

toolsRouter.post("/:name/execute", async (req, res) => {
  const result = await toolRegistry.execute(req.params.name, req.body ?? {});
  res.json(result);
});
