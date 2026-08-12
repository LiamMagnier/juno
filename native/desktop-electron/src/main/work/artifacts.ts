/**
 * Downloading a deliverable, without the bytes ever entering the renderer.
 *
 * `GET /api/work/artifacts/[id]/download` answers with the file itself — not
 * JSON — so it cannot go through `JunoTransport`, and it must not go through the
 * renderer either: the renderer's CSP is `connect-src 'self'` and a 100 MB deck
 * marshalled across IPC is a 100 MB copy in a process that has no use for it.
 * Main fetches it, writes it to disk, and hands back a filename.
 *
 * ## The hash is checked twice on purpose
 *
 * The route already refuses to serve bytes whose SHA-256 does not match what was
 * recorded when the deliverable was produced, and publishes the hash it verified
 * against in `X-Juno-Content-Sha256` "for a client that re-checks". This is that
 * client. The second check is not distrust of the server; it is the only thing
 * that covers the wire between them, and a truncated proxy response is exactly
 * the failure that produces a file which opens and is wrong.
 *
 * A mismatch deletes the partial file. A half-written .docx sitting in Downloads
 * under the right name is worse than no file, because it will be opened.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toApiError } from '../auth/transport.js';
import type { BearerFetcher } from './bearer.js';

export type ArtifactDownload =
  | { readonly ok: true; readonly filename: string; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string };

/** Anything above this is refused rather than filling the user's disk silently. */
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface ArtifactDownloaderOptions {
  readonly http: BearerFetcher;
  /** Where files land. `app.getPath('downloads')` in production. */
  directory(): Promise<string>;
  readonly subdirectory?: string;
}

export class ArtifactDownloader {
  readonly #http: BearerFetcher;
  readonly #directory: () => Promise<string>;
  readonly #subdirectory: string;

  constructor(options: ArtifactDownloaderOptions) {
    this.#http = options.http;
    this.#directory = options.directory;
    this.#subdirectory = options.subdirectory ?? 'Juno Work';
  }

  async download(artifactId: string, version: number): Promise<ArtifactDownload> {
    const url = this.#http.url(`/api/work/artifacts/${encodeURIComponent(artifactId)}/download`);
    url.searchParams.set('version', String(version));

    const response = await this.#http.get({
      url,
      accept: '*/*',
      /* Generous: this is a file, not a status poll. */
      timeoutMs: 120_000,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { ok: false, reason: describeDownloadFailure(response.status, parsed) };
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        reason: 'That deliverable is larger than Juno for Mac will download in one go.',
      };
    }

    const filename = filenameFor(response, artifactId, version);
    const directory = path.join(await this.#directory(), this.#subdirectory);
    await mkdir(directory, { recursive: true });
    const absolutePath = path.join(directory, filename);

    const expectedHash = response.headers.get('x-juno-content-sha256');
    const body = response.body;
    if (body === null) return { ok: false, reason: 'Juno returned an empty file.' };

    const hash = createHash('sha256');
    let written = 0;
    let overflowed = false;

    /* Hashed and counted as it streams, so a 100 MB deck is never held in
       memory and the ceiling is enforced against what actually arrives rather
       than against a `Content-Length` a proxy is free to be wrong about. */
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength;
        if (written > MAX_ARTIFACT_BYTES) {
          overflowed = true;
          callback(new Error('artifact_too_large'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(absolutePath),
      );
    } catch {
      await unlink(absolutePath).catch(() => undefined);
      return {
        ok: false,
        reason: overflowed
          ? 'That deliverable is larger than Juno for Mac will download in one go.'
          : 'Juno could not finish downloading that deliverable.',
      };
    }

    if (expectedHash !== null && hash.digest('hex') !== expectedHash) {
      /* Deleted, not kept with a warning: a file that opens and is wrong is the
         one outcome this check exists to prevent. */
      await unlink(absolutePath).catch(() => undefined);
      return {
        ok: false,
        reason:
          'The file that arrived is not the file Juno made — it changed on the way here. Nothing was saved. Try again.',
      };
    }

    return { ok: true, filename, absolutePath };
  }
}

/**
 * The name to save under.
 *
 * From `Content-Disposition`, which the route builds with `attachmentDisposition`
 * from the artifact's own title. Sanitised here anyway: a filename that arrives
 * over the network and is joined onto a directory path is the classic way to
 * write outside it, and `path.basename` plus a separator strip is what stops
 * `../../.zshrc` from being a valid deliverable name.
 */
function filenameFor(response: Response, artifactId: string, version: number): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const extended = /filename\*=UTF-8''([^;\r\n]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);

  let candidate: string | null = null;
  if (extended?.[1] !== undefined) {
    try {
      candidate = decodeURIComponent(extended[1]);
    } catch {
      candidate = null;
    }
  }
  if (candidate === null && plain?.[1] !== undefined) candidate = plain[1];

  const safe = sanitiseFilename(candidate ?? '');
  return safe.length > 0 ? safe : `juno-artifact-${sanitiseFilename(artifactId)}-v${version}`;
}

function sanitiseFilename(raw: string): string {
  const base = path.basename(raw.replace(/[\\/]/g, '_'));
  const stripped = base
    /* eslint-disable-next-line no-control-regex --
       Stripping control characters is the point: a filename is a path segment,
       and a NUL or a newline in one is a truncation primitive. */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    /* A leading dot would write a hidden file the reader cannot find; `..` is
       the traversal `path.basename` above has already defeated. */
    .replace(/^\.+/, '')
    .trim();
  return stripped.slice(0, 200);
}

/** One sentence per failure the route can actually produce. */
function describeDownloadFailure(status: number, body: unknown): string {
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : null;

  switch (code) {
    case 'version_not_found':
      return 'That version of the deliverable no longer exists.';
    case 'bytes_unavailable':
      return 'Juno has the record of this deliverable but not the file itself. Regenerate it.';
    case 'content_hash_mismatch':
      return 'Juno refused to serve this file: the stored bytes are not the ones it recorded when the deliverable was made. Regenerate it.';
    default:
      break;
  }
  if (status === 404) return 'That deliverable is not on your account.';
  if (status === 401) return 'Juno signed this device out. Sign in again to download deliverables.';
  return toApiError(status, body, null).message;
}
