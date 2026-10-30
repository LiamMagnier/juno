/**
 * Sending a turn again when the server could not take it (deploy-safe sends).
 *
 * A deploy restarts the one web process. While the old one drains, `POST
 * /api/chat` answers `503 SERVER_DRAINING` with `Retry-After` before it reads
 * anything (src/app/api/chat/route.ts, src/lib/shutdown.ts); while the new one
 * boots, nginx answers its own 502. Both used to end the turn with an error the
 * reader had to retry by hand, at every deploy.
 *
 * This is the client's half: the decision whether a failed send may go out
 * again, how long to wait first, and the loop that does it. It never repeats a
 * turn whose stream had started — the resume path owns that (use-chat.ts,
 * `reconnectFromLog`) — and it repeats a send only when that is provably
 * harmless:
 *
 *  - `503 SERVER_DRAINING`: answered before authentication, so nothing was
 *    accepted, written or charged. Every kind of turn may go out again.
 *  - A gateway answer (a 502/503/504 the app did not write) or a connection
 *    failure before any response: the first attempt may or may not have
 *    reached the app, so it goes out again only when a repeat is harmless —
 *      `idempotent`: the send carries durable first-submission keys
 *        (`clientRequestId` + `clientMessageId`) and the server deduplicates
 *        it, answering a repeat with the original outcome
 *        (`REQUEST_ALREADY_SUBMITTED`, src/lib/chat-responses.ts);
 *      `verify`: a saved follow-up, repeated only after the server has said
 *        the first never landed (no generation running under this turn's id,
 *        and the conversation's newest question is not this one);
 *      `drain-only`: anything else (private chats, regenerates, media), where
 *        nothing can tell a lost request from a running one — not repeated.
 *
 * The number of tries and the time they may take are bounded, and the wait
 * listens to the turn's abort signal, so Stop ends it at once.
 */

/** The bounds, in one place. Code constants, listed in docs/OPEN_DECISIONS.md for the owner to confirm. */
export const SEND_RETRY = {
  /** Every round this send may make, the first POST included; a verification counts as a round. */
  maxRounds: 6,
  /** No new round starts once waiting for it would pass this, counted from the first POST (ms). */
  budgetMs: 60_000,
  /** `Retry-After` is honoured within these bounds (seconds). */
  minRetryAfterSeconds: 1,
  maxRetryAfterSeconds: 15,
  /** The wait after a gateway or connection failure, which carries no `Retry-After` (ms), by retry. */
  backoffMs: [2_000, 4_000, 8_000, 10_000] as readonly number[],
  /** Up to this share of a wait is added at random, so tabs that failed together do not return together. */
  jitterRatio: 0.3,
} as const;

/** How a repeat of this send would be made safe (see the header). */
export type SendSafety = "idempotent" | "verify" | "drain-only";

/** Why one POST did not start a stream. */
export type SendFailure =
  /** `503 SERVER_DRAINING`: refused before anything was read. */
  | { kind: "draining"; retryAfterMs: number | null; message: string }
  /** A 502/503/504 the app did not write: nginx could not reach it. */
  | { kind: "gateway"; status: number }
  /** fetch rejected before any response arrived. */
  | { kind: "network" }
  /** A durable first submission still being accepted by another request (409 `REQUEST_IN_PROGRESS`). */
  | { kind: "in-progress"; message: string }
  /** A durable first submission that an earlier attempt already delivered (409 `REQUEST_ALREADY_SUBMITTED`). */
  | {
      kind: "already-submitted";
      conversationId: string;
      userMessageId: string | null;
      generationId: string;
      receiptState: string | null;
    }
  /** 401: the session ended. */
  | { kind: "session-expired" }
  /** Any other answer: the server's word stands. */
  | { kind: "refused"; status: number; message: string; code: string | null };

/** What a `verify` check found out about the first attempt. */
export type SendVerification =
  /** The server holds the turn: running under this turn's generation id, or saved as the newest question. */
  | { state: "landed"; running: boolean; userMessageId: string | null }
  /** The server has no trace of it: sending again cannot duplicate it. */
  | { state: "absent" }
  /** The server could not be asked (still down). Nothing is sent until it can be. */
  | { state: "unknown" };

/** How a send ended. */
export type SendTurnResult =
  /** A 2xx with a body: hand it to the stream reader. */
  | { kind: "stream"; response: Response; rounds: number }
  /** A repeat found the first attempt already accepted (durable keys). */
  | Extract<SendFailure, { kind: "already-submitted" }>
  /** Verification found the first attempt on the server. */
  | { kind: "landed"; running: boolean; userMessageId: string | null }
  | { kind: "session-expired" }
  /** No further attempt is allowed: `message` is the sentence the turn shows. */
  | { kind: "failed"; message: string; status: number | null; code: string | null };

/** User-facing copy (named so scripts/generate-i18n-catalog.mjs picks it up). */
export const sendUnreachableMessage = "Couldn’t reach Alevr. Check your connection, then try again.";
export const sendGatewayMessage = "Alevr isn’t answering right now. Try again in a moment.";
export const sendFailedMessage = "Something went wrong.";

/** Whether this failure may lead to another round, and whether a verification must come first. */
export function retryPlan(failure: SendFailure, safety: SendSafety): "retry" | "verify-then-retry" | "stop" {
  switch (failure.kind) {
    case "draining":
      return "retry";
    case "in-progress":
      return safety === "idempotent" ? "retry" : "stop";
    case "gateway":
    case "network":
      if (safety === "idempotent") return "retry";
      if (safety === "verify") return "verify-then-retry";
      return "stop";
    default:
      return "stop";
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP-date. Null when absent or unreadable. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * How long to wait before the next round. `retry` counts the rounds already
 * waited for (1 for the first wait). A drain's own `Retry-After` wins, held to
 * a sane range; everything else backs off. Jitter only ever lengthens a wait.
 */
export function retryDelayMs(failure: SendFailure, retry: number, random: () => number): number {
  let base: number;
  if (failure.kind === "draining" && failure.retryAfterMs !== null) {
    base = Math.min(
      Math.max(failure.retryAfterMs, SEND_RETRY.minRetryAfterSeconds * 1_000),
      SEND_RETRY.maxRetryAfterSeconds * 1_000
    );
  } else {
    const ladder = SEND_RETRY.backoffMs;
    base = ladder[Math.min(Math.max(retry, 1), ladder.length) - 1];
  }
  const unit = Math.min(Math.max(random(), 0), 1);
  return Math.round(base + base * SEND_RETRY.jitterRatio * unit);
}

/** The human sentence an error body carries, wherever this route family put it. */
export function errorMessageOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const body = data as { error?: unknown; message?: unknown };
  // Machine-readable errors (e.g. 402 budget_exceeded) carry the sentence in
  // `message`; plain errors keep it in `error`, sometimes nested.
  if (typeof body.message === "string" && body.message) return body.message;
  if (body.error && typeof body.error === "object") {
    const nested = (body.error as { message?: unknown }).message;
    if (typeof nested === "string" && nested) return nested;
  }
  if (typeof body.error === "string" && body.error) return body.error;
  return null;
}

/**
 * Read a non-stream answer into a failure. `data` is the parsed JSON body, or
 * null when the body was not JSON — which is how a gateway's own error page is
 * told apart from the app's: every app error on this route is JSON.
 */
export function classifyResponse(input: {
  status: number;
  data: unknown;
  retryAfter: string | null;
  now: number;
}): SendFailure {
  const { status, data } = input;
  const code =
    data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string"
      ? ((data as { code: string }).code)
      : null;
  if (status === 401) return { kind: "session-expired" };
  if (status === 503 && code === "SERVER_DRAINING") {
    return {
      kind: "draining",
      retryAfterMs: parseRetryAfter(input.retryAfter, input.now),
      message: errorMessageOf(data) ?? sendGatewayMessage,
    };
  }
  if ((status === 502 || status === 503 || status === 504) && data === null) {
    return { kind: "gateway", status };
  }
  if (status === 409 && code === "REQUEST_IN_PROGRESS") {
    return { kind: "in-progress", message: errorMessageOf(data) ?? sendFailedMessage };
  }
  if (status === 409 && code === "REQUEST_ALREADY_SUBMITTED") {
    const body = data as { conversationId?: unknown; userMessageId?: unknown; generationId?: unknown; receiptState?: unknown };
    if (typeof body.conversationId === "string" && typeof body.generationId === "string") {
      return {
        kind: "already-submitted",
        conversationId: body.conversationId,
        generationId: body.generationId,
        userMessageId: typeof body.userMessageId === "string" ? body.userMessageId : null,
        receiptState: typeof body.receiptState === "string" ? body.receiptState : null,
      };
    }
  }
  return { kind: "refused", status, message: errorMessageOf(data) ?? sendFailedMessage, code };
}

function failedFrom(failure: SendFailure): Extract<SendTurnResult, { kind: "failed" }> {
  switch (failure.kind) {
    case "draining":
      return { kind: "failed", message: failure.message, status: 503, code: "SERVER_DRAINING" };
    case "gateway":
      return { kind: "failed", message: sendGatewayMessage, status: failure.status, code: null };
    case "network":
      return { kind: "failed", message: sendUnreachableMessage, status: null, code: null };
    case "in-progress":
      return { kind: "failed", message: failure.message, status: 409, code: "REQUEST_IN_PROGRESS" };
    case "refused":
      return { kind: "failed", message: failure.message, status: failure.status, code: failure.code };
    default:
      return { kind: "failed", message: sendFailedMessage, status: null, code: null };
  }
}

export interface SendTurnDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Resolves after `ms`, rejects (AbortError) as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
}

/** The browser's: a timer that the turn's abort signal cancels. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) {
    // Drain the body so the connection is released; its words are a proxy's.
    await response.body?.cancel().catch(() => {});
    return null;
  }
  return response.json().catch(() => null);
}

/**
 * POST a turn, and post it again while that is safe (see the header).
 *
 * Throws only when `signal` aborts (Stop, or the view moving on), with the
 * abort's reason, so the caller's existing abort handling applies unchanged.
 */
export async function sendTurn(args: {
  url: string;
  body: string;
  signal: AbortSignal;
  safety: SendSafety;
  /** Required for `verify`: asks the server whether the first attempt landed. */
  verify?: () => Promise<SendVerification>;
  /** A wait has started; the next round is due at `retryAt` (epoch ms). */
  onWaiting?: (info: { retryAt: number; failure: SendFailure; round: number }) => void;
  /** A round after the first is going out now. */
  onRetrying?: (round: number) => void;
  deps: SendTurnDeps;
}): Promise<SendTurnResult> {
  const { deps, signal } = args;
  const started = deps.now();
  let rounds = 0;
  let waits = 0;
  let needsVerify = false;
  let failure: SendFailure = { kind: "network" };

  for (;;) {
    rounds++;
    if (needsVerify) {
      let verdict: SendVerification = { state: "unknown" };
      try {
        if (args.verify) verdict = await args.verify();
      } catch {
        // A check that could not complete proves nothing either way.
      }
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (verdict.state === "landed") {
        return { kind: "landed", running: verdict.running, userMessageId: verdict.userMessageId };
      }
      if (verdict.state === "absent") needsVerify = false;
    }

    if (!needsVerify) {
      if (rounds > 1) args.onRetrying?.(rounds);
      let response: Response | null = null;
      try {
        response = await deps.fetch(args.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: args.body,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failure = { kind: "network" };
      }
      if (response) {
        if (response.ok && response.body) return { kind: "stream", response, rounds };
        const data = response.ok ? null : await readJson(response);
        failure = response.ok
          ? { kind: "refused", status: response.status, message: sendFailedMessage, code: null }
          : classifyResponse({ status: response.status, data, retryAfter: response.headers.get("retry-after"), now: deps.now() });
      }
      if (failure.kind === "session-expired") return { kind: "session-expired" };
      if (failure.kind === "already-submitted") return failure;
      const plan = retryPlan(failure, args.safety);
      if (plan === "stop") return failedFrom(failure);
      if (plan === "verify-then-retry") needsVerify = true;
    }

    if (rounds >= SEND_RETRY.maxRounds) return failedFrom(failure);
    waits++;
    const delay = retryDelayMs(failure, waits, deps.random);
    if (deps.now() - started + delay > SEND_RETRY.budgetMs) return failedFrom(failure);
    args.onWaiting?.({ retryAt: deps.now() + delay, failure, round: rounds });
    await deps.sleep(delay, signal);
  }
}
