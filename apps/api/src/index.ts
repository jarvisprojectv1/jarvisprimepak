// apps/api/src/index.ts - process entrypoint: registers built-in tools and
// agents, starts the scheduler, and binds the HTTP server.
import { createApp } from "./app";
import { appConfig } from "../../../config/env";
import { applyPendingMigrations } from "../../../database/migrate";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { registerExampleJobs } from "../../../scheduler";
import { log } from "../../../security/logger";
import { recoverUnfinishedTasks } from "../../../core/tasks";
import { registerDefaultSubscribers } from "../../../core/events";
import { seedExampleConditionRules } from "../../../core/conditions/rules";

async function main() {
  applyPendingMigrations();
  registerBuiltinTools();
  registerBuiltinAgents();
  registerDefaultSubscribers();

  try {
    await seedExampleConditionRules();
  } catch (err) {
    log("WARNING", "boot.condition_rule_seed_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const recovery = await recoverUnfinishedTasks();
    log("INFO", "boot.task_recovery", { ...recovery });
  } catch (err) {
    log("WARNING", "boot.task_recovery_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
