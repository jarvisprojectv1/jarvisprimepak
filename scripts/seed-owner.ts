// scripts/seed-owner.ts - creates the OWNER user from OWNER_EMAIL/
// OWNER_PASSWORD env vars. Run explicitly via `npm run seed:owner` - never
// invoked from any HTTP endpoint, so nothing over the network can
// self-elevate a new user to OWNER.
//
// Idempotent-safe: refuses to run (no changes made) if an OWNER already
// exists, so re-running this script never overwrites or duplicates the
// owner account.
import "../config/env";
import { prisma } from "../database/client";
import { hashPassword } from "../core/auth/password";
import crypto from "node:crypto";

async function main() {
  const existingOwner = await prisma.user.findFirst({ where: { role: "OWNER" } });
  if (existingOwner) {
    // eslint-disable-next-line no-console
    console.log(
      `An OWNER user already exists (${existingOwner.email}). Refusing to run again. ` +
        `Nothing was changed.`
    );
    process.exit(0);
  }

  const email = process.env.OWNER_EMAIL;
  if (!email || !email.trim()) {
    // eslint-disable-next-line no-console
    console.error("CONFIGURATION REQUIRED: OWNER_EMAIL is not set. Set it in .env and re-run.");
    process.exit(1);
  }

  let password = process.env.OWNER_PASSWORD;
  let generated = false;
  if (!password || !password.trim()) {
    password = crypto.randomBytes(18).toString("base64url");
    generated = true;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), role: "OWNER", passwordHash },
  });

  // eslint-disable-next-line no-console
  console.log(`OWNER user created: ${user.email} (id ${user.id}).`);
  if (generated) {
    // eslint-disable-next-line no-console
    console.log(
      `No OWNER_PASSWORD was set, so a random password was generated. ` +
        `This is printed ONCE and never stored anywhere in plaintext - save it now:\n\n  ${password}\n`
    );
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to seed OWNER user:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
