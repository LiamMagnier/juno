/**
 * HTTP Range header parsing (RFC 7233 §2.1), for `GET /api/files`.
 *
 * Deliberately dependency-free and free of `server-only` so it can be unit
 * tested — the storage layer it serves cannot be imported under `tsx --test`.
 *
 * Only a single byte range is supported. A multi-range request is reported as
 * `none`, which makes the caller serve the whole object with 200 — the response
 * RFC 7233 explicitly permits when a server chooses not to support multipart
 * ranges, and what this route did before.
 */

export type ParsedRange =
  /** No range asked for (or one we decline to honour) — serve the whole object. */
  | { kind: "none" }
  /** Inclusive byte offsets, already clamped to the object. */
  | { kind: "satisfiable"; start: number; end: number }
  /** Asked for bytes that do not exist — answer 416. */
  | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * @param header raw `Range` header value, or null
 * @param total  the object's full size in bytes
 */
export function parseRangeHeader(header: string | null | undefined, total: number): ParsedRange {
  if (!header) return { kind: "none" };

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: "none" };

  const [, rawStart, rawEnd] = match;
  // "bytes=-" is neither a suffix range nor a normal one.
  if (rawStart === "" && rawEnd === "") return { kind: "none" };

  // A zero-length object can satisfy no range at all.
  if (total <= 0) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: `bytes=-500` means the LAST 500 bytes, not the first 501.
    // Getting this wrong breaks Safari, which uses a suffix range to find the
    // moov atom of an mp4 that was not written faststart.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isFinite(start) || start >= total) return { kind: "unsatisfiable" };
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (!Number.isFinite(end)) end = total - 1;
    // A client may ask past the end; the RFC says clamp rather than reject.
    if (end >= total) end = total - 1;
    if (end < start) return { kind: "unsatisfiable" };
  }

  return { kind: "satisfiable", start, end };
}

/** `Content-Range` value for a 206. */
export function contentRangeHeader(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}

/** `Content-Range` value for a 416. */
export function unsatisfiedRangeHeader(total: number): string {
  return `bytes */${total}`;
}
