import { emptyAnthropicUsage, foldAnthropicUsage, type RawAnthropicUsage } from "@/lib/anthropic-round";
import { compatPromptCacheTokens, type CompatPromptCacheFields } from "@/lib/pricing";

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
    abort(parent.reason);
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
  /** The provider model id the body names, or null when it names none. */
  model: string | null;
  streamed: boolean;
  /** Asked for the premium tier: Anthropic `speed:"fast"`, OpenAI `service_tier:"priority"`. */
  fastRequested: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read what billing needs from the client's body, and make sure a streamed
 * Chat Completions call will report its usage.
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
export function inspectAgentRequest(wire: ProviderWire, raw: string): AgentRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, model: null, streamed: false, fastRequested: false };
  }
  if (!isRecord(parsed)) return { body: raw, model: null, streamed: false, fastRequested: false };

  const model =
    typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim().slice(0, 200) : null;
  const streamed = parsed.stream === true;
  const fastRequested = wire === "anthropic" ? parsed.speed === "fast" : parsed.service_tier === "priority";

  let body = raw;
  if (wire === "openai-chat" && streamed) {
    const options = isRecord(parsed.stream_options) ? parsed.stream_options : null;
    if (options?.include_usage !== true) {
      body = JSON.stringify({ ...parsed, stream_options: { ...options, include_usage: true } });
    }
  }
  return { body, model, streamed, fastRequested };
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

/** An SSE line or event, or a JSON body, larger than this is relayed but not metered. */
const MAX_METERED_CHARS = MAX_AGENT_BODY_BYTES;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function chars(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
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
  private result: ProxyUsage | null | undefined;

  constructor(
    private readonly wire: ProviderWire,
    private readonly format: "sse" | "json",
    private readonly fastRequested: boolean,
  ) {}

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
   * The usage the provider reported, or null when it reported none. Safe to
   * call more than once; the first call closes the meter.
   */
  finish(): ProxyUsage | null {
    if (this.result !== undefined) return this.result;
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
      this.result = this.compose();
    } catch {
      this.result = null;
    }
    return this.result;
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
    }
  }

  private foldAnthropic(usage: unknown): void {
    if (isRecord(usage)) foldAnthropicUsage(this.anthropic, usage as RawAnthropicUsage);
  }

  private readChat(event: Record<string, unknown>): void {
    if (isRecord(event.usage)) this.openaiUsage = event.usage;
    if (typeof event.service_tier === "string") this.servedTier = event.service_tier;
    if (!Array.isArray(event.choices)) return;
    for (const choice of event.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue;
      const delta = choice.delta;
      this.textChars += chars(delta.content);
      // `reasoning_content` is DeepSeek's and Moonshot's name; `reasoning`
      // is OpenRouter-style and a few hosts'.
      this.reasoningChars += chars(delta.reasoning_content) + chars(delta.reasoning);
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
      case "response.failed":
        if (isRecord(event.response)) this.readResponseObject(event.response);
        return;
      case "response.output_text.delta":
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
        // What the provider says it served outranks what was asked for; a
        // provider that reports no speed leaves the request to decide, as in
        // the chat adapter.
        fastMode: u.speed != null ? u.speed === "fast" : this.fastRequested,
      };
    }

    const u = this.openaiUsage;
    if (!u) return null;
    const fastMode = this.servedTier != null ? this.servedTier === "priority" : this.fastRequested;

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
  fastRequested: boolean,
): UsageMeter | null {
  if (!response.ok) return null;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/event-stream")) return new UsageMeter(wire, "sse", fastRequested);
  if (type.includes("json")) return new UsageMeter(wire, "json", fastRequested);
  return null;
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

/** How the exchange ended: the provider finished, it failed or timed out, or the client left. */
export type RelayOutcome = "completed" | "failed" | "cancelled";

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
 */
export function relayUpstreamBody(input: {
  body: ReadableStream<Uint8Array>;
  abort: UpstreamAbort;
  observe?: (chunk: Uint8Array) => void;
  onEnd: (outcome: RelayOutcome) => void;
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader();
  let ended = false;
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

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await input.abort.read(() => reader.read());
      } catch (error) {
        // Already ended: the client left, and this is the read that aborting
        // the provider for it interrupted.
        if (ended) return;
        const signal = input.abort.signal;
        controller.error(error);
        end(signal.aborted && !isUpstreamTimeout(signal) ? "cancelled" : "failed");
        return;
      }
      // The client left while this read was in flight; the stream is closed.
      if (ended) return;
      if (result.done) {
        // The client's end of stream first, the bookkeeping after it.
        controller.close();
        end("completed");
        return;
      }
      controller.enqueue(result.value);
      if (input.observe) {
        try {
          input.observe(result.value);
        } catch {
          // The chunk is already on its way; a metering fault stays here.
        }
      }
    },
    async cancel(reason) {
      end("cancelled");
      // Through the reader, which holds the lock — `body.cancel()` on a locked
      // stream rejects and would leave the provider generating for nobody —
      // and through the fetch signal, which closes the connection itself.
      input.abort.abort(reason ?? "client_closed");
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
