import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from "crypto";
import { env } from "@/lib/env";

/*
 * AES-256-GCM helper for encrypting secrets at rest (OAuth connector tokens and
 * the NextAuth `Account` tokens). Every ciphertext carries the id of the key
 * that sealed it, so keys can be ROTATED without a flag day:
 *
 *   1. add a new key, name it primary, deploy   → new writes use it
 *   2. run `npm run crypto:rotate`               → re-seals old rows under it
 *   3. drop the retired key from the env         → fully rotated
 *
 * Keys come from two places:
 *   - "auth" — derived from AUTH_SECRET (always present). This is the key that
 *     sealed every legacy (unversioned) payload, so it must never be dropped
 *     while any `auth`-tagged data remains.
 *   - explicit keys from TOKEN_ENCRYPTION_KEYS ("id:material,id2:material").
 *     Because these are independent of AUTH_SECRET, rotating onto one lets you
 *     rotate AUTH_SECRET itself later without stranding encrypted data.
 *
 * Payload format:
 *   legacy  : base64(iv).base64(tag).base64(ciphertext)                (3 parts)
 *   current : v1.<keyId>.base64(iv).base64(tag).base64(ciphertext)     (5 parts)
 * base64 never contains ".", so the part count disambiguates the two.
 */

const VERSION = "v1";
/** Key id for the AUTH_SECRET-derived key; also the implicit id of legacy data. */
const AUTH_KEY_ID = "auth";

type KeyEntry = { id: string; key: Buffer };

/** The AES key historically derived from AUTH_SECRET — unchanged, so legacy
 *  ciphertext still decrypts byte-for-byte. */
function authDerivedKey(): Buffer {
  return createHash("sha256").update(`juno:connector:${env.authSecret}`).digest();
}

/** Accept a 32-byte key as 64-char hex, or as base64 / base64url. */
function decodeKeyMaterial(id: string, material: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(material)
    ? Buffer.from(material, "hex")
    : Buffer.from(material, "base64");
  if (key.length !== 32) {
    throw new Error(`Encryption key "${id}" must be 32 bytes (got ${key.length}) — use 64 hex chars or base64 of 32 bytes.`);
  }
  return key;
}

/** Parse TOKEN_ENCRYPTION_KEYS: comma-separated "id:material" entries. */
function parseConfiguredKeys(): KeyEntry[] {
  const raw = env.tokenEncryptionKeys;
  if (!raw) return [];
  const out: KeyEntry[] = [];
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep < 0) throw new Error(`Malformed TOKEN_ENCRYPTION_KEYS entry (expected "id:material"): "${entry}"`);
    const id = entry.slice(0, sep).trim();
    const material = entry.slice(sep + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid encryption key id "${id}" — use [A-Za-z0-9_-].`);
    if (id === AUTH_KEY_ID) throw new Error(`Encryption key id "${AUTH_KEY_ID}" is reserved for the AUTH_SECRET-derived key.`);
    out.push({ id, key: decodeKeyMaterial(id, material) });
  }
  return out;
}

/** Build the decryption keyring plus the id of the key used for new writes. */
function keyRegistry(): { primaryId: string; keys: Map<string, Buffer> } {
  const keys = new Map<string, Buffer>();
  keys.set(AUTH_KEY_ID, authDerivedKey());
  for (const { id, key } of parseConfiguredKeys()) {
    if (keys.has(id)) throw new Error(`Duplicate encryption key id "${id}".`);
    keys.set(id, key);
  }
  const primaryId = env.tokenEncryptionPrimary?.trim() || AUTH_KEY_ID;
  if (!keys.has(primaryId)) {
    throw new Error(`TOKEN_ENCRYPTION_PRIMARY="${primaryId}" is not a known key id (known: ${[...keys.keys()].join(", ")}).`);
  }
  return { primaryId, keys };
}

/** The key id that sealed a given payload ("auth" for legacy). */
function keyIdOf(payload: string): string {
  const parts = payload.split(".");
  if (parts.length === 5 && parts[0] === VERSION) return parts[1];
  if (parts.length === 3) return AUTH_KEY_ID;
  throw new Error("Malformed encrypted secret");
}

export function encryptSecret(plain: string): string {
  const { primaryId, keys } = keyRegistry();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(primaryId)!, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${primaryId}.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  let keyId: string, ivB64: string, tagB64: string, dataB64: string;
  if (parts.length === 5 && parts[0] === VERSION) {
    [, keyId, ivB64, tagB64, dataB64] = parts;
  } else if (parts.length === 3) {
    keyId = AUTH_KEY_ID;
    [ivB64, tagB64, dataB64] = parts;
  } else {
    throw new Error("Malformed encrypted secret");
  }
  const key = keyRegistry().keys.get(keyId);
  if (!key) throw new Error(`No decryption key available for id "${keyId}" — was it dropped from the env before re-encrypting?`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** True when the payload is already sealed under the current primary key. */
export function isSealedWithPrimary(payload: string): boolean {
  return keyIdOf(payload) === keyRegistry().primaryId;
}

/** Decrypt (with whatever key sealed it) and re-seal under the primary key.
 *  Used by the rotation backfill; a no-op re-seal is harmless. */
export function reencryptSecret(payload: string): string {
  return encryptSecret(decryptSecret(payload));
}

// Token-bearing columns on the NextAuth `Account` model. Stored encrypted at
// rest so a DB dump alone never yields a usable OAuth token.
const ACCOUNT_TOKEN_FIELDS = ["refresh_token", "access_token", "id_token"] as const;

/** Encrypt the token fields of a NextAuth account before persisting. */
export function encryptAccountTokens<T extends Record<string, unknown>>(account: T): T {
  const out: Record<string, unknown> = { ...account };
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0) out[field] = encryptSecret(v);
  }
  return out as T;
}

/** Inverse of encryptAccountTokens — decrypt token fields for use. */
export function decryptAccountTokens<T extends Record<string, unknown>>(account: T): T {
  const out: Record<string, unknown> = { ...account };
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const v = out[field];
    // Only our versioned ciphertext is decrypted. These columns held plaintext
    // before encryption landed (and never the old 3-part connector format), so
    // a non-"v1." value is a legacy plaintext token — including JWT id_tokens,
    // which are themselves 3 dot-separated parts — and is passed through
    // untouched. A "v1." payload that fails to decrypt means its key was dropped
    // too early; let that throw rather than hand ciphertext back as a token.
    if (typeof v === "string" && v.startsWith(`${VERSION}.`)) {
      out[field] = decryptSecret(v);
    }
  }
  return out as T;
}

/** Sign a short-lived OAuth state token: base64url(payload).hmac. */
export function signState(payload: string): string {
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", env.authSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verify + decode a signed state token; returns null if tampered/invalid. */
export function verifyState(token: string): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", env.authSecret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}
