// Structured logging (spec section 36). Every log call goes through pino for
// console output; ACTION/AGENT/TOOL/SECURITY-level entries are additionally
// persisted to the `system_logs` table so they survive process restarts and
// are queryable from the dashboard (Phase 2+ UI).
import pino from "pino";
import { appConfig } from "../config/env";
import { redact } from "./redact";
import { prisma } from "../database/client";

export type LogCategory =
  | "INFO"
  | "WARNING"
  | "ERROR"
  | "CRITICAL"
  | "ACTION"
  | "AGENT"
  | "TOOL"
  | "SECURITY"
  | "BUSINESS"
  | "VOICE";

// Categories that represent something JARVIS *did* (as opposed to plain
// informational chatter) are persisted for audit/inspection purposes.
const PERSISTED_CATEGORIES = new Set<LogCategory>([
  "ACTION",
  "AGENT",
  "TOOL",
  "SECURITY",
  "CRITICAL",
]);

const pinoLogger = pino({
  level: appConfig.logLevel,
  transport:
    appConfig.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

function levelFor(category: LogCategory): pino.Level {
  switch (category) {
    case "ERROR":
    case "CRITICAL":
      return "error";
    case "WARNING":
      return "warn";
    default:
      return "info";
  }
}

/**
 * Typed structured logger. `meta` is redacted before it is printed or
 * persisted so secrets never end up in logs or the database.
 */
export function log(
  category: LogCategory,
  message: string,
  meta?: Record<string, unknown>
): void {
  const safeMeta = meta ? redact(meta) : undefined;
  pinoLogger[levelFor(category)]({ category, ...safeMeta }, message);

  if (PERSISTED_CATEGORIES.has(category)) {
    // Fire-and-forget: logging must never block or crash the caller.
    prisma.systemLog
      .create({
        data: {
          category,
          message,
          meta: safeMeta ? JSON.stringify(safeMeta) : null,
        },
      })
      .catch((err) => {
        pinoLogger.error(
          { err: String(err) },
          "failed to persist system log entry"
        );
      });
  }
}

export { pinoLogger };
