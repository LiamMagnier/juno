/**
 * One place that says how big a request may be.
 *
 * The chat body accepted an unbounded `message` string — the schema said so in
 * a comment ("No character cap — model context is the only real limit"). Model
 * context is not the limit that matters first: a multi-megabyte paste is
 * decrypted, embedded, tokenised, moderated and written to Postgres long before
 * any provider rejects it, and the failure it eventually produces is a 500
 * rather than something the client can act on.
 *
 * Shared by web and native through one module so the client stops a paste at
 * the same size the server refuses it, instead of each guessing.
 *
 * Deliberately free of `server-only` and framework imports: the native contract
 * generator and the tests both read it.
 */

/** Hard ceiling on a decoded JSON request body. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Longest single message accepted inline, in characters and in UTF-8 bytes.
 *
 * Both, because they diverge: 200k characters of English is ~200 KB, while
 * 200k characters of Japanese is ~600 KB — the same length costing three times
 * the storage, bandwidth and tokens.
 *
 * The byte figure has to be below `MAX_MESSAGE_CHARS × 3` or it can never
 * bind. A UTF-16 code unit encodes to at most 3 UTF-8 bytes (astral characters
 * cost 4 bytes but occupy 2 units, so 2 bytes per unit), which puts the
 * worst case for 200k units at 600 KB. A byte cap above that is decoration.
 */
export const MAX_MESSAGE_CHARS = 200_000;
export const MAX_MESSAGE_BYTES = 400_000;

/**
 * Above this, the client is told to send the text as a file instead. Below the
 * hard cap, so there is a band where the answer is "attach it" rather than
 * "too big" — a recoverable instruction rather than a refusal.
 */
export const LONG_PASTE_ATTACH_THRESHOLD_CHARS = 100_000;

/** Longest text extracted from any one uploaded file. */
export const MAX_FILE_EXTRACTION_CHARS = 400_000;

/** Ceiling on everything assembled into one turn's prompt. */
export const MAX_ASSEMBLED_CONTEXT_CHARS = 1_500_000;

/** Private-mode history is client-supplied, so it is bounded independently. */
export const MAX_PRIVATE_HISTORY_ENTRIES = 100;
export const MAX_PRIVATE_HISTORY_CHARS = 600_000;

export type RequestLimitCode =
  | "body_too_large"
  | "message_too_long"
  | "message_should_be_attached"
  | "history_too_large"
  | "context_too_large";

export interface RequestLimitViolation {
  code: RequestLimitCode;
  /** 413 for "too big, full stop"; 422 for "too big *like this*, resend it differently". */
  status: 413 | 422;
  message: string;
  limit: number;
  actual: number;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Checks a raw body before it is parsed, so an 8 MB paste is never JSON.parse'd. */
export function checkBodyBytes(byteLength: number): RequestLimitViolation | null {
  if (byteLength <= MAX_REQUEST_BODY_BYTES) return null;
  return {
    code: "body_too_large",
    status: 413,
    message: `Request body is ${byteLength} bytes; the limit is ${MAX_REQUEST_BODY_BYTES}.`,
    limit: MAX_REQUEST_BODY_BYTES,
    actual: byteLength,
  };
}

/**
 * Checks one inline message.
 *
 * Order matters: the recoverable answer is offered before the flat refusal, so
 * a long paste is told to become a file rather than simply rejected.
 */
export function checkMessageSize(message: string): RequestLimitViolation | null {
  const chars = message.length;
  const bytes = utf8Bytes(message);

  if (chars > MAX_MESSAGE_CHARS) {
    return {
      code: "message_too_long",
      status: 413,
      message: `Message is ${chars} characters; the limit is ${MAX_MESSAGE_CHARS}. Send it as a file attachment.`,
      limit: MAX_MESSAGE_CHARS,
      actual: chars,
    };
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      code: "message_too_long",
      status: 413,
      message: `Message is ${bytes} bytes; the limit is ${MAX_MESSAGE_BYTES}. Send it as a file attachment.`,
      limit: MAX_MESSAGE_BYTES,
      actual: bytes,
    };
  }
  if (chars > LONG_PASTE_ATTACH_THRESHOLD_CHARS) {
    return {
      code: "message_should_be_attached",
      status: 422,
      message:
        `Message is ${chars} characters. Attach it as a file instead — the same text as an ` +
        "attachment is extracted, chunked and cited, which a single inline paste is not.",
      limit: LONG_PASTE_ATTACH_THRESHOLD_CHARS,
      actual: chars,
    };
  }
  return null;
}

export function checkPrivateHistory(
  entries: readonly { content: string }[]
): RequestLimitViolation | null {
  if (entries.length > MAX_PRIVATE_HISTORY_ENTRIES) {
    return {
      code: "history_too_large",
      status: 413,
      message: `Private history has ${entries.length} entries; the limit is ${MAX_PRIVATE_HISTORY_ENTRIES}.`,
      limit: MAX_PRIVATE_HISTORY_ENTRIES,
      actual: entries.length,
    };
  }
  const total = entries.reduce((sum, entry) => sum + entry.content.length, 0);
  if (total > MAX_PRIVATE_HISTORY_CHARS) {
    return {
      code: "history_too_large",
      status: 413,
      message: `Private history is ${total} characters; the limit is ${MAX_PRIVATE_HISTORY_CHARS}.`,
      limit: MAX_PRIVATE_HISTORY_CHARS,
      actual: total,
    };
  }
  return null;
}

/** Last gate before a provider call, covering everything assembled together. */
export function checkAssembledContext(totalChars: number): RequestLimitViolation | null {
  if (totalChars <= MAX_ASSEMBLED_CONTEXT_CHARS) return null;
  return {
    code: "context_too_large",
    status: 413,
    message: `Assembled context is ${totalChars} characters; the limit is ${MAX_ASSEMBLED_CONTEXT_CHARS}.`,
    limit: MAX_ASSEMBLED_CONTEXT_CHARS,
    actual: totalChars,
  };
}

/**
 * The JSON body returned for a violation.
 *
 * Machine-readable `code` and `limit` so a client can react — offer "attach as
 * file", trim, or split — rather than parsing an English sentence. Carries no
 * fragment of the offending content.
 */
export function limitErrorBody(violation: RequestLimitViolation): {
  error: string;
  code: RequestLimitCode;
  limit: number;
  actual: number;
} {
  return {
    error: violation.message,
    code: violation.code,
    limit: violation.limit,
    actual: violation.actual,
  };
}
