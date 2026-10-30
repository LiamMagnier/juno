import {
  classifyProviderError,
  isModelCallError,
  isSafetyRefusal,
  requestRejection,
  retryAfterFrom,
  type ProviderErrorClass,
} from "@/lib/provider-error";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * ONE BOUNDED RETRY, BEFORE THE FIRST BYTE (health discovery, gap 2).
 *
 * Every SDK client runs with `maxRetries: 0` on purpose: a paid request is
 * never replayed behind the accounting boundary, because a replay after the
 * provider served tokens bills the reader twice and writes the answer twice.
 * The cost of that rule was that a 429, a 503, a 529 "overloaded" or a reset
 * socket on the FIRST request of a turn went straight to an error card, even
 * though nothing had been served and nothing would be billed.
 *
 * This module decides the one case where a turn may ask again, and run-turn
 * performs it:
 *
 *  - The provider REJECTED the request: the adapter's await on opening its
 *    FIRST request threw (`requestRejection`, marked in anthropic.ts,
 *    openai-responses.ts, openai-compat.ts and gemini.ts). That await settles
 *    when the response headers arrive, so what it throws is an HTTP status the
 *    provider answered instead of a stream, or a connection that failed
 *    (refused, reset, unresolvable) before any response. Anything raised while
 *    reading an accepted stream is never a rejection, whatever it looks like:
 *    a socket dropped after the provider's 200 (undici's "terminated") or an
 *    SSE error event. The provider had accepted the request and started work
 *    (and billing), and its opening events — Anthropic's `message_start`
 *    usage, the Responses `response.created` — stay inside the adapter, so an
 *    empty stream alone cannot tell the two apart. A timeout is not a
 *    rejection either: the request may be running at the provider.
 *  - BEFORE ANYTHING WAS RECEIVED: the attempt's stream yielded no event at
 *    all — no text, no reasoning, no tool call, no usage — and the
 *    accumulator holds nothing. One event of any kind and the turn never
 *    retries: that is the no-double-billing, no-duplicated-text rule, and it
 *    is checked on what was received as well as on where the error came from.
 *  - Not ended by the reader or the platform: a Stop, a drain, the stall
 *    watchdog, the budget guard or a lost lease is never retried.
 *  - Once. The second attempt's failure is the turn's failure. An adapter that
 *    already re-sent the request itself (Gemini's own retries, Anthropic's
 *    fast-mode fallback) has used the same model's second ask; only Auto may
 *    still move on to another model.
 *
 * Where the retry goes is the routing contract:
 *  - An EXPLICIT choice retries the same model, and only for a fault a moment
 *    can cure (rate limit, server error, connection). An account fault or a
 *    missing model would fail the same way, and moving the prompt to another
 *    model is exactly what an explicit choice forbids.
 *  - AUTO retries on the decision's next ranked healthy candidate
 *    (`TurnModel.autoRetry`, src/lib/chat/turn/model.ts), which clears the same
 *    plan, capability and data-use terms the router applied. Auto may also move
 *    on from a fault of one model or one lab's account (auth, billing, a model
 *    the lab no longer serves) — the 2026-10-26 outage, where Auto kept landing
 *    on an unfunded lab. When no candidate fits, Auto falls back to retrying
 *    its own pick for a transient fault, like an explicit choice.
 *  - Never for a safety refusal, an oversize prompt, a malformed request or an
 *    unclassified error: another model answering a prompt the first one
 *    refused is model-shopping, and the rest would fail again. A safety
 *    refusal is read from the wording whatever the status, so a lab that
 *    sends it as a 403 (which the classifier calls `auth`) is not shopped
 *    either (`isSafetyRefusal`).
 *
 * Pure apart from the timer in `waitBeforeRetry`; no `server-only`, so it is
 * unit tested directly (tests/chat-pre-stream-retry.test.ts).
 */

/** Title of the activity row the reader sees while the turn asks again. */
export const RETRYING_ACTIVITY_TITLE = "Retrying…";

/**
 * The owner-tunable numbers, read per turn from the environment with
 * conservative defaults and clamps. Listed in docs/OPEN_DECISIONS.md
 * ("Retry before the first byte") as owner to confirm.
 */
export interface PreStreamRetryTunables {
  /** `CHAT_PRESTREAM_RETRY=off` (or 0/false) turns the retry off. Default on. */
  enabled: boolean;
  /**
   * The longest the turn waits before its second attempt, in ms
   * (`CHAT_PRESTREAM_RETRY_MAX_WAIT_MS`, default 8000, clamped 0–15000). A
   * provider that asks the SAME model to wait longer is not retried: the error
   * card says how long instead.
   */
  maxWaitMs: number;
}

export const DEFAULT_PRE_STREAM_RETRY_TUNABLES: PreStreamRetryTunables = { enabled: true, maxWaitMs: 8_000 };

/** Centre of the jittered wait before asking the same model again (±50%). */
const SAME_MODEL_BASE_DELAY_MS = 800;
/** Centre of the jittered wait before asking another model (±50%): no backoff is owed to a different model. */
const NEXT_MODEL_BASE_DELAY_MS = 400;
/** Spread added to a wait the provider named, so a burst of rejected turns does not return in step. */
const RETRY_AFTER_JITTER_MS = 250;

export function preStreamRetryTunables(env: Record<string, string | undefined> = process.env): PreStreamRetryTunables {
  const d = DEFAULT_PRE_STREAM_RETRY_TUNABLES;
  const switchRaw = env.CHAT_PRESTREAM_RETRY?.trim().toLowerCase();
  const enabled = !(switchRaw === "off" || switchRaw === "0" || switchRaw === "false" || switchRaw === "no");
  const waitRaw = env.CHAT_PRESTREAM_RETRY_MAX_WAIT_MS?.trim();
  const wait = waitRaw ? Number(waitRaw) : NaN;
  const maxWaitMs = Number.isFinite(wait) ? Math.min(15_000, Math.max(0, Math.round(wait))) : d.maxWaitMs;
  return { enabled, maxWaitMs };
}

/** Faults the same model may not repeat a moment later. */
const SAME_MODEL_CLASSES: ReadonlySet<ProviderErrorClass> = new Set(["rate_limit", "capacity", "network"]);
/**
 * …plus the faults of one model or one lab's account, which a different
 * model does not share. Auto only.
 */
const NEXT_MODEL_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  ...SAME_MODEL_CLASSES,
  "auth",
  "billing",
  "not_found",
]);

/**
 * Socket-level failures that mean the request never got an answer from the
 * provider's server: refused, reset, unresolvable, unreachable. Read only on
 * an error the adapter threw while opening the request (`requestRejection`),
 * so `UND_ERR_SOCKET` here is a socket closed before the response headers,
 * never one closed mid-body. Timeouts are deliberately absent (see
 * `connectionFailure`), except a CONNECT timeout: no connection was made, so
 * no request was sent.
 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function codeOf(value: unknown): string | null {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * The error and every `cause` under it (bounded, cycle-safe): the SDKs wrap
 * fetch's TypeError, which wraps undici's own error, so the socket's code can
 * sit two levels down.
 */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let link: unknown = err;
  while (link && typeof link === "object" && chain.length < 8 && !chain.includes(link)) {
    chain.push(link);
    link = (link as { cause?: unknown }).cause;
  }
  return chain;
}

/** A timeout code, other than the connect timeout (no connection, so no request). */
function isTimeoutCode(code: string): boolean {
  return code !== "UND_ERR_CONNECT_TIMEOUT" && /TIMEOUT|TIMEDOUT/i.test(code);
}

/**
 * True when the request failed to connect rather than being answered.
 *
 * Both SDKs throw `APIConnectionError` with the message "Connection error."
 * when `fetch` itself fails (the class name is not used: server bundles may
 * minify it), and undici reports the socket's own code somewhere down the
 * `cause` chain. The whole chain is read, and any abort or timeout in it
 * refuses: an abort is a Stop, a drain or the watchdog, all decided
 * elsewhere, and a timeout ("Request timed out.", undici's header and body
 * timeouts, `ETIMEDOUT`) means the provider may have received the request and
 * be working on it, which is the billing risk this whole module exists to
 * avoid. A connect timeout (`UND_ERR_CONNECT_TIMEOUT`) is different: no
 * connection, no request. Nothing else counts: a status-less error whose
 * words merely mention the network is not a failed connection.
 */
function connectionFailure(err: unknown): boolean {
  const chain = causeChain(err);
  // Its own wording ("Connect Timeout Error") is explained by the code.
  const connectTimeout = chain.some((link) => codeOf(link) === "UND_ERR_CONNECT_TIMEOUT");
  for (const link of chain) {
    const name = (link as { name?: unknown }).name;
    const message = messageOf(link);
    const code = codeOf(link);
    if (name === "AbortError" || /abort/i.test(message)) return false;
    if (code && isTimeoutCode(code)) return false;
    if (!connectTimeout && /timed?\s?out|timeout/i.test(message)) return false;
  }
  if (chain.some((link) => CONNECTION_CODES.has(codeOf(link) ?? ""))) return true;
  return messageOf(err) === "Connection error.";
}

/** A header value from either SDK shape: a `Headers` object or a plain record. */
function headerOf(err: unknown, name: string): string | null {
  const headers = (err as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

/**
 * How long the provider asked the caller to wait, in ms, when it said so:
 * `retry-after-ms`, then `retry-after` (seconds or an HTTP date), then the
 * wording in the error itself ("Please retry in 34.2s", `retryAfterFrom`).
 */
export function retryAfterMsOf(err: unknown, now: number = Date.now()): number | null {
  const msHeader = headerOf(err, "retry-after-ms");
  if (msHeader !== null && msHeader.trim() !== "") {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  const header = headerOf(err, "retry-after")?.trim() || null;
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const fromWords = retryAfterFrom(classifyProviderError(err).raw);
  return fromWords === null ? null : fromWords * 1000;
}

/** What the failed attempt delivered before it threw. */
export interface AttemptReceived {
  /** Events the attempt's stream yielded (`countingStream`). */
  events: number;
  /** Anything in the turn's accumulator: text, reasoning, usage, a finished round. */
  output: boolean;
}

export type PreStreamRetryRefusal =
  /** `CHAT_PRESTREAM_RETRY=off`. */
  | "disabled"
  /** This was already the second attempt. */
  | "already_retried"
  /** The reader or the platform ended it (Stop, drain, stall, budget, lease). */
  | "cancelled"
  /** At least one event or token arrived: never retried. */
  | "output_received"
  /** The error did not come out of the model call (a tool, a research leg, our own code). */
  | "not_model_call"
  /**
   * Not a rejection of the request: not thrown while opening the first
   * request (a stream the provider had accepted failed), or neither an HTTP
   * status nor a failed connection (a timeout, an abort).
   */
  | "not_rejection"
  /** A class another attempt cannot fix, or that this turn may not move for. */
  | "class"
  /** Only the same model could take it, and the provider asked it to wait longer than the bound. */
  | "wait_too_long";

export interface PreStreamRetryPlan {
  retry: true;
  class: ProviderErrorClass;
  status: number | null;
  /** The wait the provider named, in ms, when it named one. */
  retryAfterMs: number | null;
  /**
   * Asking the model that failed again, and how long to wait first. Null when
   * a moment cannot cure the fault, when the provider's own wait is longer
   * than the bound, or when the model's adapter already retried it (Gemini,
   * src/lib/gemini-network.ts).
   */
  sameModel: { delayMs: number } | null;
  /** Under Auto only: moving to the decision's next candidate, and how long to wait first. */
  nextModel: { delayMs: number } | null;
}

export type PreStreamRetryVerdict =
  | PreStreamRetryPlan
  | { retry: false; why: PreStreamRetryRefusal; class: ProviderErrorClass | null };

export function planPreStreamRetry(input: {
  err: unknown;
  /** The attempt that just failed (1 = the first). */
  attempt: number;
  received: AttemptReceived;
  /** A Stop, a drain, the stall watchdog, the budget guard or a lost lease ended it. */
  cancelled: boolean;
  /** The reader chose Auto: the retry may move to the decision's next candidate. */
  auto: boolean;
  /** The model's adapter already retries its own transient faults (Gemini). */
  adapterRetries?: boolean;
  tunables?: PreStreamRetryTunables;
  random?: () => number;
  now?: number;
}): PreStreamRetryVerdict {
  const tunables = input.tunables ?? preStreamRetryTunables();
  const random = input.random ?? Math.random;
  const refuse = (why: PreStreamRetryRefusal, klass: ProviderErrorClass | null = null): PreStreamRetryVerdict => ({
    retry: false,
    why,
    class: klass,
  });
  if (!tunables.enabled) return refuse("disabled");
  if (input.attempt !== 1) return refuse("already_retried");
  if (input.cancelled) return refuse("cancelled");
  // The rule the rest of this module leans on: nothing received, nothing
  // billed, nothing shown. Checked before the error is even read.
  if (input.received.events > 0 || input.received.output) return refuse("output_received");
  if (!isModelCallError(input.err)) return refuse("not_model_call");

  const { class: klass, status } = classifyProviderError(input.err);
  // Thrown while the adapter opened its first request, or not at all: a
  // stream the provider accepted is never asked again, however it failed.
  const rejection = requestRejection(input.err);
  if (!rejection) return refuse("not_rejection", klass);
  // A safety refusal, whatever status carried it (xAI-style 403s read as
  // `auth`): never retried, and never moved to another lab under Auto.
  if (isSafetyRefusal(input.err)) return refuse("class", "content_filter");
  const httpRejection = typeof status === "number" && status >= 400;
  if (!httpRejection && !connectionFailure(input.err)) return refuse("not_rejection", klass);
  // A failed connection with no recognisable wording still counts as one.
  const effective: ProviderErrorClass = httpRejection ? klass : "network";
  // The adapter already sent this request twice (Gemini's own retries,
  // Anthropic's fast-mode fallback): the same model's second ask is used.
  const adapterRetried = input.adapterRetries === true || rejection.adapterRetried;

  const retryAfterMs = retryAfterMsOf(input.err, input.now);
  const jittered = (base: number) => Math.round(base * (0.5 + random()));

  let sameModel: PreStreamRetryPlan["sameModel"] = null;
  let tooLong = false;
  if (SAME_MODEL_CLASSES.has(effective) && !adapterRetried) {
    if (retryAfterMs !== null && retryAfterMs > tunables.maxWaitMs) {
      tooLong = true;
    } else {
      const delay = retryAfterMs !== null ? retryAfterMs + Math.round(random() * RETRY_AFTER_JITTER_MS) : jittered(SAME_MODEL_BASE_DELAY_MS);
      sameModel = { delayMs: Math.min(tunables.maxWaitMs, delay) };
    }
  }
  // The provider's wait was about the model that failed; another model owes
  // it nothing, so moving on waits only a short jitter.
  const nextModel: PreStreamRetryPlan["nextModel"] =
    input.auto && NEXT_MODEL_CLASSES.has(effective)
      ? { delayMs: Math.min(tunables.maxWaitMs, jittered(NEXT_MODEL_BASE_DELAY_MS)) }
      : null;

  if (!sameModel && !nextModel) return refuse(tooLong ? "wait_too_long" : "class", effective);
  return { retry: true, class: effective, status, retryAfterMs, sameModel, nextModel };
}

/**
 * The spend hold attempt 2 takes (`reserveSpend` ref). Attempt 1's is the
 * generation's own id. The abandoned-receipt sweep releases both
 * (chat-first-submission-receipt.ts), so a process that dies during a retried
 * turn leaves neither open.
 */
export function preStreamRetrySpendRef(generationId: string): string {
  return `${generationId}:attempt-2`;
}

/**
 * Passes a model stream through and counts what it yields, so the turn can
 * tell "rejected before anything arrived" from "failed part-way". The
 * adapter's own speed note (`{ type: "usage", fast }`, sent when Anthropic's
 * fast mode falls back before any stream opened) is bookkeeping, not output:
 * it is passed through but not counted.
 */
export function countingStream<T>(stream: AsyncIterable<T>): { stream: AsyncIterable<T>; received: () => number } {
  let received = 0;
  async function* counted() {
    for await (const event of stream) {
      if (!isSpeedNote(event)) received += 1;
      yield event;
    }
  }
  return { stream: counted(), received: () => received };
}

function isSpeedNote(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const keys = Object.keys(event);
  return (event as { type?: unknown }).type === "usage" && keys.length === 2 && keys.includes("fast");
}

/**
 * Waits before the second attempt, and ends early if the turn is stopped,
 * drained or otherwise aborted meanwhile (the caller checks the signal after).
 */
export function waitBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type ActivityRow = Omit<ClientActivityEvent, "id" | "createdAt">;

/** " in 3 seconds" for a wait a person notices, nothing for one they do not. */
function waitClause(delayMs: number): string {
  if (delayMs < 1500) return "";
  const seconds = Math.round(delayMs / 1000);
  return ` in ${seconds} seconds`;
}

/**
 * The rows that say the turn is asking again (kind `model`: the rows every
 * client already renders, so no wire or native decoder changes).
 *
 * The copy names the model, never the account: an account fault reads "did
 * not answer", as the error card's "temporarily unavailable" does, so the
 * stream does not tell anyone the platform ran out of credit. Moving to
 * another model under Auto adds a second "Selected model" row, so the panel's
 * Model fact (the last such row) names the model that actually answers.
 */
export function retryActivityRows(input: {
  failed: { name: string };
  /** The model asked next under Auto; absent when the same model is asked again. */
  next?: { name: string } | null;
  class: ProviderErrorClass;
  delayMs: number;
}): ActivityRow[] {
  if (input.next) {
    return [
      {
        kind: "model",
        title: RETRYING_ACTIVITY_TITLE,
        detail: `${input.failed.name} did not answer, so Auto is trying its next choice.`,
      },
      {
        kind: "model",
        title: "Selected model",
        detail: `Auto switched to ${input.next.name} — ${input.failed.name} did not answer`,
      },
    ];
  }
  const cause =
    input.class === "rate_limit"
      ? "is busy right now"
      : input.class === "capacity"
        ? "had a temporary server problem"
        : "could not be reached";
  return [
    {
      kind: "model",
      title: RETRYING_ACTIVITY_TITLE,
      detail: `${input.failed.name} ${cause}. Asking it again${waitClause(input.delayMs)}.`,
    },
  ];
}
