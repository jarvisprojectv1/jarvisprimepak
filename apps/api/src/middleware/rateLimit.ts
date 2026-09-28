// apps/api/src/middleware/rateLimit.ts - Phase 12 (item 11): rate-limiting
// for the PUBLIC, unauthenticated webhook endpoints (POST/GET
// /webhooks/whatsapp, /webhooks/voice). Every other route is protected by
// requireAuth (a session) plus core/limits' tool/agent rate limits inside
// the enforcement gate - webhooks have neither (they're authenticated by
// provider signature, not a session, and never pass through
// core/enforcement at all, since they're not a tool/agent call), so without
// this they had NO request-volume protection whatsoever.
//
// Deliberately a simple in-memory fixed-window counter per client IP, NOT a
// new dependency and NOT backed by the DB claim-atomicity pattern - unlike
// task claiming, this doesn't need to be exactly-once-correct across
// processes; it needs to be "good enough to blunt a flood" for a
// single-process deployment (this stack has no process supervisor
// distributing traffic across multiple API processes - see
// docs/PHASE5_AUTONOMOUS_WORKER.md and this phase's docs/PHASE12_PRODUCTION.md
// for the honest multi-instance caveat: in a horizontally-scaled deployment,
// each instance enforces its own window, so the EFFECTIVE limit is
// (perInstanceLimit x instanceCount). This is disclosed, not hidden.
import type { NextFunction, Request, Response } from "express";
import { log } from "../../../../security/logger";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Used in log lines / the 429 body to identify which limiter tripped. */
  name: string;
}

/** Test-only: lets tests get a fresh limiter state without importing a private map. */
export function createRateLimiter(opts: RateLimitOptions) {
  const buckets = new Map<string, Window>();

  function keyFor(req: Request): string {
    // req.ip respects Express's `trust proxy` setting; falls back to the raw
    // socket address if unavailable (e.g. in a test harness).
    return req.ip || req.socket.remoteAddress || "unknown";
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const key = keyFor(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > opts.max) {
      log("SECURITY", `ratelimit.exceeded:${opts.name}`, { key, count: bucket.count, max: opts.max });
      res.status(429).json({ error: "Too many requests." });
      return;
    }
    next();
  }

  return { middleware, buckets };
}
