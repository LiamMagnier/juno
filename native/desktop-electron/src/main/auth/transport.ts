/**
 * The authenticated HTTP client for `/api/v1`.
 *
 * Everything that talks to the Juno backend goes through here, and nothing that
 * goes through here runs in the renderer. The renderer's CSP is
 * `connect-src 'self'` (see `security.ts`), so it cannot originate backend
 * traffic at all; main attaches the bearer token, and the token never crosses
 * the IPC boundary in either direction.
 *
 * ## What this file is responsible for
 *
 * 1. **Attaching the bearer**, and nothing else about the credential lifecycle.
 *    Rotation lives in `session.ts`; this module asks for a token and, on a 401,
 *    asks once more for a rotated one.
 * 2. **Single-flight on 401.** Ten concurrent requests that all get a 401 must
 *    produce ONE refresh, not ten. Ten refreshes against a rotating-family
 *    server is not merely wasteful: the second one races the first and the
 *    server answers `503 refresh_conflict`, and a client that mistook that for
 *    an auth failure would sign the user out for being busy.
 * 3. **The contract-version check**, with a failure mode that names the actual
 *    problem — see `evaluateContractVersion`.
 * 4. **Timeouts and cancellation**, so a hung backend cannot pin a sign-in
 *    dialog open forever.
 * 5. **Validating every response with Zod** before it reaches a caller.
 *
 * ## What this file must never do
 *
 * Log an `Authorization` header, a request body containing a grant, or a
 * response body. Error paths carry the status, the envelope `code` and the
 * request id — which is exactly what a bug report needs and contains no
 * credential. `redactUrl` strips query and fragment from anything that does get
 * logged, because the authorize callback carries the authorization code there.
 */

import { z } from 'zod';
import type { SecretString } from './keychain.js';

/* -------------------------------------------------------------------------- */
/* Contract version                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The `/api/v1` contract this build was written against.
 *
 * Must equal `info.version` in `contracts/openapi/juno-native-v1.yaml` and
 * `CONTRACT_VERSION` in `src/lib/api-v1.ts`. The server stamps every `/api/v1`
 * response — success *and* error — with `X-Juno-Contract-Version`, and returns
 * the same string in the `GET /auth/session` body.
 */
export const SUPPORTED_CONTRACT_VERSION = '1.3.0';

export const CONTRACT_VERSION_HEADER = 'x-juno-contract-version';
export const REQUEST_ID_HEADER = 'x-juno-request-id';

export type ContractObservation =
  | { readonly status: 'match'; readonly version: string }
  /** Patch-level drift. Tolerated — see `evaluateContractVersion`. */
  | { readonly status: 'patch-drift'; readonly expected: string; readonly received: string }
  /** The server has moved past us: this build must be updated. */
  | { readonly status: 'client-outdated'; readonly expected: string; readonly received: string }
  /** The deployment is behind this build. Nothing the user can do. */
  | { readonly status: 'server-outdated'; readonly expected: string; readonly received: string }
  | { readonly status: 'absent'; readonly expected: string }
  | { readonly status: 'unparseable'; readonly expected: string; readonly received: string };

/**
 * Decide what an observed contract version means. Pure.
 *
 * ## Why this is not `received === expected`
 *
 * The Swift client compares for exact equality, and on 2026-07-22 that produced
 * a standoff worth not repeating (`docs/native/STATUS.md`): production served
 * `1.0.1` while the shipped build required `1.3.0`, so **the client's own
 * version check refused every native sign-in**. The app was not broken and the
 * server was not broken; they disagreed about a string, and the only fix was a
 * deploy. The failure surfaced as "sign-in doesn't work", which is the least
 * actionable possible description of "the backend needs deploying".
 *
 * Two changes come out of that:
 *
 * - **Direction is named.** `client-outdated` and `server-outdated` are
 *   different problems with different owners. One is "update Juno", the other
 *   is "deploy the backend"; a single "mismatch" string tells whoever is
 *   holding the app neither.
 * - **Patch drift is tolerated.** The contract's own `info.description` says
 *   `version` moves only on a change an older client cannot survive, and that
 *   additive endpoints deliberately leave it alone — precisely because bumping
 *   it "would fail that client's /auth/session check and sign the user out of
 *   an app that was working fine". Honouring that intent means a patch-level
 *   difference is recorded, not enforced. Major and minor differences are
 *   enforced, because those are the breaks the field exists to signal.
 *
 * What this does *not* do, in any direction, is invalidate credentials. A
 * contract mismatch is not an authentication failure and must never be
 * laundered into one.
 */
export function evaluateContractVersion(expected: string, received: string | null): ContractObservation {
  if (received === null || received.length === 0) return { status: 'absent', expected };
  if (received === expected) return { status: 'match', version: expected };

  const ours = parseSemver(expected);
  const theirs = parseSemver(received);
  if (ours === null || theirs === null) return { status: 'unparseable', expected, received };

  if (ours.major === theirs.major && ours.minor === theirs.minor) {
    return { status: 'patch-drift', expected, received };
  }
  const serverIsNewer =
    theirs.major > ours.major || (theirs.major === ours.major && theirs.minor > ours.minor);
  return serverIsNewer
    ? { status: 'client-outdated', expected, received }
    : { status: 'server-outdated', expected, received };
}

/** Whether an observation should stop a request from being treated as usable. */
export function isBlockingContractObservation(observation: ContractObservation): boolean {
  return observation.status === 'client-outdated' || observation.status === 'server-outdated';
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Base for every failure this module raises. Never carries credential material. */
export class TransportError extends Error {
  override readonly name: string = 'TransportError';
}

/** The client and the server disagree about the contract. Not an auth failure. */
export class ContractMismatchError extends TransportError {
  override readonly name = 'ContractMismatchError';
  constructor(readonly observation: ContractObservation) {
    super(describeContract(observation));
  }
}

function describeContract(observation: ContractObservation): string {
  switch (observation.status) {
    case 'client-outdated':
      return `This build of Juno speaks contract ${observation.expected}; the server has moved to ${observation.received}. Update Juno.`;
    case 'server-outdated':
      return `This build of Juno requires contract ${observation.expected}; the server is still serving ${observation.received}. The backend needs to be deployed — signing in again will not help.`;
    case 'unparseable':
      return `The server reported an unreadable contract version (expected ${observation.expected}).`;
    case 'absent':
      return `The server did not report a contract version (expected ${observation.expected}).`;
    default:
      return 'The contract versions match.';
  }
}

/** A non-2xx response, with the typed envelope when the server sent one. */
export class ApiError extends TransportError {
  override readonly name: string = 'ApiError';
  constructor(
    readonly status: number,
    /** The `error.code` from the v1 envelope, when present. */
    readonly code: string | null,
    /** The server-issued request id — safe to show and to put in a bug report. */
    readonly requestId: string | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A 401 that survived one rotation.
 *
 * `code` is the backend's `NativeAuthErrorCode` and is what the session state
 * machine keys its teardown decision on: `device_revoked` and
 * `token_reuse_detected` mean this install is finished, `token_expired` after a
 * successful rotation means something is deeply wrong.
 */
export class UnauthorizedError extends ApiError {
  override readonly name = 'UnauthorizedError';
}

/** The request exceeded its deadline. Distinct from caller cancellation. */
export class TimeoutError extends TransportError {
  override readonly name = 'TimeoutError';
}

/** The caller's AbortSignal fired. */
export class CancelledError extends TransportError {
  override readonly name = 'CancelledError';
}

/** DNS, TLS, connection reset — anything that never produced a status. */
export class NetworkError extends TransportError {
  override readonly name = 'NetworkError';
}

/** A 2xx whose body did not match the schema the contract promises. */
export class MalformedResponseError extends TransportError {
  override readonly name = 'MalformedResponseError';
}

/* -------------------------------------------------------------------------- */
/* Single-flight                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Coalesces concurrent work under a key onto one shared promise.
 *
 * Used in two places: here, so N concurrent 401s carrying the same rejected
 * access token ask for ONE rotation; and in `session.ts`, so the rotation
 * itself is serialized per account. Both are needed. This layer collapses the
 * burst; the session layer is the actual invariant, because a refresh can also
 * be started by the proactive timer with no 401 anywhere in sight.
 *
 * The entry is removed when the promise settles, not before — a late arrival
 * during the flight joins it rather than starting a second one.
 */
export class SingleFlight<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;

    const flight = work().finally(() => {
      /* Only clear our own entry: a `cancel` during the flight may already have
         installed a newer one under the same key. */
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, flight);
    return flight;
  }

  get size(): number {
    return this.#inFlight.size;
  }

  clear(): void {
    this.#inFlight.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Token source                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the transport needs from the session, and no more.
 *
 * Deliberately not "the session object": the transport can obtain a token and
 * report a terminal rejection, but it cannot sign out, cannot read the profile
 * and cannot reach the credential store. `session.ts` implements this.
 */
export interface AccessTokenSource {
  /**
   * A token good for at least `minimumValiditySeconds`. May refresh proactively.
   * Access tokens live 10 minutes, so the default leaves a real margin.
   */
  current(minimumValiditySeconds?: number): Promise<SecretString>;
  /**
   * Rotate because `rejected` was refused. Returns the current token unchanged
   * if another caller already rotated past it — which is the signal to retry
   * without having rotated again.
   */
  afterUnauthorized(rejected: SecretString): Promise<SecretString>;
  /** A 401 that survived rotation. The session decides what it means. */
  reportTerminalRejection(error: UnauthorizedError): void;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransportOptions {
  /** Backend origin, e.g. `https://chat.liams.dev`. Must be https in production. */
  readonly origin: string;
  readonly appVersion: string;
  readonly contractVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
  /** Notified once per *change* in observed contract status, not per request. */
  readonly onContractObservation?: (observation: ContractObservation) => void;
  readonly logger?: TransportLogger;
}

export interface TransportLogger {
  warn(message: string): void;
  error(message: string): void;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestSpec<T> {
  readonly path: string;
  readonly method: HttpMethod;
  /** Every response is validated. There is no `any` path out of this module. */
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Extra headers. `authorization` and `origin` are rejected here. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly requestId: string | null;
  readonly contract: ContractObservation;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The v1 envelope. `src/lib/api-v1.ts` guarantees this shape for API errors. */
const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    retryAfterMs: z.number().nullable().optional(),
  }),
});

/**
 * The CSRF middleware's rejection shape.
 *
 * `src/middleware.ts` answers a cross-origin mutating request with
 * `{ error: "Cross-origin request rejected." }` — a bare string, *not* the v1
 * envelope. Parsing it with the envelope schema fails, so it is matched
 * separately rather than being reported as a malformed response.
 */
const MiddlewareErrorSchema = z.object({ error: z.string() });

export class JunoTransport {
  readonly #origin: string;
  readonly #appVersion: string;
  readonly #contractVersion: string;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #onContractObservation: ((observation: ContractObservation) => void) | undefined;
  readonly #logger: TransportLogger;
  readonly #refreshFlight = new SingleFlight<SecretString>();
  #lastContract: ContractObservation;

  constructor(options: TransportOptions) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
      throw new TransportError('The Juno backend origin must be https.');
    }
    this.#origin = origin.origin;
    this.#appVersion = options.appVersion;
    this.#contractVersion = options.contractVersion ?? SUPPORTED_CONTRACT_VERSION;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onContractObservation = options.onContractObservation;
    this.#logger = options.logger ?? console;
    this.#lastContract = { status: 'absent', expected: this.#contractVersion };
  }

  get origin(): string {
    return this.#origin;
  }

  get contractVersion(): string {
    return this.#contractVersion;
  }

  /** The most recent observation, for the diagnostics surface. */
  get contractObservation(): ContractObservation {
    return this.#lastContract;
  }

  /**
   * An unauthenticated request — the three grant endpoints, which carry
   * `security: []` in the contract: `/auth/token`, `/auth/password`,
   * `/auth/refresh`.
   */
  async request<T>(spec: RequestSpec<T>): Promise<ApiResponse<T>> {
    const response = await this.#send(spec, null);
    return this.#interpret(spec, response);
  }

  /**
   * One authenticated request with an explicitly supplied token, and no
   * rotation.
   *
   * This exists for exactly one moment: the sign-in handshake, where the
   * `/auth/token` exchange has produced credentials that are not yet installed
   * in the session, so there is no `AccessTokenSource` to ask. Every other
   * caller uses `requestAuthenticated`. It is a separate method rather than an
   * `authorization` header on `RequestSpec` because a spec-supplied header
   * would let any future caller attach a token from anywhere.
   */
  async requestWithToken<T>(spec: RequestSpec<T>, token: SecretString): Promise<ApiResponse<T>> {
    return this.#interpret(spec, await this.#send(spec, token));
  }

  /**
   * An authenticated request: attach, and on 401 rotate **once** and retry.
   *
   * One retry, not a loop. A second 401 after a fresh token is not a race that
   * another attempt will win — it means the device session is gone — and a
   * retry loop against a rotating-refresh family is how a client burns its own
   * token chain.
   */
  async requestAuthenticated<T>(spec: RequestSpec<T>, tokens: AccessTokenSource): Promise<ApiResponse<T>> {
    const token = await tokens.current();
    const first = await this.#send(spec, token);

    if (first.status !== 401) return this.#interpret(spec, first);

    /* Key the flight on the rejected token so that every request holding the
       same dead token joins one rotation, while a request that was already
       carrying a newer token does not get parked behind someone else's. */
    const rotated = await this.#refreshFlight.run(token.fingerprint(), () => tokens.afterUnauthorized(token));

    if (rotated.equals(token)) {
      /* Nothing rotated — the source is telling us this token is as good as it
         gets. Report the original 401 rather than replaying the request. */
      return this.#interpret(spec, first, tokens);
    }

    const second = await this.#send(spec, rotated);
    return this.#interpret(spec, second, tokens);
  }

  async #send(spec: RequestSpec<unknown>, token: SecretString | null): Promise<Response> {
    const url = new URL(spec.path, this.#origin);
    if (url.origin !== this.#origin) {
      /* A path that escapes the configured origin would send the bearer
         somewhere else. Refuse before the header is attached. */
      throw new TransportError('Refusing to send a Juno credential to a foreign origin.');
    }

    const headers = new Headers({
      accept: 'application/json',
      /* Sent on every request. The server does not currently read it — it only
         *emits* the response header — so this is forward compatibility plus
         correlation in the backend access log, not an enforced handshake. */
      [CONTRACT_VERSION_HEADER]: this.#contractVersion,
      'x-juno-app-version': this.#appVersion,
    });
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'origin' || lower === 'cookie') {
        throw new TransportError(`Refusing a caller-supplied ${lower} header.`);
      }
      headers.set(name, value);
    }
    /* Never set `Origin`. `src/middleware.ts` rejects a mutating `/api/` request
       whose `Origin` does not match the host with a 403, and passes a request
       that has none — which is the intended native path. Node's fetch does not
       add one for us, and nothing here should either. Nor `Cookie`: the bearer
       is authoritative in `getCurrentUser()`, and a stray cookie would only
       widen what this request could do. */
    headers.delete('origin');
    headers.delete('cookie');

    if (token !== null) headers.set('authorization', `Bearer ${token.reveal()}`);

    const hasBody = spec.body !== undefined;
    if (hasBody) headers.set('content-type', 'application/json');

    const timeoutMs = spec.timeoutMs ?? this.#defaultTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = spec.signal === undefined ? timeout : AbortSignal.any([spec.signal, timeout]);

    try {
      return await this.#fetch(url, {
        method: spec.method,
        headers,
        signal,
        redirect: 'error',
        ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
      });
    } catch (error) {
      if (spec.signal?.aborted === true) throw new CancelledError('The request was cancelled.');
      if (timeout.aborted) throw new TimeoutError(`The request to ${redactPath(spec.path)} timed out after ${timeoutMs}ms.`);
      /* The message may name a host and a syscall; it never contains a header
         or a body, because fetch never saw a response. */
      throw new NetworkError(
        `Juno could not reach ${redactUrl(url)}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async #interpret<T>(
    spec: RequestSpec<T>,
    response: Response,
    tokens?: AccessTokenSource,
  ): Promise<ApiResponse<T>> {
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const contract = evaluateContractVersion(
      this.#contractVersion,
      response.headers.get(CONTRACT_VERSION_HEADER),
    );
    this.#recordContract(contract, spec.path);

    const raw = await this.#readBody(response);

    if (!response.ok) {
      const error = toApiError(response.status, raw, requestId);
      if (error instanceof UnauthorizedError && tokens !== undefined) {
        /* Reached only after a rotation was attempted: `requestAuthenticated`
           passes `tokens` on the second interpretation, never the first. */
        tokens.reportTerminalRejection(error);
      }
      throw error;
    }

    /* A blocking mismatch is raised *after* the error path so that a 401 from a
       server we cannot speak to is still reported as a 401 — the credential
       decision is more urgent than the version disagreement — but before any
       body is handed to a caller, because a body from an incompatible contract
       is not something to act on. */
    if (isBlockingContractObservation(contract)) throw new ContractMismatchError(contract);

    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      /* The Zod issue list can quote field values. Only the *paths* are logged,
         and only the count reaches the message. */
      this.#logger.error(
        `[auth] ${spec.method} ${redactPath(spec.path)} returned an unexpected body: ` +
          `${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`,
      );
      throw new MalformedResponseError(
        `Juno returned an unexpected response for ${redactPath(spec.path)}${requestId === null ? '' : ` (request ${requestId})`}.`,
      );
    }
    return { data: parsed.data, requestId, contract };
  }

  async #readBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  #recordContract(observation: ContractObservation, path: string): void {
    if (sameObservation(observation, this.#lastContract)) return;
    this.#lastContract = observation;
    if (observation.status !== 'match') {
      /* Once per change, not once per request: a mismatch affects every call,
         and a per-request warning would bury the one line that matters. */
      this.#logger.warn(`[auth] contract check on ${redactPath(path)}: ${describeContract(observation)}`);
    }
    this.#onContractObservation?.(observation);
  }
}

function sameObservation(left: ContractObservation, right: ContractObservation): boolean {
  if (left.status !== right.status) return false;
  const leftVersion = 'version' in left ? left.version : 'received' in left ? left.received : '';
  const rightVersion = 'version' in right ? right.version : 'received' in right ? right.received : '';
  return leftVersion === rightVersion;
}

/**
 * Map a non-2xx onto a typed error.
 *
 * Handles three shapes: the v1 envelope, the CSRF middleware's bare-string
 * `error`, and no parseable body at all (a proxy's own 502 page).
 */
export function toApiError(status: number, body: unknown, requestId: string | null): ApiError {
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    const { code, message, retryable, retryAfterMs } = envelope.data.error;
    const id = envelope.data.error.requestId;
    const Ctor = status === 401 ? UnauthorizedError : ApiError;
    return new Ctor(status, code, id, retryable, retryAfterMs ?? null, message);
  }

  const middleware = MiddlewareErrorSchema.safeParse(body);
  if (middleware.success) {
    return new ApiError(status, null, requestId, status >= 500, null, middleware.data.error);
  }

  const retryable = status >= 500 || status === 429;
  const Ctor = status === 401 ? UnauthorizedError : ApiError;
  return new Ctor(status, null, requestId, retryable, null, `Juno returned HTTP ${status}.`);
}

/**
 * Strips query and fragment — the parts that carry the authorization code and
 * the `state`. Mirrors `redactUrl` in `security.ts`; duplicated rather than
 * imported so this module stays free of any Electron import and remains
 * unit-testable in a plain Node process.
 */
export function redactUrl(candidate: URL | string): string {
  try {
    const url = typeof candidate === 'string' ? new URL(candidate) : candidate;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

function redactPath(path: string): string {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}
