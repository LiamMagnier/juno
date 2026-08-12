/**
 * `juno://` deep links.
 *
 * A deep link is the only input to this application that arrives from a remote
 * origin with no prior IPC, no session, and no user gesture inside the app. The
 * browser hands macOS a string, macOS hands it to us, and the string was
 * authored by whatever page the user was on. It is treated accordingly: parsed
 * against a closed allowlist of hosts and paths, every parameter validated with
 * Zod for both shape *and* character class, and anything unrecognised dropped
 * with a log line rather than passed along "just in case".
 *
 * ## Why this is strict to the point of pedantry
 *
 * The primary consumer is the OAuth callback. An authorization `code` from a
 * deep link is about to be exchanged for a session token, so a link that can
 * smuggle an arbitrary string through this parser is a link that can steer that
 * exchange. Rejecting unknown query parameters is what stops
 * `juno://auth/callback?code=x&state=y&redirect_uri=https://evil.example` from
 * relying on some later component reading a field this one never inspected.
 *
 * ## The allowlist, in full
 *
 *   juno://auth/callback?code=…&state=…      → an OAuth success callback
 *   juno://auth/callback?error=…             → an OAuth failure callback
 *   juno://open/chat/<id>                    → focus a conversation
 *   juno://open/work/<id>                    → focus a work task
 *   juno://open/code/<id>                    → focus a code session
 *
 * Nothing else parses. In particular `juno://app/...` — the origin the renderer
 * itself is served from — is rejected outright, so a link cannot be used to
 * reach the protocol handler's file-serving path from outside the app.
 *
 * ## Registration timing
 *
 * `open-url` must be subscribed *before* `app.whenReady()`. macOS delivers the
 * launch URL early, and an app that subscribes inside the ready handler loses
 * the very link that started it — which is exactly the sign-in case, every
 * time, on a cold start. `installDeepLinkListeners` therefore does nothing but
 * subscribe and queue; `startDeepLinkDelivery` drains the queue once main has
 * subsystems capable of acting on a link.
 */

import { app } from 'electron';
import { z } from 'zod';
import { createLogger } from './logger.js';
import { APP_SCHEME, redactUrl } from './security.js';

const log = createLogger('app');

/* -------------------------------------------------------------------------- */
/* Grammar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Beyond this, the link is not a link we sent. Bounded before parsing so a
 * multi-megabyte argv entry cannot be handed to the URL parser or the logger.
 */
const MAX_URL_LENGTH = 2_048;
/** More than this many query parameters means it is not one of ours. */
const MAX_QUERY_PARAMS = 8;

/**
 * The character set an authorization code or state nonce is drawn from: RFC
 * 3986 unreserved, plus `%` and the base64 alphabet (`+`, `/`, `=`) that real
 * authorization servers emit. `&` is deliberately absent — it is the one
 * character that could re-split a value if anything downstream ever re-parses
 * a reconstructed query string.
 *
 * Deliberately *not* `z.string()`: the value ends up in an HTTP request body
 * and in log lines, and a character class is the cheapest way to guarantee it
 * can carry neither a control character nor a delimiter into either.
 */
const OpaqueTokenSchema = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[A-Za-z0-9._~%+/=-]+$/, 'unexpected characters');

/**
 * An OAuth error code is a short, lowercase, underscore-separated identifier
 * (RFC 6749 §4.1.2.1). The human-readable description is free text from a
 * remote server, so it is length-capped and stripped of control characters —
 * it will be shown to the user, and a description containing newlines is a
 * description that can forge the rest of a dialog.
 */
const OAuthErrorCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'unexpected error code');

const OAuthErrorDescriptionSchema = z
  .string()
  .max(300)
  .regex(/^[^\p{Cc}]*$/u, 'control characters in description');

/** Ids we mint: cuid/uuid-shaped. */
const EntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'unexpected characters in id');

const SurfaceSchema = z.enum(['chat', 'work', 'code']);

/**
 * The auth callback's query string.
 *
 * `iss` is permitted because RFC 9207 authorization servers append it and
 * omitting it would break sign-in against a compliant provider. Everything not
 * listed is a parse failure — `z.strictObject` rather than `z.object`, which is
 * the whole point of validating this at all.
 */
const AuthCallbackQuerySchema = z
  .strictObject({
    code: OpaqueTokenSchema.optional(),
    state: OpaqueTokenSchema.optional(),
    iss: z.string().max(256).optional(),
    error: OAuthErrorCodeSchema.optional(),
    error_description: OAuthErrorDescriptionSchema.optional(),
    error_uri: z.string().max(512).optional(),
  })
  .refine(
    (value) => value.error !== undefined || (value.code !== undefined && value.state !== undefined),
    { message: 'callback carried neither an error nor a code/state pair' },
  );

/* -------------------------------------------------------------------------- */
/* Parsed shapes                                                               */
/* -------------------------------------------------------------------------- */

export type DeepLink =
  | {
      readonly kind: 'auth-callback';
      readonly code: string;
      readonly state: string;
      /**
       * A canonical callback URL, **rebuilt from the two validated fields** —
       * never the string that arrived.
       *
       * The auth controller's `completeSignIn` takes a URL, and handing it the
       * raw input would quietly undo this module's entire purpose: every
       * parameter that `strictObject` just rejected would ride along inside the
       * string and be re-parsed by whoever consumes it. Re-serialising from
       * `code` and `state` means the URL cannot contain anything that did not
       * pass validation, while still giving the consumer the shape it wants.
       */
      readonly url: string;
    }
  | {
      readonly kind: 'auth-error';
      readonly error: string;
      readonly description: string | null;
    }
  | {
      readonly kind: 'open';
      readonly surface: z.infer<typeof SurfaceSchema>;
      readonly id: string;
    };

export type DeepLinkParse =
  | { readonly ok: true; readonly link: DeepLink }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse one candidate URL. Pure — no Electron, no side effects — so the whole
 * allowlist can be exercised from a unit test, including the rejections, which
 * are the cases worth testing.
 */
export function parseDeepLink(candidate: string): DeepLinkParse {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { ok: false, reason: 'empty input' };
  }
  if (candidate.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'url too long' };
  }
  if (/[\p{Cc}]/u.test(candidate)) {
    return { ok: false, reason: 'control characters in url' };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'unparseable url' };
  }

  if (url.protocol !== `${APP_SCHEME}:`) {
    return { ok: false, reason: `unexpected scheme ${url.protocol}` };
  }

  /* `juno://app` is the renderer's own origin. A deep link must never address
     it: the protocol handler serves files from there, and letting an external
     link name that host blurs the boundary between "content we serve" and
     "instruction we received". */
  if (url.host === 'app') {
    return { ok: false, reason: 'the app origin is not a deep-link target' };
  }

  /* A userinfo component (`juno://user:pass@auth/callback`) is a classic way to
     make a link's true host hard to read. We have no use for one. */
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo is not permitted' };
  }
  if (url.port !== '') {
    return { ok: false, reason: 'port is not permitted' };
  }

  const params = [...url.searchParams.keys()];
  if (params.length > MAX_QUERY_PARAMS) {
    return { ok: false, reason: 'too many query parameters' };
  }
  /* Repeated keys (`?code=good&code=evil`) are ambiguous: `searchParams.get`
     returns the first, other parsers take the last. Rather than pick, refuse. */
  if (new Set(params).size !== params.length) {
    return { ok: false, reason: 'repeated query parameters' };
  }

  switch (url.hostname) {
    case 'auth':
      return parseAuthLink(url);
    case 'open':
      return parseOpenLink(url);
    default:
      return { ok: false, reason: `unknown host ${url.hostname}` };
  }
}

function parseAuthLink(url: URL): DeepLinkParse {
  if (url.pathname !== '/callback') {
    return { ok: false, reason: `unknown auth path ${url.pathname}` };
  }

  const query = AuthCallbackQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!query.success) {
    return { ok: false, reason: `invalid auth callback: ${z.prettifyError(query.error)}` };
  }

  const value = query.data;
  if (value.error !== undefined) {
    return {
      ok: true,
      link: {
        kind: 'auth-error',
        error: value.error,
        description: value.error_description ?? null,
      },
    };
  }

  /* The refinement guarantees both are present in this branch; the explicit
     check is what makes that guarantee legible to the type system rather than
     asserted with a non-null assertion. */
  if (value.code === undefined || value.state === undefined) {
    return { ok: false, reason: 'auth callback missing code or state' };
  }

  return {
    ok: true,
    link: {
      kind: 'auth-callback',
      code: value.code,
      state: value.state,
      url: canonicalCallbackUrl(value.code, value.state),
    },
  };
}

/**
 * Rebuild `juno://auth/callback?code=…&state=…` from validated parts.
 *
 * `searchParams.set` re-encodes, and because the values were read through
 * `searchParams.get` (which decodes) the round trip is exact: a `%` that
 * survived validation came from a `%25` and goes back out as one.
 */
function canonicalCallbackUrl(code: string, state: string): string {
  const url = new URL(`${APP_SCHEME}://auth/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}

function parseOpenLink(url: URL): DeepLinkParse {
  if (url.searchParams.size > 0) {
    return { ok: false, reason: 'open links take no query parameters' };
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return { ok: false, reason: `unknown open path ${url.pathname}` };
  }

  const [rawSurface, rawId] = segments;
  const surface = SurfaceSchema.safeParse(rawSurface);
  if (!surface.success) {
    return { ok: false, reason: `unknown surface ${String(rawSurface)}` };
  }

  /* Decoded before validating, so `%2e%2e` cannot slip an id past the character
     class and reach a consumer that decodes later. */
  let decodedId: string;
  try {
    decodedId = decodeURIComponent(rawId ?? '');
  } catch {
    return { ok: false, reason: 'malformed percent-encoding in id' };
  }

  const id = EntityIdSchema.safeParse(decodedId);
  if (!id.success) {
    return { ok: false, reason: 'invalid id' };
  }

  return { ok: true, link: { kind: 'open', surface: surface.data, id: id.data } };
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

export interface DeepLinkDelivery {
  /** Invoked once per valid link, in arrival order. */
  readonly handle: (link: DeepLink) => void | Promise<void>;
  /**
   * Invoked whenever the OS asks us to come forward — a `juno://` link or a
   * second launch — regardless of whether the link itself validated. The user
   * clicked something and expects a window, even if the link was junk.
   */
  readonly foreground?: () => void;
}

/** Bounded, so a flood of links before delivery starts cannot grow the heap. */
const MAX_QUEUED_LINKS = 16;

const queue: string[] = [];
let delivery: DeepLinkDelivery | null = null;
let listenersInstalled = false;

/**
 * Subscribe to the OS. Call this at the top of main, **before** `whenReady`.
 *
 * Registering the scheme with Launch Services is gated on being packaged: an
 * unpackaged dev run would register the generic Electron binary as the system
 * handler for `juno://`, which hijacks the scheme for every future build and
 * survives long after the dev session ends. Set `JUNO_REGISTER_PROTOCOL=1` to
 * opt in deliberately when testing the flow locally.
 */
export function installDeepLinkListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  if (app.isPackaged || process.env['JUNO_REGISTER_PROTOCOL'] === '1') {
    const registered = app.setAsDefaultProtocolClient(APP_SCHEME);
    log.info('registered as the default handler for the app scheme', {
      scheme: APP_SCHEME,
      registered,
    });
  } else {
    log.info(
      'skipping juno:// scheme registration in an unpackaged build; set JUNO_REGISTER_PROTOCOL=1 to opt in',
    );
  }

  /* macOS: the browser hands the URL straight to the running (or launching)
     app. `preventDefault` because the default behaviour on some platforms is
     to treat the URL as a file to open. */
  app.on('open-url', (event, url) => {
    event.preventDefault();
    accept(url, 'open-url');
  });

  /* Windows/Linux, and macOS when a second copy is launched from a terminal:
     the URL arrives as a command-line argument to the *second* instance, which
     `security.ts`'s single-instance lock has already stopped from starting.
     Without this handler the click silently does nothing. */
  app.on('second-instance', (_event, argv) => {
    delivery?.foreground?.();
    const url = findSchemeArgument(argv);
    if (url !== null) accept(url, 'second-instance');
  });

  /* The cold-start argv case: launched *by* a link on a platform that passes it
     on the command line. Harmless on macOS, where argv carries no URL. */
  const initial = findSchemeArgument(process.argv);
  if (initial !== null) accept(initial, 'argv');
}

/**
 * Begin (or resume) delivering links. Returns a disposer.
 *
 * Anything that arrived before this point was queued rather than dropped —
 * `open-url` on a cold start fires long before auth or the window exist.
 */
export function startDeepLinkDelivery(target: DeepLinkDelivery): () => void {
  delivery = target;
  drain();
  return () => {
    if (delivery === target) delivery = null;
  };
}

function findSchemeArgument(argv: readonly string[]): string | null {
  const prefix = `${APP_SCHEME}://`;
  for (const argument of argv) {
    if (argument.slice(0, prefix.length).toLowerCase() === prefix) return argument;
  }
  return null;
}

function accept(candidate: string, source: string): void {
  delivery?.foreground?.();

  const parsed = parseDeepLink(candidate);
  if (!parsed.ok) {
    /* Logged with the URL's path only. A rejected auth callback still contains
       a code in its query string, and a log file is exactly where that must not
       end up — `redactUrl` drops the query and fragment. */
    log.warn('rejected deep link', {
      source,
      url: redactUrl(candidate),
      reason: parsed.reason,
    });
    return;
  }

  log.info('accepted deep link', { source, kind: parsed.link.kind });

  if (delivery === null) {
    if (queue.length >= MAX_QUEUED_LINKS) {
      queue.shift();
      log.warn('deep-link queue full; dropped the oldest pending link');
    }
    queue.push(candidate);
    return;
  }

  dispatch(parsed.link);
}

function drain(): void {
  if (delivery === null) return;
  const pending = queue.splice(0, queue.length);
  for (const candidate of pending) {
    const parsed = parseDeepLink(candidate);
    if (parsed.ok) dispatch(parsed.link);
  }
}

function dispatch(link: DeepLink): void {
  const target = delivery;
  if (target === null) return;
  try {
    const result = target.handle(link);
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        log.error('deep-link handler rejected', { kind: link.kind, error });
      });
    }
  } catch (error) {
    log.error('deep-link handler threw', { kind: link.kind, error });
  }
}
