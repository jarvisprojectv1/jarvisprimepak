// tools/browser/playwrightProvider.ts - PlaywrightBrowserProvider (Phase 10,
// sections 2-5): a REAL implementation of BrowserProvider against a real,
// locally-launched headless Chromium (Playwright is pre-installed in this
// sandbox). Each session's page lives in its own isolated BrowserContext -
// see core/browser/session.ts.
//
// Deliberately NOT included, by construction, matching the brief's "no
// credential theft, cookie theft, CAPTCHA/MFA bypass, anti-bot evasion,
// fingerprint spoofing" instruction: no stealth-plugin-style config, no
// user-agent/header spoofing beyond Chromium's own real default UA, no
// automatic CAPTCHA-solving, no cookie/storage extraction API exposed to
// callers.
import path from "node:path";
import fs from "node:fs/promises";
import type { BrowserActionOutcome, BrowserProvider } from "./types";
import { createIsolatedSession, closeSession, getLiveSession, touchSession } from "../../core/browser/session";
import { domainOf } from "../web/sourceResolver";
import { ensureSandboxDir, resolveSandboxPath, sandboxDownloadsDir, isDangerousDownload } from "./fsSandbox";
import { log } from "../../security/logger";

function fail(message: string): BrowserActionOutcome {
  return { ok: false, message };
}
function ok(message: string, data?: Record<string, unknown>): BrowserActionOutcome {
  return { ok: true, message, data };
}

async function requirePage(sessionId: string): Promise<{ page: unknown } | { error: BrowserActionOutcome }> {
  const live = getLiveSession(sessionId);
  if (!live) return { error: fail(`No live session "${sessionId}" (not created, already closed, or expired).`) };
  return { page: live.page };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

export class PlaywrightBrowserProvider implements BrowserProvider {
  name = "playwright";

  isConfigured(): boolean {
    // Real: no external credentials needed to launch a local headless
    // Chromium in this sandbox (PLAYWRIGHT_BROWSERS_PATH is pre-populated).
    return true;
  }

  async createSession(input: { taskId?: string | null; createdBy: string }) {
    try {
      const session = await createIsolatedSession(input);
      return { sessionId: session.id };
    } catch (err) {
      return { code: "ERROR" as const, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async closeSession(sessionId: string): Promise<BrowserActionOutcome> {
    await closeSession(sessionId, "tool_requested");
    return ok(`Session ${sessionId} closed.`);
  }

  async navigate(sessionId: string, url: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const currentUrl = page.url();
      await touchSession(sessionId, { currentUrl, currentDomain: domainOf(currentUrl) });
      return ok(`Navigated to ${currentUrl}.`, { url: currentUrl, status: response ? response.status() : null });
    } catch (err) {
      return fail(`Navigation to "${url}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async goBack(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    await page.goBack({ timeout: 10000 }).catch(() => undefined);
    return ok(`Went back. Current URL: ${page.url()}`, { url: page.url() });
  }

  async goForward(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    await page.goForward({ timeout: 10000 }).catch(() => undefined);
    return ok(`Went forward. Current URL: ${page.url()}`, { url: page.url() });
  }

  async reload(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    await page.reload({ timeout: 15000 }).catch(() => undefined);
    return ok(`Reloaded. Current URL: ${page.url()}`, { url: page.url() });
  }

  async getCurrentUrl(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    return ok(page.url(), { url: page.url() });
  }

  async getPageTitle(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const title = await page.title().catch(() => "");
    return ok(title, { title });
  }

  async getPageContent(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    // Bounded, text-only extraction (never raw HTML) - core/browser/observation.ts
    // applies the final size cap on top of this.
    // Runs inside the browser page context (not this Node process), so
    // `document`/`window` are real DOM globals there even though this
    // project's own tsconfig has no "dom" lib - hence the `globalThis as any`.
    const text = await page
      .evaluate(() => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return doc && doc.body ? doc.body.innerText ?? "" : "";
      })
      .catch(() => "");
    return ok(`Extracted ${text.length} chars.`, { text, url: page.url() });
  }

  async screenshot(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    // Section 34-38: default to NOT permanently stored - the buffer is
    // returned to the caller for this one call only, never written to disk
    // or Memory by this provider.
    const buffer = await page.screenshot({ type: "png" }).catch(() => null);
    if (!buffer) return fail("Screenshot failed.");
    return ok(`Screenshot captured (${buffer.length} bytes, not persisted).`, { base64Png: buffer.toString("base64"), persisted: false });
  }

  private async locate(page: AnyPage, target: { selector?: string; text?: string }) {
    if (target.selector) return page.locator(target.selector).first();
    if (target.text) return page.getByText(target.text, { exact: false }).first();
    return null;
  }

  async click(sessionId: string, target: { selector?: string; text?: string }): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const locator = await this.locate(page, target);
    if (!locator) return fail("click requires a 'selector' or 'text' target.");
    try {
      const elText = await locator.innerText({ timeout: 3000 }).catch(() => target.text ?? "");
      await locator.click({ timeout: 8000 });
      await touchSession(sessionId, { currentUrl: page.url(), currentDomain: domainOf(page.url()) });
      return ok(`Clicked element (${target.selector ?? target.text}).`, { elementText: elText, url: page.url() });
    } catch (err) {
      return fail(`Click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async type(sessionId: string, target: { selector?: string; text?: string }, value: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const locator = await this.locate(page, target);
    if (!locator) return fail("type requires a 'selector' or 'text' target.");
    try {
      await locator.fill(value, { timeout: 8000 });
      return ok(`Typed into element (${target.selector ?? target.text}).`);
    } catch (err) {
      return fail(`Type failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async select(sessionId: string, target: { selector: string }, value: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    try {
      await page.locator(target.selector).selectOption(value, { timeout: 8000 });
      return ok(`Selected "${value}" in ${target.selector}.`);
    } catch (err) {
      return fail(`Select failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async scroll(sessionId: string, direction: "down" | "up"): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const dy = direction === "down" ? 800 : -800;
    await page.mouse.wheel(0, dy).catch(() => undefined);
    return ok(`Scrolled ${direction}.`);
  }

  async wait(sessionId: string, ms: number): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const bounded = Math.min(Math.max(ms, 0), 15000); // never an unbounded wait
    await page.waitForTimeout(bounded);
    return ok(`Waited ${bounded}ms.`);
  }

  async findElement(sessionId: string, target: { selector?: string; text?: string }): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    const locator = await this.locate(page, target);
    if (!locator) return fail("findElement requires a 'selector' or 'text' target.");
    const count = await locator.count().catch(() => 0);
    return ok(count > 0 ? "Element found." : "Element not found.", { found: count > 0, count });
  }

  async inspectPage(sessionId: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    // A minimal accessibility-tree-derived snippet (roles + names), bounded.
    const snapshot = await page.accessibility.snapshot().catch(() => null);
    const summary = snapshot ? JSON.stringify(snapshot).slice(0, 4000) : "";
    return ok("Accessibility snapshot captured (bounded).", { accessibilitySnippet: summary });
  }

  async download(sessionId: string, url: string, filename: string): Promise<BrowserActionOutcome> {
    if (isDangerousDownload(filename)) {
      return fail(`Download of "${filename}" blocked: dangerous file extension (policy default: block executable/script types).`);
    }
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    try {
      await ensureSandboxDir();
      const dir = sandboxDownloadsDir();
      await fs.mkdir(dir, { recursive: true });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        page
          .evaluate((u: string) => {
            (globalThis as unknown as { location: { href: string } }).location.href = u;
          }, url)
          .catch(() => undefined),
      ]);
      const target = path.join(dir, filename);
      await download.saveAs(target);
      log("INFO", "browser.download_tracked", { sessionId, url, filename, target });
      // Never auto-executed/auto-installed - saved to the sandbox only.
      return ok(`Downloaded to sandbox (browser_downloads/${filename}). Never auto-executed.`, { filename, sandboxPath: `browser_downloads/${filename}`, url });
    } catch (err) {
      return fail(`Download failed or no download event observed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async upload(sessionId: string, target: { selector: string }, sandboxRelativePath: string): Promise<BrowserActionOutcome> {
    const r = await requirePage(sessionId);
    if ("error" in r) return r.error;
    const page = r.page as AnyPage;
    let resolved: string;
    try {
      resolved = resolveSandboxPath(sandboxRelativePath);
    } catch (err) {
      return fail(`Upload blocked: ${err instanceof Error ? err.message : String(err)} - only files inside the sandbox directory may be uploaded, never raw filesystem paths.`);
    }
    try {
      await fs.access(resolved);
    } catch {
      return fail(`Upload blocked: "${sandboxRelativePath}" does not exist in the sandbox directory.`);
    }
    try {
      await page.locator(target.selector).setInputFiles(resolved, { timeout: 8000 });
      return ok(`Uploaded sandbox file "${sandboxRelativePath}".`);
    } catch (err) {
      return fail(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async openTab(sessionId: string, url?: string): Promise<BrowserActionOutcome> {
    const live = getLiveSession(sessionId);
    if (!live) return fail(`No live session "${sessionId}".`);
    const newPage = await live.context.newPage();
    if (url) await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
    live.extraPages.push(newPage);
    return ok(`Opened tab ${live.extraPages.length}.`, { tabIndex: live.extraPages.length });
  }

  async closeTab(sessionId: string, tabIndex: number): Promise<BrowserActionOutcome> {
    const live = getLiveSession(sessionId);
    if (!live) return fail(`No live session "${sessionId}".`);
    const p = live.extraPages[tabIndex - 1];
    if (!p) return fail(`No tab ${tabIndex}.`);
    await p.close().catch(() => undefined);
    return ok(`Closed tab ${tabIndex}.`);
  }
}

export function createDefaultBrowserProvider(): BrowserProvider {
  return new PlaywrightBrowserProvider();
}
