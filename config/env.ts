// Central typed environment loader.
//
// Design principle (spec section 41/46): most integrations are OPTIONAL in
// Phase 1. We never crash at boot because an optional var is missing. Instead,
// `requireEnv` throws a clear, typed `ConfigurationRequiredError` at the exact
// point of use, so callers can catch it and return a `CONFIGURATION_REQUIRED`
// result instead of a stack trace.
import { config as loadDotenv } from "dotenv";
import path from "node:path";

// Load .env once, from the repo root, regardless of which package calls this.
loadDotenv({ path: path.resolve(__dirname, "..", ".env") });

// DATABASE_URL is not a secret (it's a local SQLite file path) and Phase 1 is
// designed to run with zero external infrastructure, so we default it to an
// absolute path next to database/schema.prisma when it isn't set - the app
// works out of the box before a .env is ever created.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
  const defaultDbPath = path.resolve(__dirname, "..", "database", "dev.db");
  process.env.DATABASE_URL = `file:${defaultDbPath}`;
}

export class ConfigurationRequiredError extends Error {
  public readonly code = "CONFIGURATION_REQUIRED" as const;
  public readonly variable: string;

  constructor(variable: string, hint?: string) {
    super(
      `CONFIGURATION REQUIRED: ${variable} is not set.${hint ? ` ${hint}` : ""}`
    );
    this.name = "ConfigurationRequiredError";
    this.variable = variable;
  }
}

/** Returns the env var, or throws ConfigurationRequiredError with a helpful message. */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigurationRequiredError(name, hint);
  }
  return value;
}

/** Returns the env var, or a fallback. Never throws - use for optional config. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/** Non-secret, always-available app configuration. Safe to read eagerly. */
export const appConfig = {
  port: parseInt(optionalEnv("PORT", "4000"), 10),
  nodeEnv: optionalEnv("NODE_ENV", "development"),
  databaseUrl: optionalEnv("DATABASE_URL", "file:./dev.db"),
  logLevel: optionalEnv("LOG_LEVEL", "info"),
  sandboxDir: optionalEnv(
    "SANDBOX_DIR",
    path.resolve(__dirname, "..", "data", "sandbox")
  ),
};
