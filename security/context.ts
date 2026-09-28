// security/context.ts - Phase 12 (item 7): the AsyncLocalStorage backing a
// per-request correlation id, kept in security/ (not apps/api/) so
// security/logger.ts can read it without inverting the normal dependency
// direction (apps/* depends on core/security/, never the reverse). The
// Express middleware that populates it lives in
// apps/api/src/middleware/requestContext.ts and simply calls runWithRequestId().
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Returns the current request's id, or undefined outside a request (scheduler/worker background code, tests). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}
