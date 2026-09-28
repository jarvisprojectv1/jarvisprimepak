// tools/browser/fsSandbox.ts - reuses tools/files.ts's EXACT sandboxed-
// directory pattern (Phase 1) for upload/download file access (Phase 10,
// sections 21-23). The browser tool must NEVER receive raw filesystem
// access - only files explicitly placed in/read from data/sandbox.
import path from "node:path";
import fs from "node:fs/promises";
import { appConfig } from "../../config/env";
import { resolveSafePath } from "../files";

export function resolveSandboxPath(relativePath: string): string {
  return resolveSafePath(relativePath);
}

export async function ensureSandboxDir(): Promise<void> {
  await fs.mkdir(appConfig.sandboxDir, { recursive: true });
}

export function sandboxDownloadsDir(): string {
  return path.resolve(appConfig.sandboxDir, "browser_downloads");
}

// Section 21: block obviously-dangerous file types by extension by default -
// never auto-executed/auto-installed regardless.
export const DANGEROUS_DOWNLOAD_EXTENSIONS = [".exe", ".sh", ".bat", ".cmd", ".msi", ".dll", ".apk", ".scr", ".ps1", ".jar", ".app"];

export function isDangerousDownload(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return DANGEROUS_DOWNLOAD_EXTENSIONS.includes(ext);
}
