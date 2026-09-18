/**
 * The token an `api` trigger fires with.
 *
 * One routine, one trigger, one token, and the server never holds the token —
 * only a SHA-256 of it, in `WorkSchedule.fireSecretHash`. That is the same
 * trade the rest of this codebase makes for a bearer credential it issues
 * rather than receives: the value is shown once, at the moment it is minted,
 * and a database dump yields nothing that can start a run.
 *
 * ON THE ROUTINE, NOT ON THE TRIGGER
 *
 * The obvious home is the `api` trigger row that the token fires, and it is the
 * wrong one: `PATCH /api/work/schedules/<id>` rewrites a routine's trigger set
 * wholesale, so editing an unrelated email filter would destroy the token row
 * and the CI job holding it would start failing with no edit anybody could
 * connect to it. The column's own docblock in prisma/schema.prisma argues the
 * same case at length. This comment used to name `WorkTrigger.secretHash` — a
 * column that has never existed — which is worse than saying nothing, because
 * this is the one file a reader opens to find out where the secret lives.
 *
 * WHY A HASH AND NOT THE CONNECTOR KEYRING
 *
 * `src/lib/crypto.ts` seals a secret Juno has to GIVE BACK — a connector's
 * access token, an environment's variables — so it must be reversible. This one
 * is only ever compared against what a caller presents, and a comparison needs
 * no plaintext. Sealing it instead would mean every fire request decrypts a
 * value it then throws away, and a key rotation would silently invalidate
 * everybody's CI job.
 *
 * SHA-256 WITHOUT A KDF, DELIBERATELY
 *
 * A password needs bcrypt/argon because a person chose it and the search space
 * is a dictionary. This token is 32 bytes from `randomBytes`, so there is no
 * dictionary and no amount of stretching changes an attacker's odds; what the
 * KDF would buy is a per-request cost on a route that has to answer a CI job in
 * milliseconds. The same reasoning `src/lib/cloud-code-token.ts` applies to the
 * task token.
 *
 * Pure: no `server-only`, no Prisma, no network. `node:crypto` only, which is
 * why this is its own module rather than three functions inside `triggers.ts` —
 * that file is imported by the trigger editor, and a client bundle cannot
 * resolve `node:crypto`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The prefix every fire token carries.
 *
 * Distinctive on purpose: a secret scanner — GitHub's own, or the one a user
 * runs over their CI configuration — can only recognise a credential it can
 * pick out of a line, and `jfr_` in a log is a string somebody can search the
 * codebase for and find this comment.
 */
export const FIRE_TOKEN_PREFIX = "jfr_";

/** 32 bytes, base64url, which is 43 characters after the prefix. */
const TOKEN_BYTES = 32;

/**
 * A new token and the hash to store beside it.
 *
 * Returned together because the caller must write one and show the other in the
 * same breath. A function that returned only the token would leave hashing to
 * each call site, and a call site that forgot would store the token itself.
 */
export function mintFireToken(): { token: string; hash: string } {
  const token = `${FIRE_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { token, hash: hashFireToken(token) };
}

export function hashFireToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a presented token is the one this trigger was issued.
 *
 * Constant-time over the HASHES rather than over the tokens, which is what
 * makes the comparison safe to do on strings of different lengths:
 * `timingSafeEqual` throws when its arguments differ in length, so comparing
 * raw tokens would turn "wrong length" into an exception and "right length,
 * wrong value" into a comparison — a length oracle in the shape of a 500.
 * Hashing first makes every candidate exactly 32 bytes.
 */
export function fireTokenMatches(presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashFireToken(presented), "hex");
  // A stored hash that is not 32 bytes of hex is a corrupt row, not a match.
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * The token out of an `Authorization` header, or null.
 *
 * Only `Bearer`, and case-insensitively on the scheme because RFC 7235 says the
 * scheme is case-insensitive and half the HTTP clients in the world send
 * `bearer`. A token in a query string is deliberately NOT accepted: query
 * strings are written to access logs, to browser history and to the Referer
 * header of anything the page then loads.
 */
export function fireTokenFromHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
