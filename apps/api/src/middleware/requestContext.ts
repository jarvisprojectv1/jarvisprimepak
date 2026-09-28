// apps/api/src/middleware/requestContext.ts - Phase 12 (item 7): a
// correlation/request ID on every request, threaded through structured
// logging (security/context.ts + security/logger.ts) and returned to the
// client so an operator can grep one id across logs, the audit log, and a
// client-reported error.
//
// Design: a request either arrives with its own `X-Request-Id` (e.g. set by
// an upstream load balancer or a calling service) - reused verbatim so a
// distributed trace stays joined - or one is generated here. Always echoed
// back on the response so a client can report it.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestId } from "../../../../security/context";

const REQUEST_ID_HEADER = "x-request-id";

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && incoming.trim() !== "" ? incoming.trim().slice(0, 128) : crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    runWithRequestId(requestId, () => next());
  };
}
