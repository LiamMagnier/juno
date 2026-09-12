/*
 * Encryption at rest for the columns that are NOT the transcript body.
 *
 * `Message.content` / `Message.reasoning` have been encrypted since
 * message-crypto.ts shipped, but the columns beside them were not, and several
 * of them carry strictly more sensitive material than the answer itself:
 * `Message.activity` holds the arguments Juno sent each connector and the text
 * each tool sent back — the user's own Gmail, Linear and Notion content,
 * verbatim — so a database dump yielded most of what the encryption existed to
 * protect. This module closes that gap.
 *
 * It deliberately owns NO key material and NO wire format. Everything is
 * delegated to src/lib/message-crypto.ts, so:
 *
 *   - there is one keyring, one `enc:v2:` format and one rotation story for
 *     the whole database. `npm run crypto:rotate:messages` already re-encrypts
 *     these columns (see scripts/rotate-message-keys.ts) because a payload
 *     written here is indistinguishable from one written there;
 *   - adding a key, or retiring one, is a single operational change rather
 *     than one per column.
 *
 * Two properties every caller depends on:
 *
 *   READ-BOTH. A value without an `enc:` prefix is a row written before the
 *   backfill ran and is returned untouched. That is what lets the code deploy
 *   before scripts/encrypt-columns.ts finishes — and what lets it finish at
 *   its own pace, or stop halfway, without a single broken read.
 *
 *   READS NEVER THROW. A column that cannot be decrypted (a key retired too
 *   early, a truncated write) must degrade to a placeholder, never to a 500:
 *   one bad `activity` blob would otherwise take down the whole conversation
 *   load, the account export, and the native sync that ships it.
 *
 * Like message-crypto.ts, and unlike crypto.ts, there is no "server-only"
 * guard here: the backfill and rotation scripts import it from plain Node.
 */
import {
  decryptMessageText,
  encryptMessageText,
  isEncryptedMessageText,
  messageKeyId,
} from "@/lib/message-crypto";

/**
 * What a read returns when the ciphertext cannot be recovered.
 *
 * Deliberately a sentinel rather than an empty string: callers that feed a
 * column to a model (the scheduled-task prompt) can recognise it and refuse to
 * run rather than silently spending money on a meaningless request.
 */
export const FIELD_DECRYPT_PLACEHOLDER = "[encrypted field could not be decrypted]";

/**
 * Reasons already logged this process.
 *
 * message-crypto's own safe variant logs on every failure, which is right for
 * a message body read one at a time. These columns are read in bulk — an
 * account export decrypts fifty thousand rows in one request — so a systemic
 * failure (a key dropped from the ring) would write one log line per row, each
 * naming the key id, and bury the one line an operator needed. One line per
 * distinct reason says exactly as much and stays readable.
 */
const loggedReasons = new Set<string>();

/** Decrypt failures since boot, by reason. Surfaced for alerting, like message-crypto. */
const failureCounts = new Map<string, number>();

export function fieldCryptoMetrics(): Record<string, number> {
  return Object.fromEntries(failureCounts);
}

/** Test seam — never called on a production path. */
export function resetFieldCryptoLogStateForTests(): void {
  loggedReasons.clear();
  failureCounts.clear();
}

function recordFailure(reason: string, stored: string | null, err: unknown): void {
  failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  // NEVER the payload. A ciphertext in the logs is a copy of the data sitting
  // outside the database the encryption exists to protect; the key id is
  // enough to tell an operator which key to put back on the ring.
  console.error(`[field-crypto] ${reason} — returning a placeholder for this read (logged once)`, {
    message: err instanceof Error ? err.message : String(err),
    keyId: stored != null ? messageKeyId(stored) : null,
  });
}

/**
 * The safe-read contract of `decryptMessageTextSafe`, with the log deduplicated
 * per the note on `loggedReasons`.
 */
function safeDecrypt(stored: string, reason: string): string {
  try {
    return decryptMessageText(stored);
  } catch (err) {
    recordFailure(reason, stored, err);
    return FIELD_DECRYPT_PLACEHOLDER;
  }
}

// ---------------------------------------------------------------------------
// Text columns
// ---------------------------------------------------------------------------

/** Encrypt a text column for storage. Every write must go through this. */
export function encryptField(plain: string): string;
export function encryptField(plain: string | null): string | null;
export function encryptField(plain: string | null | undefined): string | null | undefined;
export function encryptField(plain: string | null | undefined): string | null | undefined {
  if (plain == null) return plain;
  // Re-encrypting an already-encrypted value would nest two payloads and make
  // the row unreadable in one pass. The backfill relies on this being a no-op
  // for rows it has already covered.
  if (isEncryptedMessageText(plain)) return plain;
  return encryptMessageText(plain);
}

/**
 * Decrypt a text column. Plaintext (no `enc:` prefix) passes through untouched
 * — see READ-BOTH above — and an undecryptable payload yields
 * `FIELD_DECRYPT_PLACEHOLDER` rather than throwing.
 */
export function decryptField(stored: string): string;
export function decryptField(stored: string | null): string | null;
export function decryptField(stored: string | null | undefined): string | null | undefined;
export function decryptField(stored: string | null | undefined): string | null | undefined {
  if (stored == null || !isEncryptedMessageText(stored)) return stored;
  return safeDecrypt(stored, "text column decrypt failed");
}

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

/**
 * The shape a `Json` column takes once its contents are encrypted.
 *
 * `Message.activity` is `Json?` in the Prisma schema, and it stays `Json?`:
 * changing it to `String?` would mean a migration that rewrites every row of
 * the largest table in the database before a single line of new code could
 * run. A one-key object keeps the column type — so Prisma's generated client,
 * the fork route's verbatim copy and `Prisma.DbNull` all keep working — while
 * still being trivially detectable by a reader, which is what
 * `isEncryptedJsonField` is for.
 */
export interface EncryptedJsonField {
  enc: string;
}

/** True when a `Json` column holds an encrypted payload rather than its cleartext value. */
export function isEncryptedJsonField(value: unknown): value is EncryptedJsonField {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const enc = (value as Record<string, unknown>).enc;
  return typeof enc === "string" && isEncryptedMessageText(enc);
}

/**
 * Encrypt a `Json` column's value.
 *
 * Returns `null` for a nullish input rather than an envelope around `"null"`:
 * a NULL `activity` means "this turn logged nothing", which is not a secret
 * and must stay distinguishable from an empty log. Callers writing a nullable
 * column keep their existing `DbNull` branch.
 */
export function encryptJsonField(value: unknown): EncryptedJsonField | null {
  if (value == null) return null;
  // Already sealed — same no-op guarantee as encryptField, for the same reason.
  if (isEncryptedJsonField(value)) return value;
  return { enc: encryptMessageText(JSON.stringify(value)) };
}

/**
 * Decrypt a `Json` column's value back to the structure that was written.
 *
 * Read-both: a value that is not a `{ enc }` envelope is a row written before
 * the backfill and is returned as-is. An undecryptable or unparseable envelope
 * returns `null` — the same thing every reader here already treats as "this
 * message has no activity log" — because there is no partial JSON to hand back
 * and a throw would take the whole read path down.
 */
export function decryptJsonField(stored: unknown): unknown {
  if (!isEncryptedJsonField(stored)) return stored;
  const plain = safeDecrypt(stored.enc, "json column decrypt failed");
  if (plain === FIELD_DECRYPT_PLACEHOLDER) return null;
  try {
    return JSON.parse(plain) as unknown;
  } catch (err) {
    recordFailure("json column parse failed after decrypt", stored.enc, err);
    return null;
  }
}
