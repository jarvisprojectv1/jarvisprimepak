// Audit log writer - a separate, append-only trail of "who did what" distinct
// from system_logs (which is operational/debug logging). Every write is
// redacted first.
import { prisma } from "../database/client";
import { redact } from "./redact";
import { log } from "./logger";

export interface AuditEntry {
  actor: string; // user id, "system", or an agent name
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const safeMeta = entry.meta ? redact(entry.meta) : undefined;
  try {
    await prisma.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        meta: safeMeta ? JSON.stringify(safeMeta) : null,
      },
    });
  } catch (err) {
    log("SECURITY", "failed to write audit log entry", { error: String(err) });
  }
}
