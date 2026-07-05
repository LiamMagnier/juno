import "server-only";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";

/*
 * Password hashing.
 *
 * bcrypt only considers the first 72 bytes of its input, so a long password is
 * silently truncated — two passwords sharing a 72-byte prefix would collide.
 * We defeat that by pre-hashing with SHA-256 and base64-encoding first: the
 * whole password contributes entropy, and the 44-char base64 digest (ASCII, no
 * NUL byte) fits comfortably under the 72-byte cap.
 *
 * The pre-hash is intentionally UNKEYED. A keyed pepper would add shucking
 * resistance but would tie every hash to a secret that could never be rotated
 * without forcing a password reset — the same fragility we removed elsewhere.
 *
 * Stored format is versioned so the scheme can evolve and old hashes migrate
 * lazily on the next successful sign-in:
 *   legacy : "$2..." (raw bcrypt over the truncated password)
 *   v2     : "v2:$2..." (bcrypt over base64(sha256(password)))
 */

const BCRYPT_ROUNDS = 12;
const V2_PREFIX = "v2:";

function prehash(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

/** Hash a plaintext password with the current (v2) scheme. */
export async function hashPassword(password: string): Promise<string> {
  return V2_PREFIX + (await bcrypt.hash(prehash(password), BCRYPT_ROUNDS));
}

/**
 * Verify a password against a stored hash of any supported scheme.
 * `needsUpgrade` is true when the stored hash is a legacy format that verified
 * correctly — the caller should re-hash and persist to migrate it to v2.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ ok: boolean; needsUpgrade: boolean }> {
  if (stored.startsWith(V2_PREFIX)) {
    const ok = await bcrypt.compare(prehash(password), stored.slice(V2_PREFIX.length));
    return { ok, needsUpgrade: false };
  }
  // Legacy raw bcrypt. bcrypt.compare truncates the same way the hash was made,
  // so this still verifies pre-existing accounts.
  const ok = await bcrypt.compare(password, stored);
  return { ok, needsUpgrade: ok };
}
