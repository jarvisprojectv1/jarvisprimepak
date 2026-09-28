// apps/api/src/app.ts - builds the Express app (separated from index.ts so
// tests can import it without binding a real port).
import express, { type Express } from "express";
import cors from "cors";
import { healthRouter } from "./routes/health";
import { chatRouter } from "./routes/chat";
import { toolsRouter } from "./routes/tools";
import { agentsRouter } from "./routes/agents";
import { tasksRouter } from "./routes/tasks";
import { memoryRouter } from "./routes/memory";
import { systemRouter } from "./routes/system";
import { authRouter } from "./routes/auth";
import { notificationsRouter } from "./routes/notifications";
import { log } from "../../../security/logger";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Unauthenticated: /health (liveness) and /auth/login (you can't log in if
  // login itself requires a session). Everything else requires
  // authentication (see apps/api/src/middleware/auth.ts), applied per-route.
  app.use("/health", healthRouter);
  app.use("/auth", authRouter);
  app.use("/chat", chatRouter);
  app.use("/tools", toolsRouter);
  app.use("/agents", agentsRouter);
  app.use("/tasks", tasksRouter);
  app.use("/memory", memoryRouter);
  app.use("/system", systemRouter);
  app.use("/notifications", notificationsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // Generic error handler: never leak a stack trace, error object internals,
  // or any secret-shaped field to the client. Full detail goes to the
  // (redacted) system log only.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : "Internal server error";
    log("ERROR", "api.unhandled_error", { error: message });
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
