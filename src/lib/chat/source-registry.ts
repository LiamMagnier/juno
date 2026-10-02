/**
 * The turn's one list of sources.
 *
 * Tool-side numbering (a `web_search` result the model is told to cite as [3])
 * and the persisted `Message.sources` order have to be the same list, or a
 * citation resolves to the wrong page. This registry is that list: every
 * source that reaches the turn — Juno search, a fetched page, provider search,
 * a research corpus — is registered here in order, normalised once (INV-3) and
 * numbered once (SPEC §2.11).
 *
 * Normalisation is not cosmetic. A shipped native build decodes every source
 * of a `sources` frame and of the final message strictly: one empty title, one
 * title with a line break or one relative URL makes it refuse the whole frame,
 * and on `done` that is the whole answer (gap-native D2). So nothing is
 * streamed or persisted that has not been through `normalizeSource`.
 *
 * Pure and client-safe.
 */

import type { ClientSource } from "@/types/chat";
import { CHAT_SOURCE_ORIGINS, type ChatSourceOrigin } from "@/types/run";

/** INV-3 limits, the native decoder's own (`NativeChatAPIClient.decodeSource`). */
export const MAX_SOURCE_TITLE_BYTES = 2_000;
export const MAX_SOURCE_SNIPPET_BYTES = 32 * 1_024;
export const MAX_SOURCE_URL_CHARS = 2_048;
/** At most this many sources ride one `sources` frame (INV-3). */
export const MAX_SOURCES_PER_FRAME = 100;

// ── Text limits, shared with the run record's readers ─────────────────────────

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]+`, "g");

/** Control characters and line breaks become one space; runs of spaces collapse. */
export function singleLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(LINE_SEPARATORS, " ").replace(/\s{2,}/g, " ").trim();
}

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** At most `maxBytes` of UTF-8, cut on a code point boundary. */
export function clampUtf8(value: string, maxBytes: number): string {
  // Every UTF-16 unit is at most 3 bytes, so a short string needs no encode.
  if (value.length * 3 <= maxBytes) return value;
  if (utf8Length(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export function clampChars(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

// ── One source ───────────────────────────────────────────────────────────────

/** Unicode format characters (Cf): soft hyphens, zero-width and bidi marks. */
const FORMAT_CHARS = /\p{Cf}/gu;

/** Printable ASCII only: a URL both WHATWG and Foundation's `URL(string:)` read the same way. */
const PLAIN_URL = /^[\x21-\x7e]+$/;

function hostLabel(url: URL): string {
  return url.hostname.replace(/^www\./, "") || url.hostname;
}

/**
 * INV-3: title non-empty, single line, ≤ 2,000 UTF-8 bytes, falling back to the
 * URL host; `url` absolute http(s) with a host (otherwise the source is
 * dropped: `null`); `snippet` a string ≤ 32 KiB.
 *
 * The URL is kept byte for byte when it is already plain ASCII, so citations,
 * the provenance ledger and old rows keep matching it; one with spaces or
 * non-ASCII text is replaced by its serialised form, which a native build can
 * parse where it could not parse the original.
 */
export function normalizeSource(raw: Partial<ClientSource> & { url: string }): ClientSource | null {
  if (typeof raw?.url !== "string") return null;
  const trimmed = raw.url.trim();
  if (!trimmed || trimmed.length > MAX_SOURCE_URL_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  const url = PLAIN_URL.test(trimmed) ? trimmed : parsed.href;
  if (url.length > MAX_SOURCE_URL_CHARS) return null;

  // Native's `validText` refuses any Unicode control OR format character
  // (`CharacterSet.controlCharacters` is Cc + Cf): a soft hyphen or a bidi mark
  // in one page title would fail the whole frame, so they are dropped here.
  const rawTitle = typeof raw.title === "string" ? raw.title.replace(FORMAT_CHARS, "") : "";
  const title = clampUtf8(singleLine(rawTitle), MAX_SOURCE_TITLE_BYTES).trim();
  const snippet = typeof raw.snippet === "string" ? clampUtf8(raw.snippet, MAX_SOURCE_SNIPPET_BYTES) : "";
  const origin = (CHAT_SOURCE_ORIGINS as readonly string[]).includes(raw.origin as string)
    ? (raw.origin as ChatSourceOrigin)
    : undefined;
  return {
    title: title || hostLabel(parsed),
    url,
    snippet,
    ...(raw.cited === true ? { cited: true } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** Every valid source of a list, normalised, invalid ones dropped. */
export function normalizeSources(list: readonly (Partial<ClientSource> & { url: string })[]): ClientSource[] {
  const out: ClientSource[] = [];
  for (const raw of list) {
    const source = normalizeSource(raw);
    if (source) out.push(source);
  }
  return out;
}

/**
 * The identity two sources share when they are the same page: scheme and host
 * case-folded (`URL` does both), the fragment dropped. Anything else — path,
 * query, a trailing slash the author typed — is kept, because two queries on
 * one host are two different pages.
 */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

export interface RegisteredSource {
  /** 1-based position in the turn's list. */
  n: number;
  source: ClientSource;
}

export class SourceRegistry {
  private readonly list: ClientSource[] = [];
  private readonly positions = new Map<string, number>();
  private added: ClientSource[] = [];

  /** Registers in order, de-duplicating by exact normalised URL. Returns 1-based numbers (existing
   *  numbers for duplicates). `cited` marks the source as numbered for the model; `origin` is
   *  stamped on each new source (the first origin wins for duplicates). A source that cannot be
   *  normalised (no http(s) URL) is not registered and has no number. */
  register(
    list: readonly ClientSource[],
    opts: { cited: boolean; origin?: ChatSourceOrigin },
  ): RegisteredSource[] {
    const out: RegisteredSource[] = [];
    for (const raw of list) {
      const source = normalizeSource(raw);
      if (!source) continue;
      const key = sourceKey(source.url);
      const existing = this.positions.get(key);
      if (existing !== undefined) {
        // A page first seen as "read" and then handed to the model under a
        // number IS numbered now: the model may cite it, so the chip must
        // resolve. The reverse never un-numbers it.
        if ((opts.cited || source.cited) && !this.list[existing].cited) {
          this.list[existing] = { ...this.list[existing], cited: true };
        }
        out.push({ n: existing + 1, source: this.list[existing] });
        continue;
      }
      const origin = opts.origin ?? source.origin;
      const entry: ClientSource = {
        ...source,
        ...(opts.cited || source.cited ? { cited: true } : {}),
        ...(origin ? { origin } : {}),
      };
      this.list.push(entry);
      this.positions.set(key, this.list.length - 1);
      this.added.push(entry);
      out.push({ n: this.list.length, source: entry });
    }
    return out;
  }

  /** Every source so far, in registration order. ≤ 100 per frame is enforced when framing. */
  all(): readonly ClientSource[] {
    return this.list;
  }

  /** The 1-based number of a URL already on the list, if it is. */
  numberOf(url: string): number | undefined {
    const position = this.positions.get(sourceKey(url.trim()));
    return position === undefined ? undefined : position + 1;
  }

  /** Sources added since the last call (for profile-1 visit rows). */
  drainAdded(): ClientSource[] {
    const added = this.added;
    this.added = [];
    return added;
  }
}
