/**
 * Attachments: the two ways bytes get into a conversation, and the one way
 * they get back out.
 *
 * ## The renderer has no filesystem, and never learns a path
 *
 * Both inbound paths are built so that the renderer cannot name a file and have
 * it read:
 *
 * - **The picker** (`chat:pick-attachments`) is an *intent*. The renderer sends
 *   `{conversationId, accept}` and nothing else. Main opens the native dialog,
 *   and the person choosing the file is the authorisation. What comes back is a
 *   finished `Attachment` whose `fileName` is a **basename** — the directory
 *   the file came from is never serialized, never logged, and never reaches the
 *   renderer. That is the whole point of putting the dialog in main rather than
 *   exposing a "read this path" channel.
 * - **The drop** (`chat:receive-dropped-files`) carries **bytes, not paths**.
 *   The contract is explicit about this (`DroppedFileSchema` is
 *   `{fileName, mimeType, size, data: base64}`): the renderer reads the drop
 *   through the DOM `File` API, which is a web capability that yields bytes
 *   without a path, and hands main the bytes. So there is no path to validate
 *   on this channel — the checks below are on the bytes instead, which is the
 *   same guarantee in the shape the contract actually uses. A `File.path`-style
 *   channel would have been the thing to distrust, and it does not exist.
 *
 * ## What is validated, and why each check earns its place
 *
 * - **Count.** At most `MAX_ATTACHMENTS`, matching `MAX_ATTACHMENTS` in the
 *   backend's `src/lib/uploads.ts`. Refusing locally means a drop of 40 files
 *   does not become 40 uploads that the chat route then rejects.
 * - **Size.** At most `MAX_UPLOAD_BYTES`, and an empty file is refused. The
 *   authoritative cap is per-plan and server-side (5 MB on Free, 1 GB for the
 *   owner), so this is a sanity ceiling, not a policy: a file that passes here
 *   can still be refused with a 413, and that refusal is reported per-file.
 * - **Declared size must equal decoded length.** The size is what the composer
 *   already showed the person. A mismatch means the file changed under the read
 *   or the payload was rewritten in transit; either way the chip on screen is
 *   describing something other than what would be uploaded.
 * - **Base64 must be base64.** `Buffer.from(x, 'base64')` silently discards
 *   anything it does not recognise, so a corrupted payload would otherwise
 *   upload as a shorter, valid-looking file.
 * - **`stat` must succeed and must report a regular file.** A directory, a
 *   socket, a dangling symlink or a path that vanished between the dialog
 *   closing and the read are all refused rather than guessed at.
 *
 * ## Outbound: why an attachment URL is rewritten
 *
 * The backend serves attachments from `/api/files/<key>` (bearer-authenticated)
 * or from a pre-signed object URL. Neither can be rendered by the app: the CSP
 * is `img-src 'self' data: blob:` and there is no proxy for a remote origin. So
 * an image's bytes are inlined as a `data:` URI — from the local bytes when we
 * just uploaded them (no second round trip), and by fetching otherwise. It is
 * bounded three ways (per-image, per-response, and by image count) because a
 * long transcript full of photographs is the case that would otherwise put a
 * hundred megabytes through a structured clone.
 */

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentUploadResponseSchema, toAttachment, type WireAttachment } from './wire.js';
import type { RawJunoClient } from './http.js';
import type { Attachment } from '../../shared/contracts/chat.js';
import { ChatServiceError } from './errors.js';

/** Matches `MAX_ATTACHMENTS` in the backend's `src/lib/uploads.ts`. */
export const MAX_ATTACHMENTS = 10;

/** Client-side sanity ceiling. The real, plan-scoped limit is enforced server-side. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The largest image that will be turned into a `data:` URI. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Total `data:` payload one IPC reply may carry. */
export const MAX_INLINE_TOTAL_BYTES = 24 * 1024 * 1024;

/** Images inlined per reply, whatever their size. */
export const MAX_INLINE_IMAGES = 24;

/** Extensions offered by the native dialog. Mirrors what the backend stores inline. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const DOCUMENT_EXTENSIONS = [
  'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'docx', 'xlsx', 'pptx', 'rtf', 'html', 'log',
];

/** One file the service refused, with the sentence the composer shows. */
export interface RejectedFile {
  readonly fileName: string;
  readonly reason: string;
}

/** Bytes plus the metadata needed to upload and to inline them. */
export interface PreparedFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* Validation — pure                                                           */
/* -------------------------------------------------------------------------- */

/** Strict, because `Buffer.from` is not: it drops what it cannot read. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export type DecodeResult =
  | { readonly ok: true; readonly file: PreparedFile }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode one dropped file.
 *
 * A `data:` prefix is tolerated because a renderer that used `FileReader`'s
 * `readAsDataURL` rather than `arrayBuffer` produces one, and silently
 * uploading the literal string `data:image/png;base64,…` as file content is a
 * failure nobody would find quickly.
 */
export function decodeDroppedFile(input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly data: string;
}): DecodeResult {
  const fileName = safeFileName(input.fileName);
  if (fileName.length === 0) return { ok: false, reason: 'That file has no usable name.' };

  if (!Number.isFinite(input.size) || input.size < 0) {
    return { ok: false, reason: 'That file reported an impossible size.' };
  }
  if (input.size === 0) return { ok: false, reason: 'That file is empty.' };
  if (input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `That file is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.` };
  }

  const comma = input.data.startsWith('data:') ? input.data.indexOf(',') : -1;
  const encoded = (comma === -1 ? input.data : input.data.slice(comma + 1)).replace(/\s+/gu, '');
  if (!BASE64.test(encoded)) {
    return { ok: false, reason: 'That file could not be read — its contents were not valid base64.' };
  }

  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (bytes.byteLength === 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes.byteLength !== input.size) {
    return {
      ok: false,
      reason: 'That file changed while it was being read. Try adding it again.',
    };
  }

  return {
    ok: true,
    file: { fileName, mimeType: normalizeMime(input.mimeType), bytes },
  };
}

/**
 * A basename with no separators, no traversal and no control characters.
 *
 * Applied to both paths. The dialog's own path is trusted to exist but not to
 * be *safe to echo*: the directory is the user's private information and the
 * renderer has no use for it.
 */
export function safeFileName(candidate: string): string {
  const cleaned = basename(candidate)
    /* eslint-disable-next-line no-control-regex --
       Matching control characters is the point of this expression. A NUL
       truncates the name at a C string boundary further down, and a CR or LF
       is a header-injection primitive in the multipart part this name ends up
       in. The bidi overrides go with them: they are how a filename lies about
       its own extension in a UI. */
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  if (cleaned === '.' || cleaned === '..') return '';
  return cleaned.slice(0, 200);
}

function normalizeMime(candidate: string): string {
  const trimmed = candidate.split(';')[0]?.trim().toLowerCase() ?? '';
  if (trimmed.length === 0 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(trimmed)) {
    return 'application/octet-stream';
  }
  return trimmed;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/* -------------------------------------------------------------------------- */
/* The native picker                                                           */
/* -------------------------------------------------------------------------- */

export interface AttachmentPicker {
  /** Absolute paths chosen by the person, or an empty list when cancelled. */
  pick(accept: 'all' | 'image'): Promise<readonly string[]>;
}

/**
 * The real dialog, loaded lazily.
 *
 * `import('electron')` rather than a top-level import so that everything else in
 * this directory — the parser, the mappings, the validation above — stays
 * importable from a plain Vitest process with no Electron runtime. The same
 * trick `session.ts` uses for `openExternal`, for the same reason.
 */
export const nativeAttachmentPicker: AttachmentPicker = {
  async pick(accept) {
    const { dialog, BrowserWindow } = await import('electron');
    const filters =
      accept === 'image'
        ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
        : [
            { name: 'Images', extensions: IMAGE_EXTENSIONS },
            { name: 'Documents', extensions: DOCUMENT_EXTENSIONS },
            { name: 'All files', extensions: ['*'] },
          ];

    const parent = BrowserWindow.getFocusedWindow();
    const options = {
      properties: ['openFile', 'multiSelections'] as const,
      filters,
      message: 'Choose files to attach',
    };
    const result =
      parent === null
        ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });

    return result.canceled ? [] : result.filePaths;
  },
};

/**
 * Read one chosen path into bytes.
 *
 * The path never appears in the result or in a thrown message — only the
 * basename does. A refusal names the file the person picked, which is what they
 * need to know, and not where it lives.
 */
export async function readPickedFile(path: string): Promise<DecodeResult> {
  const fileName = safeFileName(path);
  if (fileName.length === 0) return { ok: false, reason: 'That file has no usable name.' };

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, reason: `${fileName} is not a file.` };
    size = info.size;
  } catch {
    /* Refuse anything that cannot be stat'ed: a dangling symlink, a path that
       vanished while the dialog was open, a volume that ejected. */
    return { ok: false, reason: `${fileName} could not be read.` };
  }

  if (size === 0) return { ok: false, reason: `${fileName} is empty.` };
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `${fileName} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.` };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return { ok: false, reason: `${fileName} could not be read.` };
  }
  if (bytes.byteLength === 0) return { ok: false, reason: `${fileName} is empty.` };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `${fileName} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.` };
  }

  return { ok: true, file: { fileName, mimeType: mimeForExtension(fileName), bytes } };
}

/**
 * A guess from the extension, and only a guess.
 *
 * The server never trusts it: `/api/v1/attachments` identifies images by magic
 * bytes and stores everything else as `application/octet-stream` with an
 * attachment disposition. This value exists so the multipart part has a type
 * at all.
 */
function mimeForExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const extension = dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'md':
    case 'markdown':
    case 'txt':
    case 'log':
      return 'text/plain';
    case 'html':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Upload one prepared file.
 *
 * `/api/v1/attachments` rather than `/api/upload`: both accept a bearer, but
 * only the v1 route answers in the v1 error envelope, which is what
 * `toApiError` decodes into a code, a retryable flag and a request id. The web
 * route's bare `{error: string}` would arrive as an untyped 400.
 *
 * `Idempotency-Key` is a fresh UUID per call. It is deliberately **not** a hash
 * of the bytes: an attachment can be claimed onto exactly one message
 * (`messageId: null` in the claim's WHERE clause), so collapsing two
 * intentional uploads of the same file into one row would make the second
 * message silently lose its file.
 */
export async function uploadAttachment(
  client: RawJunoClient,
  file: PreparedFile,
  conversationId: string | null,
  signal?: AbortSignal,
): Promise<Attachment> {
  const form = new FormData();
  form.append('file', new Blob([toArrayBuffer(file.bytes)], { type: file.mimeType }), file.fileName);
  if (conversationId !== null) form.append('conversationId', conversationId);

  const response = await client.multipart({
    path: '/api/v1/attachments',
    form,
    schema: AttachmentUploadResponseSchema,
    headers: { 'idempotency-key': randomUUID() },
    ...(signal === undefined ? {} : { signal }),
  });

  return withInlineBytes(response.attachment, file.bytes);
}

/**
 * Map an uploaded attachment, inlining the bytes we already hold.
 *
 * The server has just told us what the file actually is (`kind` and `mimeType`
 * come from magic-byte sniffing, not from what we declared), so the `data:` URI
 * is built from the sniffed type — an image the server refused to treat as one
 * does not get rendered as one here either.
 */
function withInlineBytes(wire: WireAttachment, bytes: Uint8Array): Attachment {
  const attachment = toAttachment(wire);
  if (attachment.kind !== 'IMAGE') return attachment;
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) return { ...attachment, url: '' };
  return { ...attachment, url: dataUri(wire.mimeType, bytes) };
}

export function dataUri(mimeType: string, bytes: Uint8Array): string {
  return `data:${normalizeMime(mimeType)};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * A `Blob` part that is unambiguously an `ArrayBuffer`.
 *
 * `Uint8Array` is a valid `BlobPart` at runtime, but a typed array over a
 * pooled buffer (which is what `readFile` returns) carries a byte offset, and
 * copying the exact window here removes any question about which bytes are
 * sent.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/* -------------------------------------------------------------------------- */
/* Inlining stored images                                                      */
/* -------------------------------------------------------------------------- */

/** Bounds one call to `inlineImageUrls`, shared across every message in it. */
export interface InlineBudget {
  remainingBytes: number;
  remainingImages: number;
}

export function newInlineBudget(): InlineBudget {
  return { remainingBytes: MAX_INLINE_TOTAL_BYTES, remainingImages: MAX_INLINE_IMAGES };
}

/**
 * Replace a stored image's backend URL with a renderable `data:` URI.
 *
 * Anything that cannot be inlined — over budget, too large, a failed fetch —
 * becomes `''` rather than the original URL. Handing the renderer a URL it
 * cannot load would render a broken-image glyph; an empty `src` renders the
 * alt text, which at least names the file. Neither is good, and the difference
 * is that one of them looks like a bug in Juno and the other looks like a
 * missing file.
 */
export async function inlineImageUrl(
  client: RawJunoClient,
  url: string,
  budget: InlineBudget,
  signal?: AbortSignal,
): Promise<string> {
  if (url.length === 0 || url.startsWith('data:')) return url;
  if (budget.remainingImages <= 0 || budget.remainingBytes <= 0) return '';

  const limit = Math.min(MAX_INLINE_IMAGE_BYTES, budget.remainingBytes);
  try {
    const { bytes, contentType } = await client.bytes(url, limit, signal);
    budget.remainingImages -= 1;
    budget.remainingBytes -= bytes.byteLength;
    return dataUri(contentType, bytes);
  } catch {
    /* Deliberately swallowed: one unreadable image must not fail the transcript
       it appears in. The reason is not logged because the URL carries a storage
       key that identifies the user's file. */
    return '';
  }
}

/** Raised when a picker chose files and every one of them was refused. */
export function allRefusedError(rejected: readonly RejectedFile[]): ChatServiceError {
  const first = rejected[0];
  if (rejected.length === 1 && first !== undefined) return new ChatServiceError(first.reason, false);
  return new ChatServiceError(
    `None of those ${rejected.length} files could be attached. ${first?.reason ?? ''}`.trim(),
    false,
  );
}
