import { emptyAnthropicUsage, foldAnthropicUsage, type RawAnthropicUsage } from "@/lib/anthropic-round";
import { compatPromptCacheTokens, type CompatPromptCacheFields } from "@/lib/pricing";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The pure half of the provider proxy at /api/agent/<provider>/<path>.
 *
 * Everything here is free of Prisma, sessions and provider keys so a test can
 * drive it with hand-written streams: the request body limit, the deadlines on
 * the upstream call, reading the provider's own usage out of the bytes as they
 * pass, and the relay that carries those bytes to the client unchanged. The
 * route does the I/O around it — auth, budget, the fetch, and the ledger write.
 */

/**
 * Provider requests are usually small JSON bodies, but Code can also carry
 * image content. Keep a generous ceiling without allowing an authenticated
 * client to make the Next.js process buffer an arbitrary request in memory.
 */
export const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;

export type LimitedBodyResult =
  | { ok: true; body: string }
  | { ok: false; reason: "too_large" | "unreadable" };

/** Read a request body with a hard byte limit, including streamed bodies whose
 * Content-Length header is absent or deliberately inaccurate. */
export async function readLimitedRequestBody(
  req: Request,
  maxBytes = MAX_AGENT_BODY_BYTES,
): Promise<LimitedBodyResult> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!req.body) return { ok: true, body: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("agent request body too large").catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(bytes) };
}

// ---------------------------------------------------------------------------
// Deadlines on the upstream call
// ---------------------------------------------------------------------------

/**
 * Three deadlines where there used to be one.
 *
 * The proxy aborted every upstream call 240 seconds after it started, whatever
 * the provider was doing. That is the right bound for a provider that has gone
 * quiet and the wrong one for a provider that is working: an extended-thinking
 * turn or a long file write streams steadily for five, ten, twenty minutes, and
 * was cut mid-sentence at four with the tokens already paid for. Liveness and
 * duration are different questions, so they get different timers.
 */
export interface UpstreamTimeouts {
  /** From sending the request until the provider's response headers arrive. */
  headersMs: number;
  /** The longest the provider may stay silent while a read is waiting on it. */
  idleMs: number;
  /** The whole exchange, however busy it is. */
  ceilingMs: number;
}

/**
 * A streaming provider answers with headers as soon as it has accepted the
 * request; the wait is queueing and prompt prefill, not generation. Two minutes
 * is four times the Mac client's own 30-second connection limit, so the server
 * never gives up on a request its caller is still prepared to wait for.
 */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

/**
 * Silence, measured only while a read is waiting on the provider: a slow client
 * that has stopped pulling is not the provider going quiet. Anthropic pings and
 * streams thinking; OpenAI reasoning can go silent for minutes before the first
 * token, which is why this is not tighter. It must stay below Node's own fetch
 * limits (undici's `headersTimeout` and `bodyTimeout`, 300 seconds each): above
 * them, undici tears the socket down first and the caller gets an opaque
 * "terminated" instead of a timeout this code can name.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 240_000;

/**
 * The absolute bound, for a stream that never stops producing bytes. A 128K
 * output at a slow 40 tokens a second is under an hour; nothing legitimate runs
 * longer, and nginx's `proxy_read_timeout` in deploy/nginx.conf.template is the
 * same hour between reads.
 */
export const UPSTREAM_CEILING_MS = 60 * 60_000;

/**
 * The deadlines for one request. A request that does not stream receives its
 * whole answer as the response, so the wait for headers IS the generation and
 * is bounded by the idle limit instead of the short streaming one.
 */
export function upstreamTimeoutsFor(streamed: boolean): UpstreamTimeouts {
  return {
    headersMs: streamed ? UPSTREAM_HEADERS_TIMEOUT_MS : UPSTREAM_IDLE_TIMEOUT_MS,
    idleMs: UPSTREAM_IDLE_TIMEOUT_MS,
    ceilingMs: UPSTREAM_CEILING_MS,
  };
}

export type UpstreamTimeoutKind = "headers" | "idle" | "ceiling";

const TIMEOUT_REASONS: Record<UpstreamTimeoutKind, string> = {
  headers: "upstream_headers_timeout",
  idle: "upstream_idle_timeout",
  ceiling: "upstream_ceiling",
};

/** The timer primitives, injectable so a test can count what is still armed. */
export interface UpstreamTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: UpstreamTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface UpstreamAbort {
  signal: AbortSignal;
  /** The response headers arrived: the headers deadline no longer applies. */
  headersReceived(): void;
  /**
   * Wait for the next body chunk under the idle deadline. Each read arms a
   * fresh idle window, so every chunk the provider sends resets it.
   */
  read<T>(next: () => Promise<T>): Promise<T>;
  /** Abort the upstream call now (the client went away) and disarm everything. */
  abort(reason: unknown): void;
  /**
   * From now on, the client going away calls `handler` instead of aborting the
   * upstream call, and the handler decides. Until a response arrives there is
   * nothing to decide — the provider is working for nobody — so this is for
   * the relay, which may still want to read the rest of an answer that is
   * already paid for. The deadlines stay armed either way.
   */
  onClientLeave(handler: (reason: unknown) => void): void;
  /** The exchange is over: clear every timer and the client listener. */
  cancel(): void;
}

/**
 * Bound an upstream provider call by the client's request lifetime and by the
 * three deadlines above. Without them, a provider that accepts a request but
 * never answers can pin a Next.js worker indefinitely.
 */
export function createUpstreamAbort(
  parent: AbortSignal,
  timeouts: UpstreamTimeouts,
  timers: UpstreamTimers = SYSTEM_TIMERS,
): UpstreamAbort {
  const controller = new AbortController();
  let settled = false;
  let headersTimer: unknown = null;
  let idleTimer: unknown = null;
  let ceilingTimer: unknown = null;
  let clientLeft: ((reason: unknown) => void) | null = null;

  const disarm = (handle: unknown) => {
    if (handle !== null) timers.clear(handle);
    return null;
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    headersTimer = disarm(headersTimer);
    idleTimer = disarm(idleTimer);
    ceilingTimer = disarm(ceilingTimer);
    parent.removeEventListener("abort", onParentAbort);
  };
  const abort = (reason: unknown) => {
    cancel();
    if (!controller.signal.aborted) controller.abort(reason);
  };
  function onParentAbort() {
    if (clientLeft) clientLeft(parent.reason);
    else abort(parent.reason);
  }

  if (parent.aborted) {
    abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    headersTimer = timers.set(() => abort(TIMEOUT_REASONS.headers), timeouts.headersMs);
    ceilingTimer = timers.set(() => abort(TIMEOUT_REASONS.ceiling), timeouts.ceilingMs);
  }

  return {
    signal: controller.signal,
    headersReceived() {
      headersTimer = disarm(headersTimer);
    },
    async read<T>(next: () => Promise<T>): Promise<T> {
      // After cancel() nothing may re-arm a timer: a read on a finished
      // exchange runs without a deadline rather than leaving one behind.
      if (settled) return next();
      idleTimer = disarm(idleTimer);
      idleTimer = timers.set(() => abort(TIMEOUT_REASONS.idle), timeouts.idleMs);
      try {
        return await next();
      } finally {
        idleTimer = disarm(idleTimer);
      }
    },
    abort,
    onClientLeave(handler) {
      clientLeft = handler;
    },
    cancel,
  };
}

/** Which deadline aborted this signal, or null when none did. */
export function upstreamTimeoutKind(signal: AbortSignal): UpstreamTimeoutKind | null {
  if (!signal.aborted) return null;
  for (const kind of Object.keys(TIMEOUT_REASONS) as UpstreamTimeoutKind[]) {
    if (signal.reason === TIMEOUT_REASONS[kind]) return kind;
  }
  return null;
}

export function isUpstreamTimeout(signal: AbortSignal): boolean {
  return upstreamTimeoutKind(signal) !== null;
}

/**
 * The headers the client gets back with a provider's response: the media type,
 * and how long the provider asked to be left alone.
 *
 * A 429 or an overload that carries `retry-after` (or OpenAI's exact
 * `retry-after-ms`) is the provider saying when to come back, and the Mac's
 * retry policy honours it; dropping it here left that policy guessing with
 * backoff. Nothing else crosses: request ids, organisation names and rate-limit
 * ledgers are the provider's business, not the client's.
 */
export const RELAYED_RESPONSE_HEADERS = ["content-type", "retry-after", "retry-after-ms"] as const;

export function relayedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  return headers;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The three wire formats the proxy forwards, one per allowed path. */
export type ProviderWire = "anthropic" | "openai-chat" | "openai-responses";

export function providerWire(kind: "anthropic" | "openai", forwardPath: string): ProviderWire | null {
  if (kind === "anthropic") return forwardPath === "v1/messages" ? "anthropic" : null;
  if (forwardPath === "chat/completions") return "openai-chat";
  if (forwardPath === "responses") return "openai-responses";
  return null;
}

export interface AgentRequest {
  /** What to forward: the client's own bytes, unless usage had to be switched on. */
  body: string;
  /** The provider model id the body names. */
  model: string;
  streamed: boolean;
  /** Asked for the premium tier: Anthropic `speed:"fast"`, OpenAI `service_tier:"priority"`. */
  fastRequested: boolean;
  /**
   * Characters of text the request puts in front of the model: system prompt,
   * messages, tool results and tool definitions, without image or file bytes.
   * The floor a call is billed at when the provider never says what it used.
   */
  promptChars: number;
}

/** What the proxy will forward, or why it will not. */
export type AgentRequestCheck = { ok: true; request: AgentRequest } | { ok: false; error: string };

/** No provider names a model at anything like this length; a longer id is not a model. */
const MAX_MODEL_ID_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(error: string): AgentRequestCheck {
  return { ok: false, error };
}

/**
 * Read what billing needs from the client's body, refuse a body that billing
 * and the provider could read differently, and make sure a streamed Chat
 * Completions call will report its usage.
 *
 * Billing is only as good as the proxy's reading of the request, so the proxy
 * forwards nothing it cannot read the way the provider will. A body JSON.parse
 * rejects (a lax host accepts `NaN`), a `stream` that is not a boolean (a lax
 * host coerces `1` to true), or a key named twice (parsers disagree on which
 * one wins) would each let the provider stream an answer the proxy believes is
 * something else — unmetered, or priced as another model. None of Juno's
 * clients sends any of them, so each is refused rather than guessed at.
 *
 * On the Responses wire, `background` is refused too: a background response
 * comes back `queued` with no usage while OpenAI runs the whole generation on
 * Juno's key, so it can never be billed. `previous_response_id` and
 * `conversation` go with it — they are how a stored background result would be
 * pulled into a cheap follow-up, and they reach responses stored under Juno's
 * key rather than the caller's. The Mac client uses none of the three.
 *
 * OpenAI-compatible providers send usage on a stream only when
 * `stream_options.include_usage` is true; without it the proxy sees the whole
 * answer go by and learns nothing about what it cost. Both of Juno's clients
 * already ask for it. The body is rewritten only when that flag is not already
 * true — an explicit `false` included, because honouring it would be a way to
 * make paid calls the ledger cannot see — and is forwarded byte for byte
 * otherwise. The extra final chunk carries an empty `choices` array, which the
 * OpenAI stream format has always allowed.
 */
export function inspectAgentRequest(wire: ProviderWire, raw: string): AgentRequestCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("The request body is not valid JSON.");
  }
  if (!isRecord(parsed)) return refuse("The request body must be a JSON object.");
  if (hasRepeatedKey(raw)) return refuse("The request body names the same field more than once.");

  const rawModel = parsed.model;
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model || model.length > MAX_MODEL_ID_CHARS) return refuse("The request must name a model.");
  if (Object.hasOwn(parsed, "stream") && typeof parsed.stream !== "boolean") {
    return refuse("`stream` must be true or false.");
  }
  if (wire === "openai-responses") {
    if (Object.hasOwn(parsed, "background") && parsed.background !== false) {
      return refuse(`Background responses are not available through ${PRODUCT_NAME}.`);
    }
    if (parsed.previous_response_id != null || parsed.conversation != null) {
      return refuse(`Send the whole conversation: stored responses are not available through ${PRODUCT_NAME}.`);
    }
  }

  const streamed = parsed.stream === true;
  const fastRequested = wire === "anthropic" ? parsed.speed === "fast" : parsed.service_tier === "priority";

  let body = raw;
  if (wire === "openai-chat" && streamed) {
    const options = isRecord(parsed.stream_options) ? parsed.stream_options : null;
    if (options?.include_usage !== true) {
      body = JSON.stringify({ ...parsed, stream_options: { ...options, include_usage: true } });
    }
  }
  return {
    ok: true,
    request: { body, model, streamed, fastRequested, promptChars: promptTextChars(wire, parsed) },
  };
}

/**
 * Clamp a proxied request's output allowance to what the account can still pay
 * for (USAGE_METERING_AUDIT.md, "per-request cap").
 *
 * The proxy checks the month and the windows before forwarding, but a single
 * request could still ask a frontier model for 128k output tokens with a few
 * cents left — and the provider bills every one. When `cap` is below what the
 * request asks for (or it asks for nothing), the allowance is lowered to `cap`:
 *  - anthropic: `max_tokens`, and an extended-thinking `budget_tokens` that no
 *    longer fits under it is lowered to `cap - 1024` (it must stay below
 *    max_tokens and at least 1,024), so pass a cap of at least 2,048;
 *  - openai-chat: whichever of `max_completion_tokens` / `max_tokens` is set,
 *    or `missingField` when neither is;
 *  - openai-responses: `max_output_tokens`.
 * Returns the body unchanged when nothing needed lowering.
 */
export function capOutputTokens(
  wire: ProviderWire,
  body: string,
  cap: number | null,
  missingField: "max_tokens" | "max_completion_tokens" = "max_tokens"
): string {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  const limit = Math.floor(cap);
  const over = (value: unknown) => typeof value !== "number" || !Number.isFinite(value) || value > limit;
  let changed = false;
  if (wire === "anthropic") {
    if (over(parsed.max_tokens)) {
      parsed.max_tokens = limit;
      changed = true;
    }
    const thinking = isRecord(parsed.thinking) ? parsed.thinking : null;
    const maxTokens = parsed.max_tokens as number;
    if (thinking && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= maxTokens) {
      parsed.thinking = { ...thinking, budget_tokens: Math.max(1_024, maxTokens - 1_024) };
      changed = true;
    }
  } else if (wire === "openai-chat") {
    const field =
      parsed.max_completion_tokens != null ? "max_completion_tokens" : parsed.max_tokens != null ? "max_tokens" : missingField;
    if (over(parsed[field])) {
      parsed[field] = limit;
      changed = true;
    }
  } else if (over(parsed.max_output_tokens)) {
    parsed.max_output_tokens = limit;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : body;
}

/**
 * Whether any object in `raw`, already known to be valid JSON, names a key
 * twice. JSON.parse keeps the last; some parsers keep the first, and some
 * refuse. Keys are compared decoded, so `"mod\u0065l"` repeats `"model"`.
 *
 * A single pass that jumps from quote to quote, so a body made mostly of long
 * strings (base64 images) costs little more than finding their ends.
 */
export function hasRepeatedKey(raw: string): boolean {
  // One entry per open container: the keys seen so far, or null for an array.
  const scopes: Array<Set<string> | null> = [];
  let expectingKey = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x22) {
      const close = closingQuote(raw, i);
      const scope = scopes[scopes.length - 1];
      if (expectingKey && scope) {
        const literal = raw.slice(i + 1, close);
        const key = literal.includes("\\") ? (JSON.parse(`"${literal}"`) as string) : literal;
        if (scope.has(key)) return true;
        scope.add(key);
        expectingKey = false;
      }
      i = close;
    } else if (code === 0x7b) {
      scopes.push(new Set());
      expectingKey = true;
    } else if (code === 0x5b) {
      scopes.push(null);
      expectingKey = false;
    } else if (code === 0x7d || code === 0x5d) {
      scopes.pop();
      expectingKey = false;
    } else if (code === 0x2c) {
      expectingKey = scopes[scopes.length - 1] != null;
    }
  }
  return false;
}

/** The index of the quote that closes the string opening at `open`: the first one not escaped. */
function closingQuote(raw: string, open: number): number {
  let from = open + 1;
  for (;;) {
    const quote = raw.indexOf('"', from);
    if (quote === -1) return raw.length;
    let backslashes = 0;
    while (raw.charCodeAt(quote - 1 - backslashes) === 0x5c) backslashes++;
    if (backslashes % 2 === 0) return quote;
    from = quote + 1;
  }
}

/** The top-level fields each wire's prompt is made of. */
const PROMPT_FIELDS: Record<ProviderWire, readonly string[]> = {
  anthropic: ["system", "messages", "tools"],
  "openai-chat": ["messages", "tools"],
  "openai-responses": ["instructions", "input", "tools"],
};

/**
 * Keys whose values the model does not read as text: base64 images, audio and
 * files (`data`, `file_data`, `image_url`), and the opaque blobs a provider
 * hands back to itself (thinking `signature`, Responses `encrypted_content`,
 * redacted thinking's `data`). Counting them would bill a screenshot as a
 * novel.
 */
const OPAQUE_KEYS = new Set(["data", "file_data", "image_url", "signature", "encrypted_content"]);

/**
 * The prompt's text, in characters: every string in the fields that make up
 * the prompt, walked without recursion so no nesting depth can stop the count
 * short. Object keys are left out, so this sits a little under the tokens the
 * provider counts, which is the right side for a floor to be on.
 */
export function promptTextChars(wire: ProviderWire, body: Record<string, unknown>): number {
  let total = 0;
  const pending: unknown[] = PROMPT_FIELDS[wire].map((field) => body[field]);
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      total += value.length;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (!OPAQUE_KEYS.has(key)) pending.push(value[key]);
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Usage, read from the provider's own response
// ---------------------------------------------------------------------------

/**
 * What one provider call reported about itself, in the shape `recordSpend`
 * takes. Token counts keep each provider's own convention, because
 * `normalizeUsage` in pricing.ts is written against them: Anthropic's
 * `input_tokens` EXCLUDES cache reads and writes, OpenAI's `prompt_tokens` and
 * `input_tokens` INCLUDE the cached portion.
 */
export interface ProxyUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearchRequests?: number;
  /**
   * The request's text, sent only when the provider reported no usage at all.
   * With reported usage it must stay out: `resolveBillableTokens` fills an
   * absent prompt count from it, and Anthropic's `input_tokens` can be zero on
   * a fully cached prompt, which would then bill the prompt again at full rate
   * on top of its cache reads.
   */
  promptChars?: number;
  /**
   * Streamed answer, tool-argument and reasoning characters. `resolveBillableTokens`
   * bills the higher of these (at four characters a token) and the reported
   * output, which is what stops an Anthropic stream cut before its final
   * `message_delta` from billing as a one-token reply. The chat route passes
   * the same floor.
   */
  completionChars?: number;
  reasoningChars?: number;
  fastMode: boolean;
}

/** What one call is billed at, and whether that came from the provider or the floor. */
export interface MeteredUsage {
  usage: ProxyUsage;
  /**
   * True when the provider reported nothing and the usage is the character
   * floor: the request's text plus whatever streamed before the end.
   */
  estimated: boolean;
}

/** An SSE line or event, or a JSON body, larger than this is relayed but not metered. */
const MAX_METERED_CHARS = MAX_AGENT_BODY_BYTES;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function chars(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * The reasoning in one Chat Completions delta, under whichever name its host
 * uses: `reasoning_content` (DeepSeek, Moonshot), `reasoning` (OpenRouter
 * style), `thought`, `thinking`, or `reasoning_details` text. Read in the Mac
 * decoder's order and only the first that is present, because a host that
 * sends two of them sends the same text twice.
 */
function chatReasoningChars(delta: Record<string, unknown>): number {
  for (const key of ["reasoning_content", "reasoning", "thought", "thinking"]) {
    const length = chars(delta[key]);
    if (length > 0) return length;
  }
  if (!Array.isArray(delta.reasoning_details)) return 0;
  let total = 0;
  for (const detail of delta.reasoning_details) if (isRecord(detail)) total += chars(detail.text);
  return total;
}

/**
 * Reads usage out of a provider response as it streams past, keeping no more of
 * a stream than the event in hand.
 *
 *   Anthropic Messages — `message_start.message.usage` (input and cache),
 *     then `message_delta.usage` (the final `output_tokens`). The counters are
 *     cumulative within a request, so they are folded by maximum, exactly as
 *     the chat adapter does (`foldAnthropicUsage`).
 *   OpenAI Chat Completions — the chunk that carries `usage`, which with
 *     `include_usage` is the last one. Last non-null wins, for the providers
 *     that repeat a running total on every chunk.
 *   OpenAI Responses — `response.completed`, or `.incomplete` / `.failed`,
 *     whose `response.usage` is the whole call.
 *
 * A non-streamed body is buffered (up to the same limit as a request) and read
 * once at the end. SSE framing follows the spec closely enough for every
 * provider Juno proxies: lines end in LF or CRLF, a blank line ends an event,
 * multi-line `data:` joins with a newline, comments and other fields are
 * ignored. A line or event split across network chunks is reassembled, and so
 * is a UTF-8 character split across them.
 *
 * When the provider reported nothing — a Chat Completions or Responses stream
 * cut before its last event, an Anthropic stream cut before `message_start`, a
 * host that ignores `include_usage` — the call is billed at the character
 * floor instead: the request's text and everything that streamed, four
 * characters a token, as the chat route bills a partial generation. Billing
 * nothing there would let any client make every call free by hanging up just
 * before the usage arrives, and the budget gates, which read only the ledger,
 * would never close. The floor misses what never streams (hidden reasoning),
 * so it stays below the provider's own count.
 */
export class UsageMeter {
  private readonly decoder = new TextDecoder();
  private pending = "";
  /** Set when an oversized line was dropped; its remainder is skipped too. */
  private discarding = false;
  private dataLines: string[] = [];
  private dataChars = 0;
  private overflowed = false;
  private readonly anthropic = emptyAnthropicUsage();
  private openaiUsage: Record<string, unknown> | null = null;
  private servedTier: string | null = null;
  private webSearchCalls = 0;
  private textChars = 0;
  private reasoningChars = 0;
  /** The provider refused or failed in-band, inside a 2xx response. */
  private sawError = false;
  /** Chat Completions choices seen, and those that have a finish_reason. */
  private readonly openChoices = new Set<number>();
  private readonly finishedChoices = new Set<number>();
  private result: MeteredUsage | null | undefined;

  constructor(
    private readonly wire: ProviderWire,
    readonly format: "sse" | "json",
    private readonly fastRequested: boolean,
    /** The request's text in characters (`AgentRequest.promptChars`), for the floor. */
    private readonly promptChars = 0,
  ) {}

  /**
   * Whether the provider has finished the answer, so the rest of the body
   * costs nothing more to read and may still carry the bill: a non-streamed
   * response is complete before its first byte, and a Chat Completions stream
   * whose every choice has a `finish_reason` has only the usage chunk to come.
   */
  get answerComplete(): boolean {
    if (this.format === "json") return true;
    if (this.wire !== "openai-chat" || this.finishedChoices.size === 0) return false;
    for (const index of this.openChoices) if (!this.finishedChoices.has(index)) return false;
    return true;
  }

  /** Feed one chunk of the response body. Never throws. */
  observe(chunk: Uint8Array): void {
    if (this.result !== undefined) return;
    try {
      const text = this.decoder.decode(chunk, { stream: true });
      if (this.format === "json") this.appendJson(text);
      else this.feedSse(text);
    } catch {
      // Metering is a passenger. A body this cannot parse still reaches the
      // client exactly as it was sent.
    }
  }

  /**
   * What to bill: the usage the provider reported, or else the character
   * floor. Null only when there is nothing to bill — an empty request that
   * produced nothing, or a provider that refused in-band before producing
   * anything, which is a refusal like a non-2xx one. Safe to call more than
   * once; the first call closes the meter.
   */
  finish(): MeteredUsage | null {
    if (this.result !== undefined) return this.result;
    let reported: ProxyUsage | null = null;
    try {
      const rest = this.decoder.decode();
      if (this.format === "json") {
        this.appendJson(rest);
        if (!this.overflowed && this.pending) this.dispatch(this.pending);
      } else {
        if (rest) this.feedSse(rest);
        // A stream may end without the blank line that closes its last event.
        if (this.pending && !this.discarding) this.line(this.pending);
        this.endEvent();
      }
      this.pending = "";
      reported = this.compose();
    } catch {
      // Whatever went wrong reading the end, the floor below still holds.
    }
    this.result = reported ? { usage: reported, estimated: false } : this.floor();
    return this.result;
  }

  private floor(): MeteredUsage | null {
    const streamed = this.textChars + this.reasoningChars;
    if (this.sawError && streamed === 0) return null;
    if (this.promptChars + streamed <= 0) return null;
    return {
      estimated: true,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        promptChars: this.promptChars || undefined,
        completionChars: this.textChars || undefined,
        reasoningChars: this.reasoningChars || undefined,
        fastMode: this.servedFast(),
      },
    };
  }

  /** What the provider says it served outranks what was asked for. */
  private servedFast(): boolean {
    if (this.wire === "anthropic") {
      return this.anthropic.speed != null ? this.anthropic.speed === "fast" : this.fastRequested;
    }
    return this.servedTier != null ? this.servedTier === "priority" : this.fastRequested;
  }

  private appendJson(text: string): void {
    if (this.overflowed || !text) return;
    if (this.pending.length + text.length > MAX_METERED_CHARS) {
      this.overflowed = true;
      this.pending = "";
      return;
    }
    this.pending += text;
  }

  private feedSse(text: string): void {
    const buffer = this.pending + text;
    let start = 0;
    let newline = buffer.indexOf("\n", start);
    while (newline !== -1) {
      if (this.discarding) this.discarding = false;
      else this.line(buffer.slice(start, newline));
      start = newline + 1;
      newline = buffer.indexOf("\n", start);
    }
    this.pending = buffer.slice(start);
    if (this.pending.length > MAX_METERED_CHARS) {
      this.pending = "";
      this.discarding = true;
    }
  }

  private line(raw: string): void {
    // A CRLF split across chunks leaves its CR on this side of the LF.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      this.endEvent();
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5);
    this.dataChars += value.length;
    if (this.dataChars > MAX_METERED_CHARS) {
      this.dataLines = [];
      this.dataChars = 0;
      return;
    }
    this.dataLines.push(value);
  }

  private endEvent(): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.length === 1 ? this.dataLines[0] : this.dataLines.join("\n");
    this.dataLines = [];
    this.dataChars = 0;
    this.dispatch(data);
  }

  private dispatch(data: string): void {
    if (data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (this.wire === "anthropic") this.readAnthropic(event);
    else if (this.wire === "openai-chat") this.readChat(event);
    else this.readResponses(event);
  }

  private readAnthropic(event: Record<string, unknown>): void {
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message)) this.foldAnthropic(event.message.usage);
        return;
      case "message_delta":
      case "message": // a non-streamed response is the message itself
        this.foldAnthropic(event.usage);
        return;
      case "content_block_delta": {
        const delta = event.delta;
        if (!isRecord(delta)) return;
        if (delta.type === "text_delta") this.textChars += chars(delta.text);
        else if (delta.type === "input_json_delta") this.textChars += chars(delta.partial_json);
        else if (delta.type === "thinking_delta") this.reasoningChars += chars(delta.thinking);
        return;
      }
      case "error":
        this.sawError = true;
        return;
    }
  }

  private foldAnthropic(usage: unknown): void {
    if (isRecord(usage)) foldAnthropicUsage(this.anthropic, usage as RawAnthropicUsage);
  }

  private readChat(event: Record<string, unknown>): void {
    if (isRecord(event.usage)) this.openaiUsage = event.usage;
    if (typeof event.service_tier === "string") this.servedTier = event.service_tier;
    // Several compatible hosts report a failure as a 200 stream with an
    // `error` payload instead of an error status.
    if (event.error != null) this.sawError = true;
    if (!Array.isArray(event.choices)) return;
    for (const choice of event.choices) {
      if (!isRecord(choice)) continue;
      const index = typeof choice.index === "number" ? choice.index : 0;
      this.openChoices.add(index);
      if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finishedChoices.add(index);
      if (!isRecord(choice.delta)) continue;
      const delta = choice.delta;
      this.textChars += chars(delta.refusal);
      if (Array.isArray(delta.content)) {
        // The content-parts form a few hosts stream, thinking parts included.
        for (const part of delta.content) {
          if (!isRecord(part)) continue;
          if (part.type === "text") this.textChars += chars(part.text);
          else if (part.type === "thinking" || part.type === "reasoning") {
            this.reasoningChars += chars(part.thinking) || chars(part.text);
          }
        }
      } else {
        this.textChars += chars(delta.content);
      }
      this.reasoningChars += chatReasoningChars(delta);
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const call of delta.tool_calls) {
        if (isRecord(call) && isRecord(call.function)) this.textChars += chars(call.function.arguments);
      }
    }
  }

  private readResponses(event: Record<string, unknown>): void {
    switch (event.type) {
      case "response.created":
      case "response.in_progress":
      case "response.completed":
      case "response.incomplete":
        if (isRecord(event.response)) this.readResponseObject(event.response);
        return;
      case "response.failed":
        this.sawError = true;
        if (isRecord(event.response)) this.readResponseObject(event.response);
        return;
      case "error":
        this.sawError = true;
        return;
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.function_call_arguments.delta":
        this.textChars += chars(event.delta);
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.reasoningChars += chars(event.delta);
        return;
    }
    // A non-streamed response is the response object itself.
    if (event.object === "response") this.readResponseObject(event);
  }

  private readResponseObject(response: Record<string, unknown>): void {
    if (isRecord(response.usage)) this.openaiUsage = response.usage;
    if (typeof response.service_tier === "string") this.servedTier = response.service_tier;
    if (Array.isArray(response.output)) {
      // Hosted web search is billed per call on top of tokens, and a finished
      // response lists every call it made.
      const calls = response.output.filter((item) => isRecord(item) && item.type === "web_search_call").length;
      if (calls > this.webSearchCalls) this.webSearchCalls = calls;
    }
  }

  private compose(): ProxyUsage | null {
    const completionChars = this.textChars || undefined;
    const reasoningChars = this.reasoningChars || undefined;

    if (this.wire === "anthropic") {
      const u = this.anthropic;
      if (u.input + u.output + u.cacheRead + u.cacheWrite <= 0) return null;
      return {
        promptTokens: u.input,
        completionTokens: u.output,
        reasoningTokens: u.reasoning || undefined,
        cacheRead: u.cacheRead || undefined,
        cacheWrite: u.cacheWrite || undefined,
        cacheWrite5m: u.cacheWrite5m || undefined,
        cacheWrite1h: u.cacheWrite1h || undefined,
        webSearchRequests: u.webSearchRequests || undefined,
        completionChars,
        reasoningChars,
        // A provider that reports no speed leaves the request to decide, as in
        // the chat adapter.
        fastMode: this.servedFast(),
      };
    }

    const u = this.openaiUsage;
    if (!u) return null;
    const fastMode = this.servedFast();

    if (this.wire === "openai-chat") {
      const promptTokens = count(u.prompt_tokens);
      const completionTokens = count(u.completion_tokens);
      const totalTokens = count(u.total_tokens);
      if (promptTokens + completionTokens + totalTokens <= 0) return null;
      const cache = compatPromptCacheTokens(u as CompatPromptCacheFields);
      const details = isRecord(u.completion_tokens_details) ? u.completion_tokens_details : {};
      return {
        promptTokens,
        completionTokens,
        reasoningTokens: count(details.reasoning_tokens) || undefined,
        totalTokens: totalTokens || undefined,
        cacheRead: cache.cacheRead || undefined,
        cacheWrite: cache.cacheWrite || undefined,
        completionChars,
        reasoningChars,
        fastMode,
      };
    }

    const promptTokens = count(u.input_tokens);
    const completionTokens = count(u.output_tokens);
    const totalTokens = count(u.total_tokens);
    if (promptTokens + completionTokens + totalTokens <= 0) return null;
    const input = isRecord(u.input_tokens_details) ? u.input_tokens_details : {};
    const output = isRecord(u.output_tokens_details) ? u.output_tokens_details : {};
    return {
      promptTokens,
      completionTokens,
      reasoningTokens: count(output.reasoning_tokens) || undefined,
      totalTokens: totalTokens || undefined,
      cacheRead: count(input.cached_tokens) || undefined,
      // GPT-5.6 and later name cache writes `cache_write_tokens`; older
      // payloads said `cache_creation_tokens`. Same reading as the chat adapter.
      cacheWrite: count(input.cache_write_tokens) || count(input.cache_creation_tokens) || undefined,
      webSearchRequests: this.webSearchCalls || undefined,
      completionChars,
      reasoningChars,
      fastMode,
    };
  }
}

/**
 * A meter for this response, or null when there is nothing to read: a refusal
 * (non-2xx) carries no usage, and a content type that is neither SSE nor JSON
 * is not a model response.
 */
export function usageMeterFor(
  wire: ProviderWire,
  response: { ok: boolean; headers: Headers },
  request: Pick<AgentRequest, "fastRequested" | "promptChars">,
): UsageMeter | null {
  if (!response.ok) return null;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const format = type.includes("text/event-stream") ? "sse" : type.includes("json") ? "json" : null;
  return format ? new UsageMeter(wire, format, request.fastRequested, request.promptChars) : null;
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

/** How the exchange ended: the provider finished, it failed or timed out, or the client left. */
export type RelayOutcome = "completed" | "failed" | "cancelled";

/**
 * The most the relay reads on its own once the client has gone: a response as
 * large as a request may be. Past it the meter has stopped counting anyway.
 */
const MAX_DRAIN_BYTES = MAX_AGENT_BODY_BYTES;

/**
 * Carry the provider's body to the client unchanged, and say exactly once how
 * it ended.
 *
 * Pull-based, so the provider is read only as fast as the client takes bytes
 * and the idle deadline measures the provider's silence, not the client's. Each
 * chunk is handed on before it is observed, so metering never delays a byte,
 * and an observer that throws is ignored rather than allowed near the stream.
 *
 * `onEnd` runs once, whichever comes first: the provider's last byte, an
 * upstream error or deadline, or the client going away. That single call is
 * what makes billing happen on every path, including a disconnect halfway
 * through, and never twice. It runs after the timers are cleared, so nothing
 * is left armed behind a finished exchange.
 *
 * When the client goes away — its body cancelled or its request aborted,
 * whichever Next.js reports first — the relay usually hangs up on the provider
 * at once, because a provider still generating is spending for nobody. The
 * exception is an answer the provider has already finished (`answerComplete`):
 * what is left of it costs nothing more, and it is where the usage is — at the
 * end of a JSON body, in the last chunk of a Chat Completions stream. Hanging
 * up there would turn an exact bill into an estimate for a client that merely
 * stopped reading a few bytes early, so the relay reads the rest itself, under
 * the same deadlines, and ends only then.
 */
export function relayUpstreamBody(input: {
  body: ReadableStream<Uint8Array>;
  abort: UpstreamAbort;
  observe?: (chunk: Uint8Array) => void;
  /** Asked once, when the client leaves: is the provider's answer already complete? */
  answerComplete?: () => boolean;
  onEnd: (outcome: RelayOutcome) => void;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let ended = false;
  let left = false;
  // The read `pull` is waiting on. If the client leaves meanwhile, a drain
  // takes it over, so the chunk it brings is observed exactly once.
  let inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  const end = (outcome: RelayOutcome): void => {
    if (ended) return;
    ended = true;
    input.abort.cancel();
    try {
      input.onEnd(outcome);
    } catch {
      // Whatever the caller does with the ending, it must not reach the stream.
    }
  };

  const observe = (chunk: Uint8Array): void => {
    if (!input.observe) return;
    try {
      input.observe(chunk);
    } catch {
      // The chunk is already on its way; a metering fault stays here.
    }
  };

  // Through the reader, which holds the lock — `body.cancel()` on a locked
  // stream rejects and would leave the provider generating for nobody — and
  // through the fetch signal, which closes the connection itself.
  const hangUp = (reason: unknown): void => {
    input.abort.abort(reason ?? "client_closed");
    reader.cancel(reason).catch(() => undefined);
  };

  const drain = async (reason: unknown): Promise<void> => {
    let complete = false;
    try {
      let taken = inflight;
      inflight = null;
      let drained = 0;
      for (;;) {
        const result = await (taken ?? input.abort.read(() => reader.read()));
        taken = null;
        if (result.done) {
          complete = true;
          break;
        }
        observe(result.value);
        drained += result.value.byteLength;
        if (drained > MAX_DRAIN_BYTES) break;
      }
    } catch {
      // The provider failed or a deadline fired while the rest was read: the
      // meter bills what arrived.
    }
    end("cancelled");
    if (!complete) hangUp(reason);
  };

  const leave = (reason: unknown): void => {
    if (ended || left) return;
    left = true;
    // When the request signal reports the leaving first, the stream towards
    // the client is still open: close it as failed, so nothing waits on it and
    // no further pull can race a drain for the provider's chunks. After a
    // cancel this does nothing.
    try {
      downstream?.error(reason ?? "client_closed");
    } catch {
      // Already closed.
    }
    let complete = false;
    try {
      complete = input.answerComplete?.() ?? false;
    } catch {
      // Unknown is not complete: hang up.
    }
    if (complete) {
      void drain(reason);
      return;
    }
    end("cancelled");
    hangUp(reason);
  };

  input.abort.onClientLeave(leave);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
    },
    async pull(controller) {
      if (ended || left) return;
      const read = input.abort.read(() => reader.read());
      inflight = read;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await read;
      } catch (error) {
        // The client left, and this is the read that hanging up interrupted,
        // or that a drain now owns.
        if (ended || left) return;
        inflight = null;
        const signal = input.abort.signal;
        controller.error(error);
        end(signal.aborted && !isUpstreamTimeout(signal) ? "cancelled" : "failed");
        return;
      }
      // The client left while this read was in flight: the stream is closed,
      // and a drain, if there is one, has this chunk.
      if (ended || left) return;
      inflight = null;
      if (result.done) {
        // The client's end of stream first, the bookkeeping after it.
        controller.close();
        end("completed");
        return;
      }
      controller.enqueue(result.value);
      observe(result.value);
    },
    cancel(reason) {
      leave(reason);
    },
  });
}
