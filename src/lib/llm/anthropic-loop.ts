/**
 * The Anthropic adapter's request, stream-reading and replay loop (SPEC §5.0,
 * §5.1), free of `server-only`.
 *
 * `anthropic.ts` keeps the SDK client and the history conversion (which reads
 * attachment bytes from storage) and hands this loop a transport; everything
 * that decides what is SENT — tools and their versions, `tool_choice`, the
 * cache breakpoints, what a tool round appends — lives here, so a test drives
 * a whole tool turn with a scripted transport and asserts on the bodies.
 *
 * One request per `loop.beginRequest()`: a tool round, a `pause_turn`
 * continuation and a structured-output retry each count against the turn's
 * budget, and the request the controller calls final goes out with
 * `tool_choice: none` and its tools kept (§4.6) — dropping them would
 * invalidate the thinking blocks the history is replaying.
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  addAnthropicUsage,
  emptyAnthropicUsage,
  readAnthropicRound,
  type AnthropicRoundUsage,
  type AnthropicToolUse,
} from "@/lib/anthropic-round";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { providerSearchCapFor } from "@/lib/llm/loop";
import { structuredInvalidText, structuredNudgeText, structuredToolDescription } from "@/lib/llm/structured.prompt";
import { callIdIssuer, signalOrNever, toolRoundRunner, type ToolRoundRunner } from "@/lib/llm/tool-round";
import { NO_RESULT_TEXT } from "@/lib/llm/tool-round.prompt";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { McpFunctionTool } from "@/lib/mcp";
import { providerRequestModel } from "@/lib/model-request";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import type { ModelInfo } from "@/lib/models";
import { sendableToolImages, withheldImagesNote } from "@/lib/tool-result-images";
import type { BatchResult, ToolCallInput } from "@/lib/tools/dispatch";
import { portableToAnthropic, portableValueIssue } from "@/lib/tools/schema";
import type { PortableSchema } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

type Params = Anthropic.Messages.MessageCreateParamsStreaming;
type StreamEvent = Anthropic.RawMessageStreamEvent;

export interface AnthropicLoopDeps {
  /** `request(body, signal)` → the SDK's raw stream events. */
  transport: ProviderTransport;
  /** The conversation as Anthropic message params. The loop appends to its own copy. */
  messages: Anthropic.MessageParam[];
  /**
   * The account has zero-data-retention commitments (`ANTHROPIC_ZDR=1`). The
   * `_20260318` search runs dynamic filtering through code execution, which is
   * not ZDR-eligible unless its callers are restricted to Claude directly.
   */
  zdr?: boolean;
  /** Replaces the runner `toolRoundRunner(req)` would pick. Tests only. */
  runTools?: ToolRoundRunner | null;
}

const CACHED_1H = { type: "ephemeral" as const, ttl: "1h" as const };

export async function* anthropicLoop(req: AdapterRequest, deps: AnthropicLoopDeps): AsyncGenerator<LlmEvent> {
  const { model, loop } = req;
  // A structured call is tool-less by definition: its one tool IS the answer.
  const structured = req.responseSchema ?? null;
  const runTools = structured ? null : deps.runTools !== undefined ? deps.runTools : toolRoundRunner(req);
  const toolset = runTools ? req.toolset : undefined;

  const messages = [...deps.messages];
  markConversationCacheBreakpoint(messages);
  const thinking = buildAnthropicThinkingBits(model.providerModel, req.maxTokens, req.reasoningEffort);
  const tools = structured
    ? [structuredTool(structured.name, structured.schema)]
    : anthropicTools({
        model,
        tools: toolset?.tools ?? [],
        webSearch: req.webSearch,
        maxUses: providerSearchCapFor(loop.budget),
        zdr: !!deps.zdr,
      });

  const base = {
    model: providerRequestModel(model),
    max_tokens: thinking.maxTokens,
    system: anthropicSystemBlocks(req.system, req.systemStablePrefix, req.dynamicContext),
    stream: true,
    ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
    ...(thinking.outputConfig ? { output_config: thinking.outputConfig } : {}),
    ...(tools.length ? { tools } : {}),
  };

  const labelFor = toolset ? (name: string) => toolset.labelFor(name) : undefined;
  const callIdFor = callIdIssuer(req.batch?.seenCallIds);
  const seen = new Set<string>();

  /*
   * Usage is accumulated in two tiers, and the distinction is a billing one:
   * maximum WITHIN a request (Anthropic repeats cumulative counters, and a
   * partial delta must not wipe what message_start already reported), sum
   * ACROSS requests (each is separately billed and re-sends the whole
   * conversation). Both live in anthropic-round.ts so a test can pin them.
   */
  const acc = emptyAnthropicUsage();
  let servedFast = !!req.fastMode;
  let servedSpeed: string | null = null;
  let lastStop: string | null = null;
  let round = 0;

  for (;;) {
    const { final } = loop.beginRequest();
    const params = {
      ...base,
      messages,
      // Never a forced choice: `any`/`tool` are a 400 on Fable 5.1 and Opus 5.5.
      ...(tools.length ? { tool_choice: { type: final && !structured ? "none" : "auto" } } : {}),
    } as Params;

    const opened = await openAnthropicStream(deps.transport, params, servedFast, req.signal);
    // The turn is no longer served fast once a request had to fall back; the
    // final `fast` flag is computed from this, so a provider that never
    // reports `speed` cannot bill a downgraded turn at the premium rate.
    servedFast = opened.fast;

    const held: string[] = [];
    const reader = readAnthropicRound(opened.events, { labelFor, seen, round, final, callIdFor });
    const result = structured ? yield* holdText(reader, held) : yield* reader;

    lastStop = result.stopReason;
    addAnthropicUsage(acc, result.usage);
    if (result.usage.speed != null) servedSpeed = result.usage.speed;
    round = result.round;

    const dispatch = !!runTools && !final && result.stopReason === "tool_use" && result.toolUses.length > 0;
    // A structured call's answer is settled before its step closes, so the
    // answer text belongs to the step it ends. Its one tool is offered on
    // every request (never a tools-off one), so a retry needs only a request
    // left in the budget.
    const settled = structured ? settleStructured(result, held, structured, loop.requests >= loop.budget) : null;
    if (settled?.kind === "answer" && settled.text) yield { type: "text", text: settled.text, round };
    yield {
      type: "round_end",
      round,
      tools: dispatch ? result.toolUses.length : 0,
      serverTools: result.serverTools,
      final,
      stop: result.stopReason,
    };
    /*
     * The running total after every request, not just at the end. The
     * mid-stream budget guard re-costs the turn on each usage event and can end
     * the loop before the next request (SPEC §4.7), and a tool loop re-sends the
     * whole conversation each round — a guard that first heard about it after
     * the last round would have nothing left to prevent. Safe to repeat: the
     * counters are cumulative and merged with `preferHigher`. `fast` waits for
     * the final event: it is a billing rate, not a counter.
     */
    yield usageEvent(acc, round);

    if (settled) {
      if (settled.kind === "answer") {
        lastStop = settled.stop;
        break;
      }
      if (result.blocks.length) messages.push({ role: "assistant", content: result.blocks });
      messages.push({ role: "user", content: settled.followUp });
      round += 1;
      continue;
    }

    if (!dispatch) {
      // Calls the model announced that will not run: a response cut off by
      // `max_tokens` mid-call, where Anthropic's rule is never to run tools
      // from a truncated turn (SPEC §5.1 item 5). Each row gets its end.
      for (const use of result.toolUses) yield cancelledResult(use, labelFor?.(use.name) ?? "connector");
    }

    /*
     * `pause_turn`: Anthropic paused a long server-tool turn and asks for it
     * back. The contract is to append the assistant content UNCHANGED and send
     * again with the same tools — no tool results, nothing synthesised,
     * because no client tool_use is waiting. It is a request like any other,
     * so it spends the budget; on the final request it cannot be continued.
     */
    if (!final && result.stopReason === "pause_turn" && result.blocks.length > 0) {
      messages.push({ role: "assistant", content: result.blocks });
      round += 1;
      continue;
    }

    if (dispatch && runTools) {
      messages.push({ role: "assistant", content: result.blocks });
      const calls: ToolCallInput[] = result.toolUses.map((use) => ({
        name: use.name,
        callId: use.callId,
        providerCallId: use.id,
        round: use.round,
        index: use.index,
        // Raw, as streamed: the dispatcher reports malformed JSON back to the
        // model instead of running the tool with `{}` (RC-14).
        argsText: use.json,
      }));
      const results = yield* runTools(calls, signalOrNever(req.signal), loop.nextIsFinal());
      // One user message of tool_result blocks and nothing else: when the
      // response also left a server_tool_use unresolved, any other block in
      // this message is a 400 (SPEC §5.1 item 7). The final-round note rides
      // inside the last result for the same reason.
      messages.push({ role: "user", content: toolResultBlocks(calls, results, model.vision) });
      round += 1;
      continue;
    }
    break;
  }

  // A trailing `tool_use` means even the forced-answer request wanted more
  // tools, and a trailing `pause_turn` means the budget ran out mid-search.
  // Either way the turn never answered: a length stop offers Continue rather
  // than showing a clean finish.
  const finalStop = lastStop === "tool_use" || lastStop === "pause_turn" ? "max_tokens" : lastStop;
  if (finalStop) yield { type: "finish", reason: normalizeFinishReason(finalStop), raw: finalStop };

  const hasAny =
    acc.input > 0 || acc.output > 0 || acc.cacheRead > 0 || acc.cacheWrite > 0 || acc.reasoning > 0 || acc.webSearchRequests > 0;
  if (hasAny) {
    // Fast only when it was asked for AND the provider did not quietly serve
    // the standard tier. A provider that reports no `speed` leaves servedSpeed
    // null, and the requests' own outcome decides.
    yield usageEvent(acc, round, servedFast && servedSpeed !== "standard");
  }
}

// ── Request pieces (pure, exported for the tests) ─────────────────────────────

/**
 * The system prompt as cached blocks. A 1h TTL keeps the prefix warm across
 * the pauses a real chat has between turns. Two cached tiers when the caller
 * names the stable head (`buildSystemPromptSections`): the shared rules, then
 * this user's tail, so a memory or project change rewrites only the tail. The
 * per-request dynamic context (the date) goes in a block AFTER the breakpoints,
 * so its daily change never invalidates the cached prefix.
 */
export function anthropicSystemBlocks(
  system: string,
  systemStablePrefix: string | undefined,
  dynamicContext: string | undefined,
): Anthropic.TextBlockParam[] {
  const splitAt =
    systemStablePrefix && system.startsWith(systemStablePrefix) && system.length > systemStablePrefix.length
      ? systemStablePrefix.length
      : -1;
  const blocks: Anthropic.TextBlockParam[] =
    splitAt > 0
      ? [
          { type: "text", text: system.slice(0, splitAt), cache_control: CACHED_1H },
          { type: "text", text: system.slice(splitAt).replace(/^\s+/, ""), cache_control: CACHED_1H },
        ]
      : [{ type: "text", text: system, cache_control: CACHED_1H }];
  if (dynamicContext) blocks.push({ type: "text", text: dynamicContext });
  return blocks;
}

/**
 * Claude's own web search, at the version this model takes (SPEC §5.1 item 6):
 * `web_search_20260318` where the capability record says so (Fable 5.1, Opus
 * 5.5, Sonnet 5), the basic `web_search_20250305` elsewhere — on Haiku 4.5 the
 * 2026 versions would need `allowed_callers` it cannot honour. `max_uses` is
 * the turn's search cap, the same on every request.
 */
export function anthropicWebSearchTool(
  model: Pick<ModelInfo, "provider" | "id" | "api" | "tools">,
  maxUses: number,
  zdr: boolean,
): Record<string, unknown> {
  const version = toolCapabilitiesFor(model).anthropicSearchVersion ?? "20250305";
  if (version === "20260318") {
    return {
      type: "web_search_20260318",
      name: "web_search",
      max_uses: maxUses,
      ...(zdr ? { allowed_callers: ["direct"] } : {}),
    };
  }
  return { type: "web_search_20250305", name: "web_search", max_uses: maxUses };
}

/**
 * The tools array: Claude's server search first, then the client tools.
 *
 * Client tools — Juno's and connectors' alike — are declared as ordinary tools,
 * so Claude returns `tool_use` blocks that Juno runs through the dispatcher,
 * the brokered chokepoint. (The old native `mcp_servers` route had Claude call
 * connectors itself, outside any approval.) Their definitions sit at the head
 * of the cacheable prefix and a connector-heavy turn carries thousands of tokens
 * of schema, so a breakpoint on the LAST tool caches the whole array.
 */
export function anthropicTools(input: {
  model: Pick<ModelInfo, "provider" | "id" | "api" | "tools">;
  tools: readonly McpFunctionTool[];
  webSearch: boolean;
  maxUses: number;
  zdr: boolean;
}): Array<Record<string, unknown>> {
  const client = input.tools.map((tool, i, all) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: "object", properties: {} },
    ...(i === all.length - 1 ? { cache_control: CACHED_1H } : {}),
  }));
  return [...(input.webSearch ? [anthropicWebSearchTool(input.model, input.maxUses, input.zdr)] : []), ...client];
}

/** `responseSchema` as the one tool of a structured call (SPEC §5.0), answered under `tool_choice: auto`. */
export function structuredTool(name: string, schema: PortableSchema): Record<string, unknown> {
  return { name, description: structuredToolDescription(name), input_schema: portableToAnthropic(schema) };
}

/**
 * Add a prompt-cache breakpoint to the last content block of the last message.
 * With the cached system prompt this caches the whole growing conversation
 * prefix: each turn reads the previous turn's cache (~0.1x input cost) and
 * writes only the delta. Anthropic ignores the marker below its minimum size.
 */
export function markConversationCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  const cacheControl = { type: "ephemeral" as const };
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content || "(no content)", cache_control: cacheControl }];
    return;
  }
  const block = last.content[last.content.length - 1];
  // cache_control is honored on text/image/document blocks — exactly what history holds.
  if (block) (block as { cache_control?: typeof cacheControl }).cache_control = cacheControl;
}

/**
 * The follow-up user message of a tool round: one `tool_result` per call, in
 * call order, answering the provider's own id. A failed call says so with
 * `is_error` (RC-14) — Claude then corrects and retries rather than reading an
 * error text as data. Anthropic is the one provider where a picture belongs to
 * the result that produced it: the block takes the same content array a
 * message does.
 */
export function toolResultBlocks(
  calls: readonly ToolCallInput[],
  results: readonly BatchResult[],
  vision: boolean,
): Anthropic.Messages.ToolResultBlockParam[] {
  return calls.map((call, i) => {
    const toolUseId = call.providerCallId ?? call.callId;
    const result = results[i]?.callId === call.callId ? results[i] : results.find((r) => r.callId === call.callId);
    if (!result) return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: NO_RESULT_TEXT };
    const images = sendableToolImages(result.images, vision);
    const text = withheldImagesNote(result.text, result.images, images.length);
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      ...(result.isError ? { is_error: true } : {}),
      content: images.length
        ? [
            { type: "text" as const, text },
            ...images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: image.base64,
              },
            })),
          ]
        : text,
    };
  });
}

/** True when a `speed:"fast"` request failed because fast mode is unavailable to this account right now. */
export function isFastModeUnavailable(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const status = e?.status;
  const msg = (e?.error?.message || e?.message || "").toLowerCase();
  if (status === 403) return true; // no access to the research preview
  if ((status === 400 || status === 429) && /fast|speed|beta/.test(msg)) return true;
  return false;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Opens one request at the asked speed. Fast mode (`speed:"fast"`) streams
 * ~2.5x faster at a premium on supported Opus models, behind a research-preview
 * beta; when the account is not enrolled or fast capacity is exhausted, the
 * request is sent once more at standard speed rather than failing the turn —
 * switching speed costs only a one-off prompt-cache miss. The first event is
 * awaited here because that is where the transport's HTTP error surfaces.
 */
async function openAnthropicStream(
  transport: ProviderTransport,
  params: Params,
  fast: boolean,
  signal: AbortSignal | undefined,
): Promise<{ events: AsyncIterable<StreamEvent>; fast: boolean }> {
  const attempt = async (withFast: boolean) => {
    const iterator = transport.request(withFast ? { ...params, speed: "fast" } : params, signal)[Symbol.asyncIterator]();
    return { iterator, first: await iterator.next() };
  };
  let served = fast;
  let opened: Awaited<ReturnType<typeof attempt>>;
  try {
    opened = await attempt(served);
  } catch (err) {
    if (!served || !isFastModeUnavailable(err)) throw err;
    served = false;
    opened = await attempt(false);
  }
  return { events: resumeIterator(opened.iterator, opened.first), fast: served };
}

async function* resumeIterator(
  iterator: AsyncIterator<unknown>,
  first: IteratorResult<unknown>,
): AsyncGenerator<StreamEvent> {
  if (first.done) return;
  yield first.value as StreamEvent;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value as StreamEvent;
  }
}

/**
 * A structured request's events, minus two kinds: `text`, which it keeps — the
 * call's prose is not its answer — and the `tool` call of the schema's own
 * tool, which is how the answer arrives rather than an action anyone took.
 */
async function* holdText<R>(reader: AsyncGenerator<LlmEvent, R>, held: string[]): AsyncGenerator<LlmEvent, R> {
  for (;;) {
    const step = await reader.next();
    if (step.done) return step.value;
    if (step.value.type === "text") held.push(step.value.text);
    else if (step.value.type !== "tool") yield step.value;
  }
}

type Settled =
  | { kind: "answer"; text: string; stop: string | null }
  | { kind: "retry"; followUp: Anthropic.MessageParam["content"] };

/**
 * What a structured request produced. The tool's arguments are the answer,
 * streamed on as JSON text — the shape every other adapter's structured output
 * already has. Arguments that fail the schema get one corrective tool_result;
 * prose instead of a call gets one nudge, unless the prose is itself a JSON
 * object that fits. When the budget allows no retry, whatever came back is
 * handed on and the caller's own validation decides (the research planner
 * retries once and then fails, SPEC §9.5).
 */
function settleStructured(
  result: { toolUses: AnthropicToolUse[]; stopReason: string | null },
  held: string[],
  structured: NonNullable<AdapterRequest["responseSchema"]>,
  lastAttempt: boolean,
): Settled {
  const use = result.toolUses.find((u) => u.name === structured.name && u.complete);
  if (use) {
    const value = parseJson(use.json);
    const problem = value === undefined ? "the arguments were not valid JSON" : portableValueIssue(structured.schema, value);
    if (!problem) return { kind: "answer", text: JSON.stringify(value), stop: "end_turn" };
    if (lastAttempt) return { kind: "answer", text: use.json, stop: "end_turn" };
    return {
      kind: "retry",
      followUp: result.toolUses.map((u) => ({
        type: "tool_result" as const,
        tool_use_id: u.id,
        is_error: true,
        content: structuredInvalidText(problem),
      })),
    };
  }
  const text = held.join("");
  const value = parseJson(stripJsonFence(text));
  const fits = value !== undefined && !portableValueIssue(structured.schema, value);
  if (fits) return { kind: "answer", text: JSON.stringify(value), stop: result.stopReason };
  if (lastAttempt || result.stopReason !== "end_turn" || result.toolUses.length > 0) {
    return { kind: "answer", text, stop: result.stopReason };
  }
  return { kind: "retry", followUp: structuredNudgeText(structured.name) };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stripJsonFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return fenced ? fenced[1] : text;
}

function cancelledResult(use: AnthropicToolUse, server: string): LlmEvent {
  return {
    type: "tool",
    phase: "result",
    server,
    name: use.name,
    callId: use.callId,
    round: use.round,
    index: use.index,
    args: use.json,
    result: "",
    ok: false,
    status: "cancelled",
    error: { code: "cancelled" },
  };
}

function usageEvent(acc: AnthropicRoundUsage, round: number, fast?: boolean): LlmEvent {
  // Do NOT put cache into `total`: resolveBillableTokens would read
  // total − input as missing output and inflate completion tokens.
  return {
    type: "usage",
    input: acc.input || undefined,
    output: acc.output || undefined,
    cacheRead: acc.cacheRead || undefined,
    cacheWrite: acc.cacheWrite || undefined,
    cacheWrite5m: acc.cacheWrite5m || undefined,
    cacheWrite1h: acc.cacheWrite1h || undefined,
    reasoning: acc.reasoning || undefined,
    webSearchRequests: acc.webSearchRequests || undefined,
    round,
    ...(fast === undefined ? {} : { fast }),
  };
}
