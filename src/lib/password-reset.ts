import { createHash, randomBytes } from "crypto";

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const IDENTIFIER_PREFIX = "password-reset:";

/** Generate the secret placed in the email. Only its digest is persisted. */
export function createPasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A database-safe, fixed-length representation of the emailed secret. */
export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function passwordResetIdentifier(userId: string): string {
  return `${IDENTIFIER_PREFIX}${userId}`;
}

export function userIdFromPasswordResetIdentifier(identifier: string): string | null {
  if (!identifier.startsWith(IDENTIFIER_PREFIX)) return null;
  const userId = identifier.slice(IDENTIFIER_PREFIX.length);
  return userId || null;
}
