import { compatPromptCacheTokens, type CompatPromptCacheFields } from "@/lib/pricing";

/**
 * The parts of one OpenAI-compatible streaming round that are pure.
 *
 * Split out of `openai-compat.ts` for the reason `anthropic-round.ts` was split
 * out of `anthropic.ts`: that module is `server-only` and constructs an SDK
 * client at import time, so the two pieces most worth pinning — how streamed
 * tool-call fragments are reassembled, and how usage counters are merged —
 * could not be exercised at all. Thirteen providers share this adapter and each
 * one streams these fields slightly differently; every rule below exists
 * because one of them does something the OpenAI reference implementation does
 * not.
 */

export interface CompatToolCall {
  id: string;
  name: string;
  /** Accumulated `function.arguments` fragments, unparsed. */
  args: string;
}

export interface CompatToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Which accumulator slot a fragment belongs to.
 *
 * `index` is OPTIONAL on several compat hosts, and at least one restarts it at
 * 0 for every call in a parallel batch. Keying the map on `tc.index` alone
 * therefore collapsed every call of such a batch into a single entry (under
 * `undefined`, or under `0`), so a two-tool turn ran one tool — silently, with
 * the other call's arguments concatenated onto the first. The id is the only
 * identifier that is unique per call when it is present, so it wins; index is
 * the fallback; a fragment with neither belongs to the call most recently
 * opened, which is the only thing a stream in wire order can mean.
 */
function slotFor(acc: Map<string, CompatToolCall>, delta: CompatToolCallDelta): string {
  if (delta.id) {
    for (const [key, value] of acc) {
      if (value.id === delta.id) return key;
    }
    if (typeof delta.index === "number") {
      const indexKey = `index:${delta.index}`;
      const existing = acc.get(indexKey);
      // A reused index with a DIFFERENT id is a second call, not more of the
      // first one.
      if (!existing || !existing.id) return indexKey;
    }
    return `id:${delta.id}`;
  }
  if (typeof delta.index === "number") return `index:${delta.index}`;
  const keys = [...acc.keys()];
  return keys.length > 0 ? keys[keys.length - 1] : "call:0";
}

export function accumulateToolCallDeltas(
  acc: Map<string, CompatToolCall>,
  deltas: readonly CompatToolCallDelta[] | undefined | null,
): void {
  for (const delta of deltas ?? []) {
    const key = slotFor(acc, delta);
    const current = acc.get(key) ?? { id: "", name: "", args: "" };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name = delta.function.name;
    if (delta.function?.arguments) current.args += delta.function.arguments;
    acc.set(key, current);
  }
}

/** Complete calls in wire order. A fragment with no id or name is not a call. */
export function finalizeToolCalls(acc: ReadonlyMap<string, CompatToolCall>): CompatToolCall[] {
  return [...acc.values()].filter((call) => call.id && call.name);
}

/**
 * Does this round hand off to the tool loop?
 *
 * HAVING CALLS IS THE SIGNAL. Gating on `finish_reason === "tool_calls"` meant
 * any host that reports `stop` while still emitting `tool_calls` — several do —
 * had its calls dropped on the floor and answered with nothing at all. The
 * finish reason only says whether the model ran out of room: `length` means the
 * arguments may be truncated mid-JSON, and executing those is worse than
 * surfacing the truncation.
 */
export function shouldRunToolRound(input: {
  hasTools: boolean;
  isFinalRound: boolean;
  callCount: number;
  finishReason?: string;
}): boolean {
  return input.hasTools && !input.isFinalRound && input.callCount > 0 && input.finishReason !== "length";
}

export interface CompatRoundUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  webSearchRequests: number;
  xSearchRequests: number;
}

export function emptyCompatUsage(): CompatRoundUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    webSearchRequests: 0,
    xSearchRequests: 0,
  };
}

export type CompatUsagePayload = CompatPromptCacheFields & {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  server_side_tool_usage?: { web_search_requests?: number; x_search_requests?: number } | null;
};

/**
 * ONE merge rule for every counter: maximum WITHIN a round.
 *
 * There used to be three rules over the same object — last-wins for
 * input/output, last-wins-unless-absent for cache reads, `Math.max` for
 * reasoning and total, and outright ADDITION for cache writes and server tool
 * counts. A host that repeats cumulative usage on every chunk (which is the
 * common behaviour under `stream_options.include_usage`) therefore had its
 * cache writes and web searches billed once per chunk, while a host whose final
 * chunk omits a field had that field erased. These counters are cumulative and
 * monotonic within a response, so the maximum is both safe against repetition
 * and safe against a partial final frame. Rounds are SUMMED by the caller —
 * each is a separately billed request.
 */
export function foldCompatUsage(into: CompatRoundUsage, usage: CompatUsagePayload | null | undefined): void {
  if (!usage) return;
  into.input = Math.max(into.input, usage.prompt_tokens ?? 0);
  into.output = Math.max(into.output, usage.completion_tokens ?? 0);
  const cache = compatPromptCacheTokens(usage);
  into.cacheRead = Math.max(into.cacheRead, cache.cacheRead ?? 0);
  into.cacheWrite = Math.max(into.cacheWrite, cache.cacheWrite);
  into.reasoning = Math.max(
    into.reasoning,
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
  );
  into.total = Math.max(into.total, usage.total_tokens ?? 0);
  into.webSearchRequests = Math.max(into.webSearchRequests, usage.server_side_tool_usage?.web_search_requests ?? 0);
  into.xSearchRequests = Math.max(into.xSearchRequests, usage.server_side_tool_usage?.x_search_requests ?? 0);
}

/** Bank a finished round into the turn total, by addition. */
export function addCompatUsage(total: CompatRoundUsage, round: CompatRoundUsage): void {
  total.input += round.input;
  total.output += round.output;
  total.cacheRead += round.cacheRead;
  total.cacheWrite += round.cacheWrite;
  total.reasoning += round.reasoning;
  total.total += round.total;
  total.webSearchRequests += round.webSearchRequests;
  total.xSearchRequests += round.xSearchRequests;
}

/**
 * Strip the part of a cumulative reasoning field already emitted.
 *
 * MiniMax sends `reasoning_details` CUMULATIVELY (each chunk repeats
 * everything so far); other hosts send the same field as a delta. Taking the
 * prefix when it matches and the whole value when it does not handles both
 * without guessing which dialect is on the wire.
 */
export function reasoningDetailsDelta(previous: string, full: string): string {
  return full.startsWith(previous) ? full.slice(previous.length) : full;
}
