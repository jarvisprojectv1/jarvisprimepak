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

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/health", healthRouter);
  app.use("/chat", chatRouter);
  app.use("/tools", toolsRouter);
  app.use("/agents", agentsRouter);
  app.use("/tasks", tasksRouter);
  app.use("/memory", memoryRouter);
  app.use("/system", systemRouter);

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  return app;
}
