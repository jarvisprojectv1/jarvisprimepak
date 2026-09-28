// apps/api/src/index.ts - process entrypoint: registers built-in tools and
// agents, starts the scheduler, and binds the HTTP server.
import { createApp } from "./app";
import { appConfig } from "../../../config/env";
import { applyPendingMigrations } from "../../../database/migrate";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { registerExampleJobs } from "../../../scheduler";
import { log } from "../../../security/logger";

async function main() {
  applyPendingMigrations();
  registerBuiltinTools();
  registerBuiltinAgents();

  try {
    await registerExampleJobs();
  } catch (err) {
    log("WARNING", "scheduler.init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const app = createApp();
  app.listen(appConfig.port, () => {
    log("INFO", `JARVIS API listening on port ${appConfig.port}`, {
      env: appConfig.nodeEnv,
    });
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting JARVIS API:", err);
  process.exit(1);
});
