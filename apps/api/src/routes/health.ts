import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "jarvis-api",
    phase: "1-foundation",
    timestamp: new Date().toISOString(),
  });
});
