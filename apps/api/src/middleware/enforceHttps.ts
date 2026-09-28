// apps/api/src/middleware/enforceHttps.ts - Phase 12 (item 10): optional
// HTTPS enforcement for production deployments.
//
// Honesty note: this Node process itself does NOT terminate TLS (there is
// no cert/key loading here) - in every deployment shape this repo documents
// (deploy/docker-compose.yml, deploy/systemd, deploy/pm2), a reverse proxy
// (nginx/Caddy/a platform load balancer) sits in front and terminates TLS,
// forwarding plain HTTP to this process with `X-Forwarded-Proto: https` set.
// This middleware is therefore OFF by default (most deployments either
// already only accept HTTPS at the edge, or are local/dev) and only takes
// effect when FORCE_HTTPS=true is explicitly set, at which point it rejects
// any request whose X-Forwarded-Proto is not "https" - trusting that header
// only because `app.set("trust proxy", ...)` is configured (see
// apps/api/src/app.ts) to trust it only from a configured proxy count/list,
// never blindly from an arbitrary client-supplied header on an untrusted
// connection.
import type { NextFunction, Request, Response } from "express";

export function enforceHttps() {
  const enabled = (process.env.FORCE_HTTPS ?? "").toLowerCase() === "true";
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      next();
      return;
    }
    // req.secure reflects X-Forwarded-Proto ONLY when Express's "trust
    // proxy" setting trusts the immediate peer - see app.ts.
    if (req.secure) {
      next();
      return;
    }
    res.status(403).json({ error: "HTTPS is required." });
  };
}
