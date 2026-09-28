// core/events - minimal in-process Event Bus (Phase 2 / Step 3, part F).
//
// Foundation for EVENT -> DECISION -> TASK -> AGENT -> TOOL -> RESULT -> MEMORY.
// Every published event is persisted to the existing `events` table (so the
// history survives restarts and is queryable), and any subscribed handlers
// are invoked via a simple async queue - no external message broker, no
// distributed delivery guarantees. Handler failures are logged and never
// thrown back at the publisher.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { redact } from "../../security/redact";

export interface EventInput {
  type: string;
  payload?: unknown;
  source?: string;
}

export interface PersistedEvent {
  id: string;
  type: string;
  payload: unknown;
  source: string | null;
  createdAt: Date;
}

export type EventHandler = (event: PersistedEvent) => void | Promise<void>;

const handlers = new Map<string, EventHandler[]>();

/** Registers `handler` to run whenever an event of `eventType` is published. Returns an unsubscribe function. */
export function subscribe(eventType: string, handler: EventHandler): () => void {
  const list = handlers.get(eventType) ?? [];
  list.push(handler);
  handlers.set(eventType, list);
  return () => {
    const current = handlers.get(eventType);
    if (!current) return;
    handlers.set(
      eventType,
      current.filter((h) => h !== handler)
    );
  };
}

/**
 * Publishes an event: persists it, then runs subscribed handlers as a simple
 * async queue (sequentially, so ordering is preserved; a slow handler delays
 * later ones for the same event but never blocks the caller from getting the
 * persisted event back - handlers are awaited via a fire-and-forget queue
 * rather than being on the publish() await path itself is a valid future
 * optimization, but Phase 2 keeps it simple and synchronous for
 * predictability in tests).
 */
export async function publish(event: EventInput): Promise<PersistedEvent> {
  const safePayload = event.payload !== undefined ? redact(event.payload) : undefined;
  const row = await prisma.event.create({
    data: {
      type: event.type,
      payload: safePayload !== undefined ? JSON.stringify(safePayload) : null,
      source: event.source,
    },
  });

  const persisted: PersistedEvent = {
    id: row.id,
    type: row.type,
    payload: safePayload,
    source: row.source,
    createdAt: row.createdAt,
  };

  const subs = handlers.get(event.type) ?? [];
  for (const handler of subs) {
    try {
      await handler(persisted);
    } catch (err) {
      log("ERROR", "events.handler_error", {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return persisted;
}

/** Test-only: clears all subscriptions. */
export function __resetSubscriptionsForTests(): void {
  handlers.clear();
}

// ---------------------------------------------------------------------------
// Proof-of-pipe default subscriber: EVENT -> DECISION.
//
// Whenever a "scheduler.fired" or "task.created" event is published, this
// subscriber logs it and runs it through the policy engine (which itself
// wraps core/decision_engine's classify()). This is intentionally the ONLY
// wired example per the task spec - CRM/email/web-monitoring event sources
// are out of scope for Phase 2.
// ---------------------------------------------------------------------------
let defaultSubscribersRegistered = false;

export function registerDefaultSubscribers(): void {
  if (defaultSubscribersRegistered) return;
  defaultSubscribersRegistered = true;

  const proofOfPipe: EventHandler = async (event) => {
    // Lazy import avoids a core/events <-> core/policy load-order dependency
    // at module init (policy has no need to know about events).
    const { evaluatePolicy } = await import("../policy");
    const result = evaluatePolicy(event.type, { actionName: event.type });
    log("INFO", "events.proof_of_pipe", {
      eventId: event.id,
      eventType: event.type,
      source: event.source,
      policyLevel: result.level,
      decisionCategory: result.decision.category,
    });
  };

  subscribe("scheduler.fired", proofOfPipe);
  subscribe("task.created", proofOfPipe);
}
