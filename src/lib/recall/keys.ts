import { createHmac, hkdfSync } from "node:crypto";
import { loadKeyring } from "@/lib/message-crypto";
import type { BlindHasher } from "@/lib/recall/index-core";

/*
 * Blind-token keys for session recall.
 *
 * One key per (account, message key): HKDF-SHA256 over the message-encryption
 * key named `keyId`, salted with the account id. So:
 *   - the index is unreadable without the same secret that protects messages;
 *   - two accounts' tokens for the same word differ, so nothing correlates
 *     across accounts;
 *   - rotating the message key rotates the index key with it — rows carry the
 *     keyId they were built under and the indexer rebuilds them under the
 *     active one, the way rotate-message-keys re-encrypts bodies.
 *
 * Tokens are HMAC-SHA256 truncated to 96 bits (16 base64url characters):
 * collisions are possible in principle and harmless in practice, because every
 * hit is verified against the decrypted body before it is shown.
 *
 * No `server-only` guard, like message-crypto.ts: the backfill and benchmark
 * scripts import it from plain Node.
 */

const INFO = "alevr:recall-index:v1";

export function recallActiveKeyId(): string {
  return loadKeyring().activeKeyId;
}

const cache = new Map<string, Buffer>();

function accountKey(userId: string, keyId: string): Buffer | null {
  const cacheKey = `${keyId}\u0000${userId}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const master = loadKeyring().keys.get(keyId);
  if (!master) return null;
  const key = Buffer.from(hkdfSync("sha256", master, Buffer.from(userId, "utf8"), INFO, 32));
  if (cache.size > 2_000) cache.clear();
  cache.set(cacheKey, key);
  return key;
}

/** The hasher for one account under one message key, or null when that key is no longer in the keyring. */
export function recallHasher(userId: string, keyId: string): BlindHasher | null {
  const key = accountKey(userId, keyId);
  if (!key) return null;
  return (token) => createHmac("sha256", key).update(token, "utf8").digest("base64url").slice(0, 16);
}
