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
import { registerWhatsAppSubscriber } from "../../../core/whatsapp/subscriber";
import { registerVoiceSubscriber } from "../../../core/voice/subscriber";
import { seedExampleConditionRules } from "../../../core/conditions/rules";
import { worker } from "../../../core/worker";
import { seedResearchTopics } from "../../../core/research/topics";
import { webEventSource } from "../../../core/events/webEventSource";
import { seedDefaultProductCategories } from "../../../core/crm/businessConfig";

async function main() {
  applyPendingMigrations();
  registerBuiltinTools();
  registerBuiltinAgents();
  registerDefaultSubscribers();
  registerWhatsAppSubscriber();
  registerVoiceSubscriber();

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

  try {
    await seedResearchTopics();
    await webEventSource.start();
  } catch (err) {
    log("WARNING", "web_event_source.init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await seedDefaultProductCategories();
  } catch (err) {
    log("WARNING", "boot.product_category_seed_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 5: the Autonomous Worker - an in-process interval that keeps
  // running for as long as THIS process is alive (not a separate OS-level
  // daemon; see docs/PHASE5_AUTONOMOUS_WORKER.md). Started once, right after
  // crash recovery, alongside the rest of boot.
  try {
    await worker.start();
    // Watchdog runs on its own, slower interval - separate from the worker's
    // own tick/heartbeat timers, since a dead tick timer can't watch itself.
    setInterval(() => {
      worker.watchdogPass().catch((err) =>
        log("ERROR", "worker.watchdog_failed", { error: err instanceof Error ? err.message : String(err) })
      );
    }, 15_000);
  } catch (err) {
    log("WARNING", "worker.start_failed", {
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
