// core/auth/password.ts - password hashing/verification using bcrypt.
// Never log or persist a raw password; only the bcrypt hash is stored
// (User.passwordHash). redact() also treats any "password" key as secret.
import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
