import { Router } from "express";
import { Memory, MEMORY_NAMESPACES } from "../../../../core/memory";

export const memoryRouter = Router();

memoryRouter.get("/", async (req, res) => {
  const { namespace, query, limit } = req.query;
  const results = await Memory.search({
    namespace: typeof namespace === "string" ? (namespace as any) : undefined,
    query: typeof query === "string" ? query : undefined,
    limit: limit ? Number(limit) : undefined,
  });
  res.json(results);
});

memoryRouter.post("/", async (req, res) => {
  const { namespace, key, value, importance } = req.body ?? {};
  if (!namespace || !MEMORY_NAMESPACES.includes(namespace)) {
    res.status(400).json({ error: `'namespace' must be one of: ${MEMORY_NAMESPACES.join(", ")}` });
    return;
  }
  if (!key || typeof key !== "string") {
    res.status(400).json({ error: "Body must include a 'key' string." });
    return;
  }
  const entry = await Memory.create({ namespace, key, value, importance });
  res.status(201).json(entry);
});

memoryRouter.get("/:namespace/:key/history", async (req, res) => {
  const { namespace, key } = req.params;
  if (!MEMORY_NAMESPACES.includes(namespace as any)) {
    res.status(400).json({ error: `'namespace' must be one of: ${MEMORY_NAMESPACES.join(", ")}` });
    return;
  }
  res.json(await Memory.history(namespace as any, key));
});
