/**
 * The `juno://` scheme: registration, and serving the built renderer from it.
 *
 * ## Why a custom scheme rather than `file://`
 *
 * `security.ts` explains the origin half of this: `file://` origins are opaque,
 * which makes a meaningful CSP awkward and `fetch` semantics strange. The other
 * half is containment. A `file://` renderer can address the entire filesystem by
 * construction — every path is in scope and the only question is whether some
 * other control stops it. Under `juno://` the *only* bytes reachable are the
 * ones this file agrees to hand over, so the reachable set is defined by one
 * function that can be read, reasoned about and tested.
 *
 * That makes `resolveRendererPath` the single highest-risk function in the main
 * process, and it is written accordingly: pure, lexical, exported for tests, and
 * followed by an independent filesystem-level check in the handler.
 *
 * ## The threat
 *
 * A request for `juno://app/../../../../etc/passwd` — or its encoded cousins
 * `%2e%2e`, `%252e%252e`, `..%2f`, a backslash separator, an embedded NUL, an
 * absolute path, or a symlink inside the bundle pointing outward — must return
 * a refusal, not a file. Any renderer-side script injection (see the residual
 * `style-src 'unsafe-inline'` risk in `security.ts`) turns a traversal bug here
 * into arbitrary local file read, and from there into the user's SSH keys.
 *
 * ## The defence, in layers
 *
 *   1. Scheme and host are checked against `APP_ORIGIN`. Nothing else is served.
 *   2. Method is restricted to GET/HEAD.
 *   3. Percent-decoding is done exactly once, and the *decoded* form is then
 *      rejected outright if it contains a `..` segment, a NUL, or a backslash.
 *
 *      This step is the one that earns its keep, and it is worth being precise
 *      about why. Both URL parsers involved already collapse dot segments, so
 *      `juno://app/../../etc/passwd` and `juno://app/%2e%2e/%2e%2e/etc/passwd`
 *      arrive here as the harmless path `/etc/passwd` and simply 404 inside the
 *      root. What they do *not* collapse is an encoded **separator**:
 *      `..%2f..%2fetc/passwd` survives parsing as a single opaque segment,
 *      because `%2F` is deliberately left encoded to preserve the distinction
 *      between a slash and a literal one. Serving files with spaces or
 *      non-ASCII names requires decoding, and the instant you decode, that
 *      single segment becomes `../../etc/passwd`. Decode-then-check is
 *      therefore mandatory, and decode-then-resolve without checking is the
 *      bug. Decoding exactly once — not in a loop — matters too: the filesystem
 *      interprets the once-decoded name, so validating a twice-decoded string
 *      would be validating something other than what gets opened.
 *   4. Leading separators are stripped before joining, because
 *      `path.resolve(root, '/etc/passwd')` returns `/etc/passwd` — the absolute
 *      second argument wins. This is the classic way this bug ships.
 *   5. The resolved path is checked for containment with `path.relative`:
 *      rejected if the relative path is `..`, starts with `../`, or is absolute.
 *   6. The path is then `realpath`-ed and the containment check is repeated
 *      against the realpath-ed root, which is what closes the symlink hole that
 *      every purely lexical check leaves open.
 *   7. Only regular files are served. Directories 404 rather than listing.
 *
 * Layers 5 and 6 are independently sufficient. Layer 3 exists so that a
 * traversal attempt is *refused* rather than quietly normalised away, which is
 * the difference between a log line that says "someone tried" and silence.
 */

import { net, protocol } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { createLogger } from './logger.js';
import { APP_ORIGIN, APP_SCHEME } from './security.js';

const log = createLogger('app');

/* -------------------------------------------------------------------------- */
/* Scheme registration                                                          */
/* -------------------------------------------------------------------------- */

let schemesRegistered = false;

/**
 * Declare `juno://` privileged. **Must run before `app.whenReady()`.**
 *
 * `standard: true` is the one that does the real work — it gives the scheme
 * normal URL parsing (so `juno://app` is a real, comparable origin rather than
 * an opaque one) and normal web security. `secure: true` puts it in the same
 * bucket as https, so the renderer is a secure context and features gated on
 * that (crypto.subtle, service workers, storage APIs) behave.
 * `supportFetchAPI` and `corsEnabled` let the renderer `fetch` its own assets —
 * which is how Vite's dynamic `import()` chunks and font loading work.
 *
 * `bypassCSP` is deliberately absent: the renderer must remain subject to the
 * policy `security.ts` injects.
 */
export function registerAppProtocolScheme(): void {
  if (schemesRegistered) return;
  schemesRegistered = true;

  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Path resolution — pure, lexical, exported for tests                          */
/* -------------------------------------------------------------------------- */

export type ProtocolResolution =
  | { readonly kind: 'file'; readonly filePath: string }
  | { readonly kind: 'reject'; readonly status: number; readonly reason: string };

/** The document served for the app root and for client-side routes. */
export const INDEX_DOCUMENT = 'index.html';

/**
 * The only host this scheme serves, derived from `APP_ORIGIN` so the two cannot
 * drift.
 *
 * Host is compared rather than origin, and that is not a stylistic choice.
 * `registerSchemesAsPrivileged` makes `juno:` a *standard* scheme in Chromium;
 * it does nothing to Node's WHATWG URL parser, which still treats it as a
 * non-special scheme and therefore reports `url.origin === 'null'` for every
 * `juno://` URL. An `origin === APP_ORIGIN` comparison in the main process is
 * consequently always false — it looks like the strictest possible check and is
 * in fact a check that refuses everything. Comparing `url.host` (not
 * `hostname`, so `juno://app:1234` is rejected on its port) is equivalent and
 * actually works.
 */
const APP_HOST = APP_ORIGIN.slice(`${APP_SCHEME}://`.length);

/**
 * Path segments that must never survive validation, in their decoded form.
 *
 * `\` is rejected rather than treated as a literal filename character. On macOS
 * it *is* a legal filename character, but accepting it means the same request
 * would traverse on Windows, and a security check whose correctness depends on
 * the build target is a check that will eventually be wrong.
 */
function hasUnsafeSegment(decodedPath: string): string | null {
  if (decodedPath.includes('\0')) return 'null byte in path';
  if (decodedPath.includes('\\')) return 'backslash in path';

  for (const segment of decodedPath.split('/')) {
    if (segment === '..') return 'parent-directory segment in path';
  }
  return null;
}

/**
 * Map a `juno://` request URL to an absolute path inside `root`, or refuse.
 *
 * Pure and synchronous — no filesystem access, so it is directly unit-testable
 * with a fabricated root. The handler performs the filesystem-level checks
 * (existence, symlink resolution, file-vs-directory) on top of this result.
 *
 * @param root Absolute path of the renderer dist directory.
 * @param requestUrl The raw `request.url` from `protocol.handle`.
 */
export function resolveRendererPath(root: string, requestUrl: string): ProtocolResolution {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'reject', status: 400, reason: 'unparseable URL' };
  }

  if (url.protocol !== `${APP_SCHEME}:`) {
    return { kind: 'reject', status: 400, reason: `unexpected scheme ${url.protocol}` };
  }

  /* One host. `juno://app.evil.example` and `juno://app:1234` both fail here —
     see the note on `APP_HOST` for why this is a host comparison and not an
     origin comparison. */
  if (url.host !== APP_HOST) {
    return { kind: 'reject', status: 404, reason: `unexpected host ${url.host}` };
  }

  /* Userinfo would let `juno://app@evil.example/x` read as the app host at a
     glance. There is no legitimate use for it in an asset URL. */
  if (url.username !== '' || url.password !== '') {
    return { kind: 'reject', status: 400, reason: 'userinfo is not permitted' };
  }

  const rawPath = url.pathname;

  /* Reject an encoded NUL before decoding: `decodeURIComponent` would turn
     `%00` into a real NUL, and Node's path APIs throw on those in a way that
     produces a confusing 500 rather than an honest refusal. */
  if (/%00/i.test(rawPath)) {
    return { kind: 'reject', status: 400, reason: 'encoded null byte in path' };
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    /* A lone `%` or a truncated escape. Malformed input, not a valid asset. */
    return { kind: 'reject', status: 400, reason: 'malformed percent-encoding' };
  }

  const unsafe = hasUnsafeSegment(decodedPath);
  if (unsafe !== null) {
    return { kind: 'reject', status: 403, reason: unsafe };
  }

  /* `/` and `/some/route/` both mean the app document. */
  const isDirectoryish = decodedPath === '' || decodedPath === '/' || decodedPath.endsWith('/');
  const requestedRelative = isDirectoryish
    ? `${decodedPath.replace(/^\/+/, '')}${INDEX_DOCUMENT}`
    : decodedPath.replace(/^\/+/, '');

  /* Strip leading separators *before* resolving. `path.resolve(root, '/etc/x')`
     ignores `root` entirely and returns `/etc/x`; the containment check below
     would still catch it, but relying on a single check for this is how the
     bug survives a refactor. */
  const resolved = path.resolve(root, requestedRelative);

  if (!isInside(root, resolved)) {
    return { kind: 'reject', status: 403, reason: 'path escapes the renderer root' };
  }

  return { kind: 'file', filePath: resolved };
}

/**
 * Whether `candidate` is `root` itself or lives beneath it.
 *
 * The `..` test is written against `'..' + path.sep` rather than the bare
 * prefix `'..'`, so a legitimately-named file such as `..fontrc` is not
 * misclassified. `path.isAbsolute` covers the case where the two paths share no
 * common root at all, which on Windows means a different drive letter and on
 * POSIX cannot happen — but again, a check that is only correct on one platform
 * is not a check.
 */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true; // the root directory itself
  if (relative === '..') return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Content types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An allowlist, not a lookup with a permissive default.
 *
 * The type is derived here rather than taken from whatever `net.fetch` guesses
 * for a `file://` response, so an unexpected file in the bundle cannot be
 * served as `text/html` and executed as a document. Anything unrecognised is
 * `application/octet-stream`, which combined with the `nosniff` header below
 * means the renderer will refuse to execute it.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
});

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProtocolOptions {
  /**
   * Renderer dist directory. Defaults to `../renderer` relative to the built
   * main bundle, which is where electron-vite puts it (`out/main`, `out/renderer`).
   */
  readonly root?: string;
}

/** `out/main/index.js` → `out/renderer`. */
export function defaultRendererRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'renderer');
}

function refusal(status: number, reason: string): Response {
  return new Response(reason, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Serve the renderer over `juno://`. **Must run after `app.whenReady()`.**
 *
 * Returns the resolved root so the caller can log it and so a misconfigured
 * packaging step is visible at startup rather than as a blank window.
 */
export function registerAppProtocolHandler(options?: ProtocolOptions): string {
  const configuredRoot = path.resolve(options?.root ?? defaultRendererRoot());

  /* Resolved once, at registration. `realpath` on every request would be a
     filesystem round-trip per asset, and the root does not move while the app
     runs. If the root itself is a symlink (a dev checkout on an external
     volume, say) this is the form every containment check must compare
     against — comparing against the unresolved root would reject every request. */
  let realRootPromise: Promise<string> | null = null;
  const resolveRealRoot = (): Promise<string> => {
    realRootPromise ??= realpath(configuredRoot).catch((error: unknown) => {
      log.error('renderer root could not be resolved; juno:// will serve nothing', {
        root: configuredRoot,
        error,
      });
      return configuredRoot;
    });
    return realRootPromise;
  };

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      return await serve(request, configuredRoot, await resolveRealRoot());
    } catch (error) {
      /* A throw here would surface in the renderer as an opaque network
         failure with no trace anywhere. Convert it into a 500 that is logged. */
      log.error('protocol handler threw', { url: request.url, error });
      return refusal(500, 'Internal error.');
    }
  });

  log.info('registered juno:// protocol handler', { root: configuredRoot });
  return configuredRoot;
}

async function serve(request: Request, configuredRoot: string, realRoot: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refusal(405, 'Method not allowed.');
  }

  const resolution = resolveRendererPath(configuredRoot, request.url);
  if (resolution.kind === 'reject') {
    /* Logged at warn, with the reason but without the query string — a rejected
       request is either a bug in the renderer or someone probing, and both are
       worth seeing. `request.url` is redacted by the logger. */
    log.warn('refused juno:// request', {
      url: request.url,
      status: resolution.status,
      reason: resolution.reason,
    });
    return refusal(resolution.status, 'Refused.');
  }

  const direct = await readable(resolution.filePath, realRoot);
  if (direct !== null) return respond(direct);

  /*
   * Single-page-app fallback.
   *
   * A renderer with client-side routes will request `juno://app/code/session-1`
   * on reload, and there is no such file. Serving `index.html` for
   * extension-less paths lets the router take over. It is scoped to
   * extension-less paths on purpose: falling back for `main-a1b2.js` would turn
   * a broken build into a blank screen with an HTML-parsed-as-JS error instead
   * of an honest 404.
   */
  if (path.extname(resolution.filePath) === '') {
    const fallback = await readable(path.join(configuredRoot, INDEX_DOCUMENT), realRoot);
    if (fallback !== null) return respond(fallback);
  }

  log.warn('juno:// asset not found', { url: request.url });
  return refusal(404, 'Not found.');
}

interface ReadableFile {
  readonly realPath: string;
  readonly size: number;
}

/**
 * Filesystem-level validation: the second, independent containment check.
 *
 * `resolveRendererPath` proved the *requested* path is lexically inside the
 * root. This proves the path the OS will actually open is inside it too, which
 * is a different claim whenever a symlink is involved: `out/renderer/keys` may
 * be lexically contained and still point at `~/.ssh`.
 */
async function readable(candidate: string, realRoot: string): Promise<ReadableFile | null> {
  let realPath: string;
  try {
    realPath = await realpath(candidate);
  } catch {
    /* ENOENT for a missing asset, ELOOP for a symlink cycle, EACCES for a file
       we may not read. None of them is something the renderer should learn the
       details of. */
    return null;
  }

  if (!isInside(realRoot, realPath)) {
    log.error('blocked a symlink escaping the renderer root', {
      requested: candidate,
      resolved: realPath,
    });
    return null;
  }

  const info = await stat(realPath).catch(() => null);
  if (info === null || !info.isFile()) return null;

  return { realPath, size: info.size };
}

/**
 * Stream the file back.
 *
 * `net.fetch` reads through Chromium's own file loader rather than through
 * Node, so large assets stream instead of being buffered into main's heap.
 * `bypassCustomProtocolHandlers` stops this internal read from re-entering
 * `protocol.handle` or firing the `webRequest` interceptors that `security.ts`
 * installs — without it, every asset read would pointlessly round-trip through
 * the CSP-injection handler.
 *
 * The response headers are ours, not the file loader's: an explicit
 * `Content-Type` from the allowlist, `nosniff`, and `no-store` so a stale asset
 * cannot survive an app update in Chromium's HTTP cache.
 */
async function respond(file: ReadableFile): Promise<Response> {
  const upstream = await net.fetch(pathToFileURL(file.realPath).toString(), {
    method: 'GET',
    bypassCustomProtocolHandlers: true,
  });

  if (!upstream.ok || upstream.body === null) {
    log.error('file loader returned no body', { status: upstream.status });
    return refusal(500, 'Internal error.');
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(file.realPath),
      'content-length': String(file.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
