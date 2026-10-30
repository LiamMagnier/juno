/**
 * Files moving between an agent's computer and the person
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S5.2 and S5.3): which type a
 * published file is served as, the name an upload is given in the inbox, and
 * how a file that is not text is described to the model.
 *
 * Pure: no `server-only`, no database, no provider. The files route, the
 * artifact download route, the Work runner and the tests all read it.
 */

import type { WorkArtifactKind } from "@/lib/work/domain";

/** Where a person's uploads land on the computer. */
export const COMPUTER_INBOX_DIR = "/home/agent/work/inbox";

/** The largest file the agent may publish as a deliverable (and the files route may download). */
export const COMPUTER_PUBLISH_MAX_BYTES = 25 * 1024 * 1024;

/** The longest name an upload may keep, in characters. */
export const INBOX_NAME_MAX_CHARS = 200;

export interface ComputerFileType {
  /** The extension on the allowlist (lower case, no dot), or null when the name has none on it. */
  extension: string | null;
  mimeType: string;
  /**
   * The artifact kind a published file is filed under. Never `site`, `report`
   * or `spreadsheet`: those are the kinds the web previews inline, and a file
   * from the agent's computer is only ever downloaded. `bundle` is the
   * generic "File" (the apps call it that).
   */
  kind: WorkArtifactKind;
}

/**
 * The publish allowlist (S5.3): the MIME type each extension is served as.
 * Anything else is `application/octet-stream`.
 */
const PUBLISH_TYPES: Readonly<Record<string, { mimeType: string; kind: WorkArtifactKind }>> = {
  pdf: { mimeType: "application/pdf", kind: "pdf" },
  png: { mimeType: "image/png", kind: "image" },
  jpg: { mimeType: "image/jpeg", kind: "image" },
  jpeg: { mimeType: "image/jpeg", kind: "image" },
  gif: { mimeType: "image/gif", kind: "image" },
  webp: { mimeType: "image/webp", kind: "image" },
  csv: { mimeType: "text/csv", kind: "bundle" },
  txt: { mimeType: "text/plain", kind: "bundle" },
  md: { mimeType: "text/markdown", kind: "bundle" },
  json: { mimeType: "application/json", kind: "bundle" },
  html: { mimeType: "text/html", kind: "bundle" },
  docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  xlsx: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "bundle" },
  pptx: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation" },
  zip: { mimeType: "application/zip", kind: "archive" },
};

export const COMPUTER_FILE_FALLBACK_MIME = "application/octet-stream";

/** The extension a name ends in, lower case, without the dot; null for none (or a dotfile's only dot). */
export function fileExtension(name: string): string | null {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** How a published computer file is typed and filed, by its name's extension. */
export function computerFileType(name: string): ComputerFileType {
  const extension = fileExtension(name);
  const known = extension ? PUBLISH_TYPES[extension] : undefined;
  return known
    ? { extension, mimeType: known.mimeType, kind: known.kind }
    : { extension: null, mimeType: COMPUTER_FILE_FALLBACK_MIME, kind: "bundle" };
}

/**
 * The MIME type a stored row may be served with: the value only when it is
 * one the allowlist gives, else octet-stream. A download never trusts a
 * stored column to pick a type a browser would render.
 */
export function servableComputerMime(stored: string | null | undefined): string {
  const value = (stored ?? "").trim().toLowerCase();
  return Object.values(PUBLISH_TYPES).some((entry) => entry.mimeType === value) ? value : COMPUTER_FILE_FALLBACK_MIME;
}

/** The extension the allowlist gives a MIME type (its first, so image/jpeg is jpg), or null. */
export function extensionForComputerMime(mimeType: string): string | null {
  const value = mimeType.trim().toLowerCase();
  for (const [extension, entry] of Object.entries(PUBLISH_TYPES)) {
    if (entry.mimeType === value) return extension;
  }
  return null;
}

/** RFC 5987 percent-encoding for `filename*`. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A title as a file name: no path separators, controls, quotes or reserved characters; at most 150 characters. */
function safeFileName(title: string): string {
  return (
    title
      .normalize("NFC")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f/\\"<>:|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 150)
      .trim() || "file"
  );
}

/**
 * The download name of a published computer file: its title, with the
 * allowlisted extension added when the title does not already end in it.
 * Always `attachment`: a file from the agent's computer is never rendered
 * inline, whatever its type.
 */
export function computerFileDisposition(title: string, mimeType: string): string {
  let name = safeFileName(title);
  const extension = extensionForComputerMime(servableComputerMime(mimeType));
  if (extension && fileExtension(name) !== extension && !(extension === "jpg" && fileExtension(name) === "jpeg")) {
    name = `${name}.${extension}`;
  }
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/\s+/g, " ").trim() || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** The name of a published file's artifact, from the agent's title or the file's own name. */
export function publishedTitle(path: string, title?: string | null): string {
  const given = typeof title === "string" ? safeFileName(title) : "";
  if (given && given !== "file") return given.slice(0, 120);
  return safeFileName(path.split("/").filter(Boolean).pop() ?? "file").slice(0, 120);
}

/** A stable artifact identifier for a published file: letters, digits, dot, dash and underscore. */
export function publishedIdentifier(path: string): string {
  const base = (path.split("/").filter(Boolean).pop() ?? "file").normalize("NFKD");
  const slug = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `computer-${slug || "file"}`;
}

// ---------------------------------------------------------------------------
// Text or not
// ---------------------------------------------------------------------------

/**
 * How many bytes at the end of `bytes` are the start of a UTF-8 character
 * that the read cut off (0 when the last character is whole).
 */
function cutCharacterBytes(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/**
 * Whether these bytes read as text: valid UTF-8 with no NUL. When the read
 * was cut at a limit (`cut`), a character split by the cut is not held
 * against it.
 */
export function isUtf8Text(bytes: Uint8Array, opts: { cut?: boolean } = {}): boolean {
  const end = opts.cut ? bytes.length - cutCharacterBytes(bytes) : bytes.length;
  const body = bytes.subarray(0, end);
  if (body.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/** A byte count for people: "512 bytes", "88 KB", "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export type InboxNameCheck = { ok: true; name: string } | { ok: false; message: string };

/**
 * The name an upload is saved under in ~/work/inbox (S5.2): the last path
 * segment only (a browser may send a full path), NFC, trimmed; no control
 * characters, no leading dot, at most 200 characters. The header carries it
 * percent-encoded (`encodeURIComponent`), since a header holds no UTF-8.
 */
export function inboxFileName(raw: string | null | undefined): InboxNameCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, message: "Choose a file to add." };
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, message: "That file name could not be read. Rename the file and try again." };
  }
  const name = (decoded.split(/[/\\]/).pop() ?? "").normalize("NFC").trim();
  if (!name || name === "." || name === "..") return { ok: false, message: "Choose a file to add." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: "That file name has characters the computer can't use. Rename the file and try again." };
  }
  if (name.startsWith(".")) {
    return { ok: false, message: "Files whose names start with a dot can't be added. Rename the file and try again." };
  }
  if ([...name].length > INBOX_NAME_MAX_CHARS) {
    return { ok: false, message: `That file name is longer than ${INBOX_NAME_MAX_CHARS} characters. Rename the file and try again.` };
  }
  return { ok: true, name };
}

/** `name`, or "name (2).ext", "name (3).ext"… the first that is not taken. */
export function freeInboxName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate) && [...candidate].length <= INBOX_NAME_MAX_CHARS + 8) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}
