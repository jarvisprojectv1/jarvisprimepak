import { Router } from "express";
import { getLiveness, getReadiness } from "../../../../core/health";

export const healthRouter = Router();

// Kept exactly as-is for backward compatibility (existing callers/tests hit
// GET /health and expect this shape) - unauthenticated, trivial, no I/O.
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "jarvis-api",
    phase: "1-foundation",
    timestamp: new Date().toISOString(),
  });
});

// Phase 12 (item 6): liveness - process is executing JS. No I/O. A process
// supervisor (systemd/Docker/pm2 - see deploy/) restarts the container if
// this ever fails to respond, since nothing but a hung/dead process makes it
// fail.
healthRouter.get("/live", (_req, res) => {
  res.json(getLiveness());
});

// Phase 12 (item 6): readiness - can this instance serve real traffic right
// now? 503 if the database is unreachable (nothing works without it); 200
// otherwise, with provider configuration state included for operator
// visibility (a load balancer should stop routing to an instance that fails
// this; a missing OPTIONAL provider must NOT cause that).
healthRouter.get("/ready", async (_req, res) => {
  const report = await getReadiness();
  res.status(report.ready ? 200 : 503).json(report);
});
