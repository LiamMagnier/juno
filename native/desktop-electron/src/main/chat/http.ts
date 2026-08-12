/**
 * Raw authenticated HTTP for the three things `JunoTransport` structurally
 * cannot do.
 *
 * ## Why this exists, and why it is not a workaround
 *
 * `transport.requestAuthenticated` is the right tool for a JSON request with a
 * JSON reply, and every such call in this service goes through it. It has three
 * hard edges, all of them consequences of its own contract rather than
 * oversights:
 *
 *  1. **It buffers.** `#interpret` calls `response.text()` and Zod-parses the
 *     result. A chat generation is a `text/event-stream` that stays open for
 *     minutes; reading it to completion before returning would deliver the
 *     whole answer at once, which is the opposite of streaming.
 *  2. **It serializes the body as JSON** and sets `content-type:
 *     application/json`. `POST /api/v1/attachments` takes `multipart/form-data`
 *     and reads it with `request.formData()`.
 *  3. **It never exposes a `Response`.** Fetching attachment bytes needs the
 *     body as bytes and the `content-type` header, neither of which survives
 *     `spec.schema.parse`.
 *
 * So this module re-implements the *credential discipline* — not the transport.
 * Every rule that makes `transport.ts` safe is restated here, and the list is
 * short enough to audit:
 *
 * - **The bearer is attached in main and never leaves it.** `SecretString`
 *   requires an explicit `.reveal()`, and the one in `#authorize` is the only
 *   call in this whole module directory. It is written into a `Headers` object
 *   that is never logged.
 * - **`Origin` and `Cookie` are never set.** `src/middleware.ts:144` answers a
 *   mutating `/api/` request whose `Origin` does not match the host with a 403,
 *   and passes one that has none. Node's `fetch` adds no `Origin`; nothing here
 *   adds one either. A cookie would only widen what the request could do — the
 *   bearer is already authoritative in `getCurrentUser()`.
 * - **The path may not escape the configured origin**, checked before the
 *   header is attached, so a crafted path cannot post the credential elsewhere.
 * - **One rotation on 401, never a loop**, joined to the same
 *   `AccessTokenSource` the transport uses, so a rotation started here is the
 *   same single-flight the rest of the app participates in.
 * - **`redirect: 'error'`**, because following a redirect re-sends the
 *   `Authorization` header to wherever the redirect points.
 * - **The contract-version header is checked** on `/api/v1` replies with the
 *   same rule the transport applies. Non-v1 routes (`/api/chat`,
 *   `/api/conversations`) do not stamp it, which `evaluateContractVersion`
 *   reports as `absent` — not a blocking state.
 *
 * Nothing in this file logs a URL with a query string, a request body, a
 * response body or a header.
 */

import type { z } from 'zod';
import {
  ContractMismatchError,
  NetworkError,
  TimeoutError,
  CancelledError,
  MalformedResponseError,
  TransportError,
  UnauthorizedError,
  evaluateContractVersion,
  isBlockingContractObservation,
  toApiError,
  CONTRACT_VERSION_HEADER,
  REQUEST_ID_HEADER,
  type AccessTokenSource,
  type ApiError,
  type HttpMethod,
} from '../auth/transport.js';
import type { SecretString } from '../auth/keychain.js';

/**
 * What `fetch` accepts as a body.
 *
 * Derived from `RequestInit` rather than named `BodyInit`: that global is a DOM
 * type, and this project's main-process graph deliberately omits the DOM lib —
 * `fetch`, `Headers` and `FormData` come from @types/node. Deriving it means the
 * alias cannot drift from what the runtime actually takes.
 */
type RequestBody = NonNullable<RequestInit['body']>;

export interface RawClientOptions {
  /** The backend origin. Taken from `transport.origin` so there is one source. */
  readonly origin: string;
  readonly contractVersion: string;
  readonly tokens: AccessTokenSource;
  readonly fetchImpl?: typeof fetch;
}

interface SendOptions {
  readonly path: string;
  readonly method: HttpMethod;
  readonly accept: string;
  readonly body?: RequestBody;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Omitted for a stream: a generation legitimately runs for minutes. */
  readonly timeoutMs?: number;
}

export class RawJunoClient {
  readonly #origin: string;
  readonly #contractVersion: string;
  readonly #tokens: AccessTokenSource;
  readonly #fetch: typeof fetch;

  constructor(options: RawClientOptions) {
    this.#origin = new URL(options.origin).origin;
    this.#contractVersion = options.contractVersion;
    this.#tokens = options.tokens;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  get origin(): string {
    return this.#origin;
  }

  /**
   * Open a Server-Sent Events stream.
   *
   * `EventSource` is unusable for this: the credential must travel in an
   * `Authorization` header and `EventSource` cannot set one. (It also cannot be
   * constructed in main at all.) So the stream is a `fetch` whose body is read
   * as a `ReadableStream` — the same choice `sync/client.ts` makes, for the
   * same reason.
   *
   * No timeout. The caller owns liveness through an idle watchdog on the bytes,
   * because a model that thinks for four minutes before its first token is
   * healthy and a deadline here would kill it.
   */
  async openEventStream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.#authorized({
      path,
      method: 'POST',
      accept: 'text/event-stream',
      body: JSON.stringify(body),
      contentType: 'application/json',
      signal,
    });

    if (!response.ok) throw await this.#failure(response);

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('text/event-stream')) {
      /* A 200 that is not a stream means something in front of the app answered
         — a login page from a misconfigured proxy is the classic one. Reading it
         as frames would produce a silent, empty generation. */
      throw new MalformedResponseError(
        'Juno answered the chat request with something other than a response stream.',
      );
    }
    if (response.body === null) {
      throw new MalformedResponseError('Juno opened a response stream with no content.');
    }
    return response;
  }

  /**
   * A `multipart/form-data` upload.
   *
   * `content-type` is deliberately NOT set: `fetch` derives it from the
   * `FormData` body, and the derived value carries the multipart boundary.
   * Setting it by hand produces a header with no boundary and a body the server
   * cannot split.
   */
  async multipart<T>(spec: {
    readonly path: string;
    readonly form: FormData;
    readonly schema: z.ZodType<T>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<T> {
    const response = await this.#authorized({
      path: spec.path,
      method: 'POST',
      accept: 'application/json',
      body: spec.form,
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      timeoutMs: spec.timeoutMs ?? 60_000,
    });
    return this.#interpret(spec.path, response, spec.schema);
  }

  /**
   * Fetch bytes from a URL the backend gave us.
   *
   * Two shapes arrive from `getViewUrl`: an app-relative `/api/files/<key>`,
   * which needs the bearer, and an absolute pre-signed object URL, which does
   * not and must not receive it. The origin test decides, and a URL that is
   * neither http nor https is refused outright rather than handed to `fetch`.
   */
  async bytes(
    rawUrl: string,
    limitBytes: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    let url: URL;
    try {
      url = new URL(rawUrl, this.#origin);
    } catch {
      throw new TransportError('Juno received an unreadable file location.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TransportError('Juno refused to read a file from an unsupported location.');
    }

    const sameOrigin = url.origin === this.#origin;
    const response = sameOrigin
      ? await this.#authorized({
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          accept: '*/*',
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: 30_000,
        })
      : await this.#raw(url, {
          method: 'GET',
          headers: new Headers({ accept: '*/*' }),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: 30_000,
        });

    if (!response.ok) throw await this.#failure(response);

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limitBytes) {
      throw new TransportError('That file is larger than Juno will inline.');
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limitBytes) {
      throw new TransportError('That file is larger than Juno will inline.');
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ??
        'application/octet-stream',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Send with a bearer; on 401, rotate once and send again.
   *
   * One retry, not a loop — the same rule and the same reason as
   * `transport.requestAuthenticated`: a second 401 after a fresh token means
   * the device session is gone, and retrying against a rotating-refresh family
   * is how a client burns its own token chain.
   */
  async #authorized(options: SendOptions): Promise<Response> {
    const token = await this.#tokens.current();
    const first = await this.#send(options, token);
    if (first.status !== 401) return first;

    const rotated = await this.#tokens.afterUnauthorized(token);
    if (rotated.equals(token)) return first;

    const body = options.body;
    if (body !== undefined && !isReplayableBody(body)) {
      /* A `FormData` or a stream body may already be consumed. Rather than
         resend something that could arrive truncated, report the 401 as it
         stands — the caller sees a clear "session is no longer valid". */
      return first;
    }
    return this.#send(options, rotated);
  }

  async #send(options: SendOptions, token: SecretString): Promise<Response> {
    const url = new URL(options.path, this.#origin);
    if (url.origin !== this.#origin) {
      throw new TransportError('Refusing to send a Juno credential to a foreign origin.');
    }

    const headers = new Headers({
      accept: options.accept,
      [CONTRACT_VERSION_HEADER]: this.#contractVersion,
    });
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'origin' || lower === 'cookie') {
        throw new TransportError(`Refusing a caller-supplied ${lower} header.`);
      }
      headers.set(name, value);
    }
    if (options.contentType !== undefined) headers.set('content-type', options.contentType);
    /* Never `Origin`, never `Cookie`. See the module header. */
    headers.delete('origin');
    headers.delete('cookie');
    headers.set('authorization', `Bearer ${token.reveal()}`);

    return this.#raw(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  async #raw(
    url: URL,
    init: {
      method: HttpMethod;
      headers: Headers;
      body?: RequestBody;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const timeout = init.timeoutMs === undefined ? null : AbortSignal.timeout(init.timeoutMs);
    const signals = [init.signal, timeout].filter((value): value is AbortSignal => value !== undefined && value !== null);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      return await this.#fetch(url, {
        method: init.method,
        headers: init.headers,
        redirect: 'error',
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (init.signal?.aborted === true) throw new CancelledError('The request was cancelled.');
      if (timeout?.aborted === true) {
        throw new TimeoutError(`The request to ${url.pathname} timed out.`);
      }
      throw new NetworkError(
        `Juno could not reach ${url.protocol}//${url.host}${url.pathname}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async #interpret<T>(path: string, response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) throw await this.#failure(response);

    this.#assertContract(response);

    const text = await response.text().catch(() => '');
    let raw: unknown;
    try {
      raw = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      raw = undefined;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      /* Only the failing *paths* — a Zod issue can quote the value it rejected,
         and the value here is user content. */
      throw new MalformedResponseError(
        `Juno returned an unexpected response for ${redactPath(path)} ` +
          `(${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}).`,
      );
    }
    return parsed.data;
  }

  /** Build the typed error for a non-2xx, reporting a surviving 401 upward. */
  async #failure(response: Response): Promise<ApiError> {
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const text = await response.text().catch(() => '');
    let raw: unknown;
    try {
      raw = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const error = toApiError(response.status, raw, requestId);
    if (error instanceof UnauthorizedError) {
      /* The session decides what a surviving 401 means — `device_revoked` and
         `token_reuse_detected` end this install. Reported, never interpreted. */
      this.#tokens.reportTerminalRejection(error);
    }
    return error;
  }

  #assertContract(response: Response): void {
    const observation = evaluateContractVersion(
      this.#contractVersion,
      response.headers.get(CONTRACT_VERSION_HEADER),
    );
    if (isBlockingContractObservation(observation)) throw new ContractMismatchError(observation);
  }
}

/** A string body can be sent twice; a stream or a `FormData` may not survive it. */
function isReplayableBody(body: RequestBody): boolean {
  return typeof body === 'string';
}

function redactPath(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}
