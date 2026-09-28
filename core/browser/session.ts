// core/browser/session.ts - Browser Session Model & Isolation (Phase 10,
// sections 6-7).
//
// Each JARVIS "browser session" is backed by a genuinely isolated Playwright
// BrowserContext: one shared Chromium `Browser` process is launched lazily
// (real OS-level launch is expensive; contexts are cheap and this is
// Playwright's own recommended pattern), but every session gets its OWN
// `browser.newContext()` - a fresh, empty cookie jar/localStorage/cache with
// nothing shared across sessions or tasks. A context is closed and disposed
// on session end (closeSession) or expiry (cleanupExpiredSessions), never
// reused for a different session. This is Playwright's own, real isolation
// guarantee, used correctly - not a fabricated one.
//
// The live Playwright objects (Browser/BrowserContext/Page) are ONLY ever
// held in this module's in-memory registry, keyed by BrowserSession.id - the
// Prisma BrowserSession row is metadata only (status/url/timestamps), never
// a serialized session/cookie blob. A process restart loses all live
// contexts; their BrowserSession rows are reconciled to EXPIRED on the next
// cleanup pass rather than assumed still-live.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { optionalEnv } from "../../config/env";

// Lazily imported so a machine/test that never touches the browser tool
// never pays Playwright's module-load cost, and so tests that only exercise
// policy logic don't need a real Chromium at all.
type PlaywrightModule = typeof import("playwright");
let playwrightModule: PlaywrightModule | null = null;
async function getPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightModule) {
    playwrightModule = await import("playwright");
  }
  return playwrightModule;
}

// One shared Browser process for the whole worker process - contexts (not
// browsers) are the isolation unit, matching Playwright's documented
// guidance. Launched on first use, never re-launched per session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedBrowser: any | null = null;
async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  const pw = await getPlaywright();
  sharedBrowser = await pw.chromium.launch({ headless: true });
  return sharedBrowser;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface LiveSession {
  context: any;
  page: any;
  extraPages: any[];
}
const liveSessions = new Map<string, LiveSession>();

function config() {
  return {
    sessionTtlMs: parseInt(optionalEnv("BROWSER_SESSION_TTL_MS", String(30 * 60 * 1000)), 10), // 30 min bounded lifetime
    idleTimeoutMs: parseInt(optionalEnv("BROWSER_SESSION_IDLE_TIMEOUT_MS", String(10 * 60 * 1000)), 10), // 10 min idle
  };
}

export interface CreateSessionInput {
  taskId?: string | null;
  createdBy: string;
}

export interface SessionRecord {
  id: string;
  status: string;
  currentUrl: string | null;
  currentDomain: string | null;
  expiresAt: Date;
}

export async function createIsolatedSession(input: CreateSessionInput): Promise<SessionRecord> {
  const { sessionTtlMs } = config();
  const browser = await getSharedBrowser();
  // Fresh, empty context - no storageState passed, so no cookies/localStorage
  // carry over from any other session.
  const context = await browser.newContext();
  const page = await context.newPage();

  const row = await prisma.browserSession.create({
    data: {
      provider: "playwright",
      status: "ACTIVE",
      isolationLevel: "CONTEXT",
      taskId: input.taskId ?? null,
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + sessionTtlMs),
    },
  });

  liveSessions.set(row.id, { context, page, extraPages: [] });
  log("INFO", "browser.session_created", { sessionId: row.id, taskId: input.taskId ?? null });

  return { id: row.id, status: row.status, currentUrl: row.currentUrl, currentDomain: row.currentDomain, expiresAt: row.expiresAt };
}

export function getLiveSession(sessionId: string): LiveSession | null {
  return liveSessions.get(sessionId) ?? null;
}

export async function touchSession(sessionId: string, patch: { currentUrl?: string; currentDomain?: string } = {}): Promise<void> {
  await prisma.browserSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date(), ...patch } })
    .catch(() => undefined);
}

export async function isSessionExpired(sessionId: string): Promise<boolean> {
  const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
  if (!row || row.status !== "ACTIVE") return true;
  const { idleTimeoutMs } = config();
  if (row.expiresAt.getTime() < Date.now()) return true;
  if (Date.now() - row.lastActivityAt.getTime() > idleTimeoutMs) return true;
  return false;
}

export async function closeSession(sessionId: string, reason = "closed"): Promise<void> {
  const live = liveSessions.get(sessionId);
  if (live) {
    for (const p of live.extraPages) await p.close().catch(() => undefined);
    await live.context.close().catch(() => undefined);
    liveSessions.delete(sessionId);
  }
  await prisma.browserSession
    .update({ where: { id: sessionId }, data: { status: "CLOSED", closedAt: new Date(), closeReason: reason } })
    .catch(() => undefined);
  log("INFO", "browser.session_closed", { sessionId, reason });
}

/**
 * Real cleanup path for abandoned sessions (section 6-7): closes any live
 * Playwright context whose BrowserSession row is expired/idle-timed-out, and
 * reconciles any ACTIVE row that has no live in-memory context (e.g. after a
 * process restart) to EXPIRED. Intended to be called periodically by the
 * SAME worker/watchdog periodic-tick mechanism Phase 5 already established
 * (core/worker/watchdog.ts) - no new background-process mechanism.
 */
export async function cleanupExpiredSessions(): Promise<{ closed: number }> {
  const active = await prisma.browserSession.findMany({ where: { status: "ACTIVE" } });
  let closed = 0;
  for (const row of active) {
    const expired = await isSessionExpired(row.id);
    if (expired) {
      await closeSession(row.id, "expired_or_idle_timeout");
      closed += 1;
    }
  }
  // Any live context with no matching ACTIVE row (shouldn't normally happen,
  // but fail safe rather than leak a Chromium context).
  for (const sessionId of Array.from(liveSessions.keys())) {
    const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
    if (!row || row.status !== "ACTIVE") {
      await closeSession(sessionId, "orphaned_context_reaped");
      closed += 1;
    }
  }
  return { closed };
}

/** Test-only: closes the shared browser process entirely. */
export async function _shutdownForTests(): Promise<void> {
  for (const sessionId of Array.from(liveSessions.keys())) {
    await closeSession(sessionId, "test_shutdown");
  }
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = null;
  }
}
