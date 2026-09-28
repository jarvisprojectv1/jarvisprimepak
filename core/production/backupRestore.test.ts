// core/production/backupRestore.test.ts - Phase 12 (item 4): a REAL,
// executed backup -> restore cycle against an ISOLATED temp SQLite database
// (never the shared test dev.db other suites use), proving
// scripts/backup-db.sh and scripts/restore-db.sh actually round-trip real
// data, not just that the scripts parse. A genuine Prisma-migrated schema is
// used (via `prisma migrate deploy` against the temp file), a marker row is
// written, backed up, the working copy is then DESTROYED (simulating real
// data loss, not just "file happens to still exist"), restored from the
// backup, and the marker is read back through a fresh Prisma connection.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("scripts/backup-db.sh + scripts/restore-db.sh - real backup/restore cycle", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-backup-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const backupDir = path.join(tmpDir, "backups");
  const dbUrl = `file:${dbPath}`;

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backs up, destroys the working copy, restores, and the marker data survives intact", async () => {
    // 1. Real schema, via the real migration command this repo's own
    // pretest script uses - not a hand-rolled fixture schema.
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema=database/schema.prisma"],
      { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
    );

    const marker = `phase12-backup-marker-${Date.now()}`;
    const client1 = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await client1.setting.create({ data: { key: "phase12.backup_test_marker", value: marker } });
    await client1.$disconnect();

    // 2. Real backup, via the actual operator-facing script.
    const backupOutput = execFileSync(
      "bash",
      [path.join(REPO_ROOT, "scripts", "backup-db.sh"), backupDir],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf-8" }
    );
    const backupPath = backupOutput.trim().split("\n").pop()!.trim();
    expect(fs.existsSync(backupPath)).toBe(true);

    // 3. Genuinely destroy the working copy (not just delete-and-recreate -
    // simulate real data loss: the marker row is now gone if we reconnect).
    fs.rmSync(dbPath);
    fs.writeFileSync(dbPath, ""); // empty file, as a fresh/corrupt DB would be
    const client2 = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await expect(client2.setting.findMany()).rejects.toThrow();
    await client2.$disconnect().catch(() => {});

    // 4. Real restore, via the actual operator-facing script.
    execFileSync(
      "bash",
      [path.join(REPO_ROOT, "scripts", "restore-db.sh"), backupPath, "--force"],
      { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
    );

    // 5. The marker row is back, through a FRESH connection (no cached
    // client state could be faking this).
    const client3 = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const restored = await client3.setting.findUnique({ where: { key: "phase12.backup_test_marker" } });
    await client3.$disconnect();

    expect(restored).not.toBeNull();
    expect(restored?.value).toBe(marker);
  }, 60_000);

  it("restore-db.sh refuses to overwrite a non-empty target without --force", () => {
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema=database/schema.prisma"],
      { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
    );
    const decoyBackup = path.join(tmpDir, "decoy-backup.db");
    fs.copyFileSync(dbPath, decoyBackup);

    expect(() =>
      execFileSync("bash", [path.join(REPO_ROOT, "scripts", "restore-db.sh"), decoyBackup], {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      })
    ).toThrow();
  }, 30_000);
});
