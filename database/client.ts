// Shared Prisma client singleton used by core/, agents/, tools/, scheduler/
// and apps/api. A single instance avoids exhausting SQLite connections
// during tests and dev-server hot reloads.
import "../config/env"; // ensures DATABASE_URL is loaded/defaulted before the client is built
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __jarvisPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__jarvisPrisma ??
  new PrismaClient({
    // Keep Prisma's own query logging off by default; our pino logger is the
    // single source of truth for structured logs (see security/logger.ts).
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__jarvisPrisma = prisma;
}
