import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import { env } from "@/lib/env";

/*
 * AES-256-GCM encryption at rest for chat message bodies (Message.content and
 * Message.reasoning), so direct database access cannot read conversations.
 * The key is DATA_ENCRYPTION_KEY (base64, 32 bytes) when set; otherwise it is
 * derived deterministically from AUTH_SECRET via HKDF-SHA256, so no extra key
 * management is needed. Wire format: enc:v1:base64(iv):base64(tag):base64(ciphertext).
 *
 * Unlike crypto.ts this module has no "server-only" guard: the one-off
 * migration (scripts/encrypt-messages.ts) must import it from plain Node.
 */

/** Prefix marking an encrypted payload; rows without it are legacy plaintext. */
export const MESSAGE_ENC_PREFIX = "enc:v1:";

const HKDF_INFO = "juno:message-crypto:v1";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.DATA_ENCRYPTION_KEY;
  if (configured) {
    const k = Buffer.from(configured, "base64");
    if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be exactly 32 bytes of base64.");
    cachedKey = k;
  } else {
    // Fallback: derive the data key from AUTH_SECRET. This couples message
    // encryption to the auth secret — rotating AUTH_SECRET would make every
    // stored message undecryptable. Set an explicit DATA_ENCRYPTION_KEY
    // (openssl rand -base64 32) in production to decouple the two.
    console.warn(
      "[message-crypto] DATA_ENCRYPTION_KEY is unset — deriving the message key from AUTH_SECRET. " +
        "Rotating AUTH_SECRET will orphan all stored messages. Set DATA_ENCRYPTION_KEY to decouple them.",
    );
    cachedKey = Buffer.from(hkdfSync("sha256", env.authSecret, Buffer.alloc(0), HKDF_INFO, 32));
  }
  return cachedKey;
}

/** True when a stored value is an enc:v1: payload (vs legacy plaintext). */
export function isEncryptedMessageText(stored: string): boolean {
  return stored.startsWith(MESSAGE_ENC_PREFIX);
}

/** Encrypt a message body for storage. Every write must go through this. */
export function encryptMessageText(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MESSAGE_ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/**
 * Decrypt a stored message body. Values without the enc:v1: prefix are legacy
 * plaintext rows and are returned unchanged; malformed or tampered enc:v1:
 * payloads throw a descriptive error. Null/undefined pass through, so nullable
 * columns (reasoning) can be piped in directly.
 */
export function decryptMessageText(stored: string): string;
export function decryptMessageText(stored: string | null): string | null;
export function decryptMessageText(stored: string | null | undefined): string | null | undefined;
export function decryptMessageText(stored: string | null | undefined): string | null | undefined {
  if (stored == null || !isEncryptedMessageText(stored)) return stored;
  const parts = stored.slice(MESSAGE_ENC_PREFIX.length).split(":");
  // Ciphertext may legitimately be "" (encrypted empty string), so check arity, not truthiness.
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("Malformed encrypted message payload: expected enc:v1:<iv>:<tag>:<ciphertext>.");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== 12) throw new Error(`Malformed encrypted message payload: iv must be 12 bytes, got ${iv.length}.`);
  if (tag.length !== 16) throw new Error(`Malformed encrypted message payload: auth tag must be 16 bytes, got ${tag.length}.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error(
      `Failed to decrypt message payload — wrong DATA_ENCRYPTION_KEY/AUTH_SECRET or tampered ciphertext (${err instanceof Error ? err.message : String(err)}).`
    );
  }
}

/**
 * Lenient decrypt for read/display paths: a single undecryptable row (corrupt
 * ciphertext, key mismatch, or a legacy plaintext that happened to start with
 * the enc prefix) returns a placeholder instead of throwing, so one bad row
 * cannot 500 an entire conversation load or account export.
 */
export function decryptMessageTextSafe(stored: string): string;
export function decryptMessageTextSafe(stored: string | null): string | null;
export function decryptMessageTextSafe(stored: string | null | undefined): string | null | undefined;
export function decryptMessageTextSafe(stored: string | null | undefined): string | null | undefined {
  try {
    return decryptMessageText(stored);
  } catch (err) {
    console.error("[message-crypto] decrypt failed, returning placeholder", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "[message could not be decrypted]";
  }
}
