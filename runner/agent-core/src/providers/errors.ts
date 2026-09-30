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
  /**
   * Juno refused the call because the person's own plan is spent: the proxy's
   * `402 QUOTA_EXCEEDED`, from its budget wall or a rolling usage window.
   *
   * Not `insufficient_balance`, although both are a 402 about money, because
   * the two want opposite things done. A lab out of credit is Juno's problem
   * and another lab can run the task; a plan that is spent follows the person
   * to every model, so failing over only spends another request to be told
   * the same thing, and waiting inside a run cannot outlast a window that
   * frees up in hours. Neither retried nor failed over.
   */
  | 'plan_limit'
  /**
   * The request was longer than the model can read at once. Waiting will not
   * shorten it and the same request will fail again; the fix is to compact the
   * conversation and send the shorter one, which `runAgentLoop` does when it
   * has been given a compactor.
   */
  | 'context_overflow'
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
    return this.kind !== 'auth' && this.kind !== 'plan_limit';
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

/**
 * "You have run out of money", in the words three different labs actually use.
 *
 * Read before the status is, because the status is not where the labs agree.
 * Measured against the live APIs on 2026-08-07, one deployment, all four keys
 * unfunded on the same afternoon:
 *
 *   DeepSeek   402  "Insufficient Balance"
 *   OpenAI     429  "You have no credits remaining. Add credits to continue…"
 *   Anthropic  400  "Your credit balance is too low to access the Anthropic API"
 *
 * Three statuses for one condition, and two of them are actively misleading if
 * taken at face value. OpenAI's 429 would be classified `rate_limit` — so the
 * loop would sit through four backed-off retries, up to ninety seconds, waiting
 * out a limit that clears when somebody pays an invoice. Anthropic's 400 would
 * be `invalid_request`, whose sentence blames a retired or renamed model and
 * sends the reader to change something that was never wrong.
 *
 * So the phrase wins over the number. Deliberately narrow and quoted from real
 * responses rather than guessed, in the spirit of `NO_AGENTIC_TOOLS_RE` in
 * src/lib/models.ts — a loose pattern here would silently turn a genuine rate
 * limit into a permanent failure and stop the retry that was working.
 */
const OUT_OF_CREDIT_RE =
  /insufficient balance|no credits remaining|credit balance is too low|insufficient credit|exceeded your current quota|billing hard limit/i;

/**
 * The proxy's own refusal code, wherever an SDK left it.
 *
 * The Anthropic SDK keeps the whole body on `error.error`, so the code is at
 * `error.error.code`; the OpenAI SDK keeps only `body.error`, which for the
 * proxy's body is the sentence, and drops the code on the floor — which is why
 * `classifyProviderError` also takes the caller's word that it is talking to
 * the proxy.
 */
const PLAN_LIMIT_CODE = 'QUOTA_EXCEEDED';

function carriesPlanLimitCode(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const source = error as { code?: unknown; error?: unknown; message?: unknown };
  if (source.code === PLAN_LIMIT_CODE) return true;
  const body = source.error;
  if (body !== null && typeof body === 'object' && (body as { code?: unknown }).code === PLAN_LIMIT_CODE) {
    return true;
  }
  return typeof source.message === 'string' && source.message.includes(`"code":"${PLAN_LIMIT_CODE}"`);
}

/**
 * The sentence the proxy wrote for a person, when an SDK kept it: "You've used
 * up your 5-hour usage limit. It frees up at 3:00 PM UTC." says more than any
 * sentence this file could compose, so it is passed through.
 */
function proxySentence(error: unknown): string | null {
  if (error == null || typeof error !== 'object') return null;
  const body = (error as { error?: unknown }).error;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body !== null && typeof body === 'object') {
    const inner = (body as { error?: unknown }).error;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  }
  return null;
}

/**
 * "The prompt is longer than this model can read", in the words the labs use.
 * Anthropic: `prompt is too long: 215000 tokens > 200000 maximum`; OpenAI and
 * most compatible labs: `context_length_exceeded` / `maximum context length`.
 */
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds? the (?:model'?s? )?context window|context window (?:is )?exceeded|input is too long|too many (?:input )?tokens/i;

/** The provider's own words, from wherever this SDK happened to put them. */
function messageOf(error: unknown): string {
  if (error == null || typeof error !== 'object') return '';
  const source = error as { message?: unknown; error?: { message?: unknown } };
  const parts: string[] = [];
  if (typeof source.message === 'string') parts.push(source.message);
  if (typeof source.error?.message === 'string') parts.push(source.error.message);
  return parts.join(' ');
}

function kindForStatus(status: number | null, error: unknown, viaJunoProxy: boolean): ProviderFailureKind {
  // Juno's own refusal first: it names itself, and it is the one money
  // failure no other model can get round.
  if (carriesPlanLimitCode(error)) return 'plan_limit';
  // Before the status, for the reason above.
  const said = messageOf(error);
  if (OUT_OF_CREDIT_RE.test(said)) return 'insufficient_balance';
  // A 402 the proxy answered itself. An upstream lab's own 402 is relayed with
  // its own body, which the phrase test above has already claimed.
  if (status === 402 && viaJunoProxy) return 'plan_limit';
  // 413 is the proxy refusing a body over its size limit, which is the same
  // condition measured in bytes rather than tokens, with the same cure.
  const code = (error as { code?: unknown } | null)?.code;
  if (
    status === 413 ||
    ((status === 400 || status === 422 || status === null) &&
      (code === 'context_length_exceeded' || CONTEXT_OVERFLOW_RE.test(said)))
  ) {
    return 'context_overflow';
  }

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
    case 'plan_limit':
      return "You've used up your plan's usage limit, so this run stopped. Nothing is wrong with the task, and it can be run again once the limit frees up.";
    case 'context_overflow':
      return `The conversation grew longer than ${providerLabel} can read at once, so this turn could not be sent.`;
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
export function classifyProviderError(
  error: unknown,
  providerLabel: string,
  options: {
    /**
     * The adapter is talking to Juno's `/api/agent` proxy rather than to the
     * lab, so a 402 without a lab's out-of-credit wording is the proxy's own
     * plan limit. Needed because the OpenAI SDK discards the proxy's `code`.
     */
    viaJunoProxy?: boolean;
  } = {},
): ProviderCallError {
  if (error instanceof ProviderCallError) return error;

  const source = (error ?? {}) as { status?: unknown; headers?: unknown };
  const status = typeof source.status === 'number' ? source.status : null;
  const kind = kindForStatus(status, error, options.viaJunoProxy === true);
  const retryAfterMs = retryAfterFrom(source);
  const message =
    kind === 'plan_limit'
      ? (proxySentence(error) ?? sentenceFor(kind, providerLabel, retryAfterMs))
      : sentenceFor(kind, providerLabel, retryAfterMs);

  return new ProviderCallError(kind, status, retryAfterMs, providerLabel, message, error);
}
