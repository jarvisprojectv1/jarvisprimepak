// Structured logging (spec section 36). Every log call goes through pino for
// console output; ACTION/AGENT/TOOL/SECURITY-level entries are additionally
// persisted to the `system_logs` table so they survive process restarts and
// are queryable from the dashboard (Phase 2+ UI).
import pino from "pino";
import { appConfig } from "../config/env";
import { redact } from "./redact";
import { prisma } from "../database/client";
// Phase 12 (item 7): request/correlation id, when this log call happens
// inside an HTTP request (AsyncLocalStorage - see security/context.ts and
// its Express middleware, apps/api/src/middleware/requestContext.ts).
// Outside a request (scheduler, worker, tests) this is simply undefined and
// omitted - never a fabricated id.
import { getRequestId } from "./context";

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
  const requestId = getRequestId();
  const logPayload = requestId ? { category, requestId, ...safeMeta } : { category, ...safeMeta };
  pinoLogger[levelFor(category)](logPayload, message);

  if (PERSISTED_CATEGORIES.has(category)) {
    // Fire-and-forget: logging must never block or crash the caller. The
    // request id (if any) rides inside the existing `meta` JSON blob rather
    // than a new column, so this stays a purely additive change to
    // SystemLog's stored shape.
    const persistedMeta = requestId ? { ...safeMeta, requestId } : safeMeta;
    prisma.systemLog
      .create({
        data: {
          category,
          message,
          meta: persistedMeta ? JSON.stringify(persistedMeta) : null,
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
