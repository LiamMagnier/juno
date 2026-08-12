/**
 * Authenticated requests for the two things `JunoTransport` cannot carry.
 *
 * The transport buffers and JSON-parses every response, which is the right shape
 * for `/api/v1` and the wrong shape for both of Work's non-JSON routes: the
 * event log is Server-Sent Events, and an artifact download is bytes. Neither
 * can be made to fit without changing a module this surface does not own.
 *
 * So this exists, and it is deliberately the *smallest* thing that can be
 * correct. It attaches a bearer and, on a 401, rotates ONCE and retries. That is
 * `requestAuthenticated`'s rule verbatim, including the reason for it: a second
 * 401 after a fresh token is not a race another attempt will win — it means the
 * device session is gone — and a retry loop against a rotating-refresh family is
 * how a client burns its own token chain.
 *
 * It does not: parse bodies, check the contract version, or interpret status
 * codes beyond 401. The callers do those, because what a 404 means differs
 * between a missing session and a missing artifact version.
 *
 * Two rules that are easy to lose and expensive to lose:
 *
 *  - **Never send `Origin`.** `src/middleware.ts` 403s a mutating `/api/`
 *    request whose Origin does not match the host, and passes a request that has
 *    none. No Origin is the native path.
 *  - **Never log the token, the URL's query, or any body.**
 */

import type { AccessTokenSource } from '../auth/transport.js';
import {
  CancelledError,
  NetworkError,
  TimeoutError,
  TransportError,
  UnauthorizedError,
} from '../auth/transport.js';

export interface BearerFetcherOptions {
  readonly origin: string;
  readonly tokens: AccessTokenSource;
  readonly appVersion: string;
  readonly contractVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

export interface BearerRequest {
  readonly url: URL;
  readonly accept: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The sentence a signed-out or revoked device gets. Never a status code. */
const SIGNED_OUT =
  'Juno signed this device out. Sign in again to see your tasks.';

export class BearerFetcher {
  readonly #origin: string;
  readonly #tokens: AccessTokenSource;
  readonly #appVersion: string;
  readonly #contractVersion: string;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;

  constructor(options: BearerFetcherOptions) {
    this.#origin = new URL(options.origin).origin;
    this.#tokens = options.tokens;
    this.#appVersion = options.appVersion;
    this.#contractVersion = options.contractVersion;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Build a URL inside the configured origin. Refuses to escape it. */
  url(path: string): URL {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) {
      throw new TransportError('Refusing to send a Juno credential to a foreign origin.');
    }
    return url;
  }

  /**
   * GET, authenticated. The response body is untouched and unread — the caller
   * owns it, because only the caller knows whether it is a stream or bytes.
   */
  async get(request: BearerRequest): Promise<Response> {
    const token = await this.#tokens.current();
    const first = await this.#send(request, token.reveal());
    if (first.status !== 401) return first;

    await first.text().catch(() => undefined);
    const rotated = await this.#tokens.afterUnauthorized(token);
    if (rotated.equals(token)) throw this.#terminal();

    const second = await this.#send(request, rotated.reveal());
    if (second.status === 401) {
      await second.text().catch(() => undefined);
      throw this.#terminal();
    }
    return second;
  }

  #terminal(): UnauthorizedError {
    const error = new UnauthorizedError(401, null, null, false, null, SIGNED_OUT);
    this.#tokens.reportTerminalRejection(error);
    return error;
  }

  async #send(request: BearerRequest, bearer: string): Promise<Response> {
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

    try {
      return await this.#fetch(request.url, {
        method: 'GET',
        headers: {
          accept: request.accept,
          'x-juno-contract-version': this.#contractVersion,
          'x-juno-app-version': this.#appVersion,
          authorization: `Bearer ${bearer}`,
        },
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (request.signal?.aborted === true) throw new CancelledError('The request was cancelled.');
      if (timeout.aborted) throw new TimeoutError(`Juno did not answer within ${timeoutMs}ms.`);
      throw new NetworkError(
        `Juno could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
