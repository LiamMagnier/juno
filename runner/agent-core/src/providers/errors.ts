/**
 * What went wrong at the provider, in terms a caller can act on.
 *
 * This file exists because of a sentence a user actually read. A Work run
 * dispatched to clean up a GitHub account made one successful tool call, met an
 * HTTP 429 with an empty body, and died fourteen seconds in under a banner
 * saying:
 *
 *     429 status code (no body)
 *
 * That string is the OpenAI SDK's own last-resort formatter for a response it
 * could not parse, and every layer between it and the screen passed it along
 * untouched: the adapter rethrew it, `runAgentLoop` rethrew it, the session
 * recorded it as `loopError`, and the run row stored it as `terminalDetail`
 * where the web UI renders it verbatim. Nothing in that chain ever asked what
 * kind of failure it was, which is why nothing could retry it, fail over from
 * it, or say anything about it in English.
 *
 * So the classification happens once, here, at the boundary where the HTTP
 * status still exists. Everything above works from the answer:
 *
 *   - `runAgentLoop` retries a `retryable` failure, honouring `retryAfterMs`.
 *   - The Work runner fails a run over to another model when retries run out.
 *   - The UI has a sentence written for a person rather than for a log.
 *
 * Deliberately dependency-free: no SDK types, no imports. Both adapters call it,
 * the shapes they catch come from two different vendors' clients, and a
 * structural read of the error object is the only thing that works for both
 * without this file taking a dependency on either.
 */

export type ProviderFailureKind =
  /** The lab is throttling us. Waiting is the fix, and it may take a while. */
  | 'rate_limit'
  /** The lab is up but has no capacity right now. Waiting is the fix. */
  | 'overloaded'
  /** A connection or 5xx that has no reason to be permanent. */
  | 'transient'
  /** Our credentials were rejected. Waiting will never fix this. */
  | 'auth'
  /**
   * The lab took the request and refused it for money: the account behind the
   * key is out of credit.
   *
   * Its own kind rather than folded into `auth` or `invalid_request`, because
   * the three want three different things done about them and only this one is
   * fixed by a person topping up an account. It earned the distinction the
   * expensive way: DeepSeek answers `402 Insufficient Balance`, 402 was in
   * none of the lists below, so it fell through to `unknown` and a production
   * Work run reported "DeepSeek failed in a way Juno does not recognise" —
   * true, unhelpful, and one HTTP status away from being actionable.
   */
  | 'insufficient_balance'
  /** The lab refused the request itself — a bad parameter, an unknown model. */
  | 'invalid_request'
  /** The model or the account is not allowed to do this. */
  | 'forbidden'
  /** Nothing above matched. Treated as permanent, because guessing costs money. */
  | 'unknown';

/** Failure kinds where trying the same request again could plausibly work. */
const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'rate_limit',
  'overloaded',
  'transient',
]);

export class ProviderCallError extends Error {
  // `override` on both this and `cause` below: the website's tsconfig sets
  // `noImplicitOverride` and compiles these sources directly, while this
  // package's own tsconfig does not. Without it the vendored build is clean and
  // the repository typecheck that imports it is not.
  override readonly name = 'ProviderCallError';

  constructor(
    readonly kind: ProviderFailureKind,
    /** The HTTP status, when there was one. */
    readonly status: number | null,
    /** How long the lab asked us to wait, in ms, when it said. */
    readonly retryAfterMs: number | null,
    /** The lab's display name, for the sentence. */
    readonly providerLabel: string,
    message: string,
    /** The original error, kept for logs and never shown to a person. */
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  /** Whether trying the identical request again could plausibly succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /**
   * Whether moving to a different model would plausibly help.
   *
   * A rate limit belongs to the lab, not to the model, so a different lab is the
   * move — which is why the Work runner's failover prefers a different provider
   * rather than merely a different id. `invalid_request` is here too: an unknown
   * model or a parameter one lab rejects is very often fine at the next one.
   * `auth` is not, because the credential problem is ours and follows us.
   */
  get worthFailingOver(): boolean {
    return this.kind !== 'auth';
  }
}

/** Reads a header bag that might be a `Headers`, a plain object, or absent. */
function header(source: unknown, name: string): string | null {
  if (source == null || typeof source !== 'object') return null;
  const bag = source as { get?: (key: string) => string | null };
  if (typeof bag.get === 'function') {
    const value = bag.get(name);
    return typeof value === 'string' ? value : null;
  }
  const record = source as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()];
  return typeof direct === 'string' ? direct : null;
}

/**
 * How long to wait, from whatever the lab said.
 *
 * `retry-after-ms` is OpenAI's non-standard millisecond header and is preferred
 * when present because it is exact; `retry-after` is the RFC one and carries
 * either seconds or an HTTP date. Capped, because a lab answering "come back in
 * an hour" is telling us to fail over rather than to sleep — and an uncapped
 * value here would be a run holding an executor for the whole hour.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

function retryAfterFrom(error: { headers?: unknown }): number | null {
  const ms = header(error.headers, 'retry-after-ms');
  if (ms !== null) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, MAX_HONOURED_RETRY_AFTER_MS);
    }
  }

  const after = header(error.headers, 'retry-after');
  if (after === null) return null;

  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_HONOURED_RETRY_AFTER_MS);
  }

  // The RFC also permits an HTTP date.
  const at = Date.parse(after);
  if (Number.isFinite(at)) {
    return Math.min(Math.max(at - Date.now(), 0), MAX_HONOURED_RETRY_AFTER_MS);
  }
  return null;
}

function kindForStatus(status: number | null, error: unknown): ProviderFailureKind {
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 402) return 'insufficient_balance';
  if (status === 403) return 'forbidden';
  if (status === 408 || status === 409) return 'transient';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  // 529 is Anthropic's "overloaded"; 503 is the general one.
  if (status === 503 || status === 529) return 'overloaded';
  if (status !== null && status >= 500) return 'transient';
  if (status !== null) return 'unknown';

  // No status at all: a socket that never opened, a DNS failure, a timeout in
  // the client rather than the server. All are worth another go.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND)$/.test(code)) {
      return 'transient';
    }
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return 'transient';
  return 'unknown';
}

/** The sentence a person reads. Never contains a status code or a stack. */
function sentenceFor(
  kind: ProviderFailureKind,
  providerLabel: string,
  retryAfterMs: number | null,
): string {
  switch (kind) {
    case 'rate_limit': {
      const when =
        retryAfterMs != null
          ? ` It asked to be tried again in about ${Math.max(1, Math.round(retryAfterMs / 1000))} seconds.`
          : '';
      return `${providerLabel} is limiting how fast Juno may call it, so this run could not continue.${when}`;
    }
    case 'overloaded':
      return `${providerLabel} is overloaded and turned the request away, so this run could not continue.`;
    case 'transient':
      return `${providerLabel} did not answer, so this run could not continue.`;
    case 'auth':
      return `${providerLabel} rejected Juno's credentials, so this run could not start. This is a problem with the deployment rather than with the task.`;
    case 'insufficient_balance':
      return `${providerLabel} refused the request because the account Juno bills it to has run out of credit. Nothing is wrong with the task, and another model can run it.`;
    case 'forbidden':
      return `${providerLabel} refused this request. The model may not be available to this account.`;
    case 'invalid_request':
      return `${providerLabel} rejected the request as one it cannot serve. The model may have been retired or renamed.`;
    case 'unknown':
      return `${providerLabel} failed in a way Juno does not recognise, so this run stopped rather than guessing.`;
  }
}

/**
 * Turns whatever an SDK threw into something the rest of the system can reason
 * about.
 *
 * An error that is already a `ProviderCallError` passes through, so wrapping is
 * idempotent and a nested adapter cannot classify twice.
 *
 * An `AbortError` is deliberately NOT classified: a stop the user asked for is
 * not a provider failure, and the loop above checks the abort signal before it
 * ever gets here. Passing it through unchanged keeps that check the single place
 * cancellation is decided.
 */
export function classifyProviderError(error: unknown, providerLabel: string): ProviderCallError {
  if (error instanceof ProviderCallError) return error;

  const source = (error ?? {}) as { status?: unknown; headers?: unknown };
  const status = typeof source.status === 'number' ? source.status : null;
  const kind = kindForStatus(status, error);
  const retryAfterMs = retryAfterFrom(source);

  return new ProviderCallError(
    kind,
    status,
    retryAfterMs,
    providerLabel,
    sentenceFor(kind, providerLabel, retryAfterMs),
    error,
  );
}
