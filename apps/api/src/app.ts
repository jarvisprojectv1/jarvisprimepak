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
import { brainRouter } from "./routes/brain";
import { workerRouter } from "./routes/worker";
import { researchRouter } from "./routes/research";
import { skillsRouter } from "./routes/skills";
import { crmRouter } from "./routes/crm";
import { approvalsRouter } from "./routes/approvals";
import { webhooksRouter } from "./routes/webhooks";
import { log } from "../../../security/logger";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  // Phase 8 (item 5): the raw request body bytes are captured onto
  // `req.rawBody` here, alongside JSON parsing, SPECIFICALLY so
  // apps/api/src/routes/webhooks.ts can verify the WhatsApp Cloud API's
  // X-Hub-Signature-256 HMAC against the EXACT bytes Meta signed - a
  // reserialized `JSON.stringify(req.body)` is not guaranteed byte-identical
  // to what was signed (key order, whitespace), so verifying against
  // anything but the raw bytes would be an unreliable check dressed up as a
  // real one.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  // Phase 9 (item 5): Twilio's voice webhook POSTs
  // application/x-www-form-urlencoded (not JSON) - the SAME rawBody-capture
  // pattern as the json() parser above, generalized to this content-type, so
  // apps/api/src/routes/webhooks.ts's POST /webhooks/voice can verify
  // Twilio's X-Twilio-Signature against the exact parsed param set (Twilio's
  // algorithm signs the parsed key/value pairs, not raw bytes - see
  // core/voice/webhook.ts - but capturing rawBody here too costs nothing and
  // keeps this middleware stack uniform/auditable for any future
  // byte-exact-signature provider).
  app.use(
    express.urlencoded({
      extended: false,
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );

  // Unauthenticated: /health (liveness), /auth/login (you can't log in if
  // login itself requires a session), and /webhooks (authenticated by
  // provider signature instead of a session - see webhooks.ts). Everything
  // else requires authentication (see apps/api/src/middleware/auth.ts),
  // applied per-route.
  app.use("/health", healthRouter);
  app.use("/webhooks", webhooksRouter);
  app.use("/auth", authRouter);
  app.use("/chat", chatRouter);
  app.use("/tools", toolsRouter);
  app.use("/agents", agentsRouter);
  app.use("/tasks", tasksRouter);
  app.use("/memory", memoryRouter);
  app.use("/system", systemRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/brain", brainRouter);
  app.use("/worker", workerRouter);
  app.use("/research", researchRouter);
  app.use("/skills", skillsRouter);
  app.use("/crm", crmRouter);
  app.use("/approvals", approvalsRouter);

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
