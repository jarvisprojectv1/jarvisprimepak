// database/migrate.ts - applies pending Prisma migrations at process startup.
// This lets `npm run dev -w apps/api` work immediately after `npm install`
// without a separate manual migration step (though `npm run prisma:migrate`
// at the root is still available for creating new migrations during
// development).
import { execFileSync } from "node:child_process";
import path from "node:path";
import "../config/env"; // ensures DATABASE_URL is defaulted before we shell out
import { log } from "../security/logger";

const SCHEMA_PATH = path.resolve(__dirname, "schema.prisma");

export function applyPendingMigrations(): void {
  try {
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", SCHEMA_PATH],
      { stdio: "pipe", env: process.env }
    );
    log("INFO", "database.migrate", { status: "applied" });
  } catch (err) {
    const output =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout?: Buffer }).stdout)
        : String(err);
    log("WARNING", "database.migrate_failed", { output });
  }
}
