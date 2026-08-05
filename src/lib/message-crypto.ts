import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

/*
 * AES-256-GCM encryption at rest for chat message bodies (Message.content and
 * Message.reasoning), so direct database access cannot read conversations.
 *
 * Wire formats, both readable, only the second written:
 *   enc:v1:<iv>:<tag>:<ciphertext>            — one implicit key, no identifier
 *   enc:v2:<keyId>:<iv>:<tag>:<ciphertext>    — names the key that encrypted it
 *
 * v1 is why v2 exists. With no key identifier in the payload there is exactly
 * one key the whole database can be read with, so rotating means re-encrypting
 * every row in one transaction that cannot be resumed and cannot be rolled
 * back — which in practice means never rotating. v2 lets an active key and any
 * number of previous keys coexist, so rotation is a background job that can
 * stop and restart, and a half-finished rotation is a readable database.
 *
 * Unlike crypto.ts this module has no "server-only" guard: the migration and
 * rotation scripts must import it from plain Node.
 */

/** Prefix marking a v1 payload; rows without it are legacy plaintext. */
export const MESSAGE_ENC_PREFIX = "enc:v1:";
/** Prefix marking a v2 (key-identified) payload. */
export const MESSAGE_ENC_V2_PREFIX = "enc:v2:";

const HKDF_INFO = "juno:message-crypto:v1";

/** The id given to a key supplied through the single-key env var. */
export const LEGACY_KEY_ID = "legacy";
/** The id given to the AUTH_SECRET-derived development key. */
export const DERIVED_KEY_ID = "derived";

export { MessageCryptoConfigError } from "@/lib/message-crypto-config";
import { MessageCryptoConfigError } from "@/lib/message-crypto-config";

export interface MessageKeyring {
  /** Key ids → 32-byte keys. Every key here can decrypt. */
  keys: Map<string, Buffer>;
  /** The id new payloads are encrypted under. */
  activeKeyId: string;
  /**
   * True when the active key was derived from AUTH_SECRET rather than supplied
   * explicitly. Never true in production — see `loadKeyring`.
   */
  derived: boolean;
}

let cachedKeyring: MessageKeyring | null = null;

/** Decryption failures since boot, by reason. Surfaced for alerting. */
const decryptFailures = new Map<string, number>();

export function messageCryptoMetrics(): Record<string, number> {
  return Object.fromEntries(decryptFailures);
}

function recordFailure(reason: string): void {
  decryptFailures.set(reason, (decryptFailures.get(reason) ?? 0) + 1);
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseKeyMaterial(id: string, base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new MessageCryptoConfigError(
      `Data encryption key '${id}' must be exactly 32 bytes of base64 (got ${key.length}).`
    );
  }
  return key;
}

/**
 * Reads the keyring from the environment.
 *
 * Accepted, in precedence order:
 *   DATA_ENCRYPTION_KEYRING  `id:base64,id:base64` — every key that may decrypt
 *   DATA_ENCRYPTION_ACTIVE_KEY_ID  which of them encrypts new rows
 *   DATA_ENCRYPTION_KEY      a single key, mapped to the id `legacy`
 *
 * In production, one of the two must be present. Deriving the message key from
 * AUTH_SECRET is a development convenience that silently couples two unrelated
 * secrets: rotating AUTH_SECRET — a routine, well-documented thing to do after
 * a leak — would make every stored message permanently unreadable. Refusing to
 * boot is the only way that trade stays visible.
 */
export function loadKeyring(): MessageKeyring {
  if (cachedKeyring) return cachedKeyring;

  const keys = new Map<string, Buffer>();
  const raw = process.env.DATA_ENCRYPTION_KEYRING?.trim();
  if (raw) {
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        throw new MessageCryptoConfigError(
          "DATA_ENCRYPTION_KEYRING entries must be '<keyId>:<base64Key>'."
        );
      }
      const id = entry.slice(0, separator).trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        throw new MessageCryptoConfigError(
          `Invalid key id '${id}': use 1–32 characters of [A-Za-z0-9_-].`
        );
      }
      keys.set(id, parseKeyMaterial(id, entry.slice(separator + 1).trim()));
    }
  }

  const single = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (single) keys.set(LEGACY_KEY_ID, parseKeyMaterial(LEGACY_KEY_ID, single));

  if (keys.size > 0) {
    const requested = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID?.trim();
    // Prefer an explicit active id; else the single key; else the first listed.
    const activeKeyId = requested || (single ? LEGACY_KEY_ID : [...keys.keys()][0]);
    if (!keys.has(activeKeyId)) {
      throw new MessageCryptoConfigError(
        `DATA_ENCRYPTION_ACTIVE_KEY_ID '${activeKeyId}' is not present in the keyring.`
      );
    }
    cachedKeyring = { keys, activeKeyId, derived: false };
    return cachedKeyring;
  }

  // Read at call time, not from `env.isProd`, which snapshots NODE_ENV when the
  // env module is first imported. This check has to reflect the process the
  // keys are actually being loaded in.
  if (isProduction()) {
    throw new MessageCryptoConfigError(
      "No data encryption key is configured. Set DATA_ENCRYPTION_KEYRING (or DATA_ENCRYPTION_KEY) " +
        "before starting in production. Deriving the message key from AUTH_SECRET would mean that " +
        "rotating AUTH_SECRET permanently orphans every stored message."
    );
  }

  console.warn(
    "[message-crypto] No DATA_ENCRYPTION_KEYRING/DATA_ENCRYPTION_KEY — deriving a development key " +
      "from AUTH_SECRET. This is refused in production."
  );
  const derived = Buffer.from(hkdfSync("sha256", env.authSecret, Buffer.alloc(0), HKDF_INFO, 32));
  keys.set(DERIVED_KEY_ID, derived);
  cachedKeyring = { keys, activeKeyId: DERIVED_KEY_ID, derived: true };
  return cachedKeyring;
}

/** Test seam. Never called in production paths. */
export function resetKeyringCacheForTests(): void {
  cachedKeyring = null;
  decryptFailures.clear();
}

/**
 * Fails fast at boot rather than on the first message write.
 *
 * A misconfigured deployment that starts successfully and then throws on every
 * chat is far worse than one that refuses to start: the first is discovered by
 * users, the second by whoever ran the deploy.
 */
export function assertMessageCryptoConfigured(): void {
  const keyring = loadKeyring();
  if (isProduction() && keyring.derived) {
    throw new MessageCryptoConfigError(
      "Refusing to run in production with an AUTH_SECRET-derived message key."
    );
  }
}

/** True when a stored value is an encrypted payload (vs legacy plaintext). */
export function isEncryptedMessageText(stored: string): boolean {
  return stored.startsWith(MESSAGE_ENC_PREFIX) || stored.startsWith(MESSAGE_ENC_V2_PREFIX);
}

/** The key id a stored payload was encrypted under, or null for v1/plaintext. */
export function messageKeyId(stored: string): string | null {
  if (!stored.startsWith(MESSAGE_ENC_V2_PREFIX)) return null;
  const id = stored.slice(MESSAGE_ENC_V2_PREFIX.length).split(":")[0];
  return id || null;
}

/**
 * True when a row is already encrypted under the active key — the check the
 * rotation job uses to skip work, which is what makes it resumable and
 * idempotent.
 */
export function isEncryptedUnderActiveKey(stored: string): boolean {
  return messageKeyId(stored) === loadKeyring().activeKeyId;
}

/** Encrypt a message body for storage. Every write must go through this. */
export function encryptMessageText(plain: string): string {
  const keyring = loadKeyring();
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new MessageCryptoConfigError("Active key missing from the keyring.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    MESSAGE_ENC_V2_PREFIX + keyring.activeKeyId,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

interface ParsedPayload {
  keyId: string | null;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

function parsePayload(stored: string): ParsedPayload {
  const isV2 = stored.startsWith(MESSAGE_ENC_V2_PREFIX);
  const body = stored.slice(
    (isV2 ? MESSAGE_ENC_V2_PREFIX : MESSAGE_ENC_PREFIX).length
  );
  const parts = body.split(":");
  const expected = isV2 ? 4 : 3;
  // Ciphertext may legitimately be "" (an encrypted empty string), so check
  // arity, not truthiness.
  if (parts.length !== expected) {
    throw new Error(
      `Malformed encrypted message payload: expected ${
        isV2 ? "enc:v2:<keyId>:<iv>:<tag>:<ciphertext>" : "enc:v1:<iv>:<tag>:<ciphertext>"
      }.`
    );
  }
  const keyId = isV2 ? parts[0] : null;
  const [ivB64, tagB64, dataB64] = isV2 ? parts.slice(1) : parts;
  if (isV2 && !keyId) {
    throw new Error("Malformed encrypted message payload: empty key id.");
  }
  if (!ivB64 || !tagB64) {
    throw new Error("Malformed encrypted message payload: missing iv or tag.");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== 12) {
    throw new Error(`Malformed encrypted message payload: iv must be 12 bytes, got ${iv.length}.`);
  }
  if (tag.length !== 16) {
    throw new Error(
      `Malformed encrypted message payload: auth tag must be 16 bytes, got ${tag.length}.`
    );
  }
  return { keyId, iv, tag, data: Buffer.from(dataB64, "base64") };
}

function decryptWith(key: Buffer, payload: ParsedPayload): string {
  const decipher = createDecipheriv("aes-256-gcm", key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.data), decipher.final()]).toString("utf8");
}

/**
 * Decrypt a stored message body. Values without a recognised prefix are legacy
 * plaintext rows and are returned unchanged; malformed or tampered payloads
 * throw a descriptive error. Null/undefined pass through, so nullable columns
 * (reasoning) can be piped in directly.
 */
export function decryptMessageText(stored: string): string;
export function decryptMessageText(stored: string | null): string | null;
export function decryptMessageText(stored: string | null | undefined): string | null | undefined;
export function decryptMessageText(stored: string | null | undefined): string | null | undefined {
  if (stored == null || !isEncryptedMessageText(stored)) return stored;
  const payload = parsePayload(stored);
  const keyring = loadKeyring();

  if (payload.keyId) {
    const key = keyring.keys.get(payload.keyId);
    if (!key) {
      recordFailure("unknown_key_id");
      throw new Error(
        `Failed to decrypt message payload: key '${payload.keyId}' is not in the configured keyring. ` +
          "A previous key must stay on the keyring until rotation has re-encrypted every row under it."
      );
    }
    try {
      return decryptWith(key, payload);
    } catch (err) {
      recordFailure("bad_ciphertext");
      throw new Error(
        `Failed to decrypt message payload under key '${payload.keyId}' — tampered ciphertext or wrong key material (${
          err instanceof Error ? err.message : String(err)
        }).`
      );
    }
  }

  // v1 names no key. Try every key on the ring, active first: a deployment
  // migrating from v1 has exactly one that works, and GCM's tag makes a wrong
  // key a clean failure rather than garbage plaintext.
  const ordered = [
    keyring.activeKeyId,
    ...[...keyring.keys.keys()].filter((id) => id !== keyring.activeKeyId),
  ];
  for (const id of ordered) {
    const key = keyring.keys.get(id);
    if (!key) continue;
    try {
      return decryptWith(key, payload);
    } catch {
      // Try the next key.
    }
  }
  recordFailure("v1_no_matching_key");
  throw new Error(
    "Failed to decrypt a v1 message payload: no key on the ring matches. The key that wrote it " +
      "must be added to DATA_ENCRYPTION_KEYRING before these rows can be read or rotated."
  );
}

/**
 * Lenient decrypt for read/display paths: a single undecryptable row (corrupt
 * ciphertext, key mismatch, or a legacy plaintext that happened to start with
 * an enc prefix) returns a placeholder instead of throwing, so one bad row
 * cannot 500 an entire conversation load or account export.
 */
export function decryptMessageTextSafe(stored: string): string;
export function decryptMessageTextSafe(stored: string | null): string | null;
export function decryptMessageTextSafe(stored: string | null | undefined): string | null | undefined;
export function decryptMessageTextSafe(
  stored: string | null | undefined
): string | null | undefined {
  try {
    return decryptMessageText(stored);
  } catch (err) {
    // Never logs the payload: a ciphertext in the logs is a copy of the message
    // sitting outside the database the encryption exists to protect.
    console.error("[message-crypto] decrypt failed, returning placeholder", {
      message: err instanceof Error ? err.message : String(err),
      keyId: typeof stored === "string" ? messageKeyId(stored) : null,
    });
    return "[message could not be decrypted]";
  }
}

/**
 * Re-encrypts a stored value under the active key.
 *
 * Returns null when the row is already under the active key, which is what
 * makes the rotation job idempotent: re-running it over a range it has already
 * covered does no writes.
 */
export function rotateMessageText(stored: string): string | null {
  if (!isEncryptedMessageText(stored)) {
    // Legacy plaintext: bring it under encryption as part of the same pass.
    return encryptMessageText(stored);
  }
  if (isEncryptedUnderActiveKey(stored)) return null;
  return encryptMessageText(decryptMessageText(stored));
}

/** Constant-time compare, for callers verifying a rotation checksum. */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
