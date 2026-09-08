import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { providerRequestModel } from "@/lib/model-request";
import { env } from "@/lib/env";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { providerApiKey } from "@/lib/providers";
import { getObjectBytes } from "@/lib/storage";
import {
  addAnthropicUsage,
  emptyAnthropicUsage,
  readAnthropicRound,
  safeToolInput,
} from "@/lib/anthropic-round";
import type { McpToolset } from "@/lib/mcp";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export {
  anthropicThinkingKind,
  buildAnthropicThinkingBits,
  type AnthropicThinkingKind,
} from "@/lib/anthropic-thinking";

let anthropic: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  // The SDK must not replay a paid request behind Juno's accounting boundary.
  // A streamed request may have consumed tokens before a transport error is
  // observed; retrying invisibly would duplicate spend or make the ledger lie.
  // The caller may start an explicit, separately metered attempt instead.
  //
  // The key goes through providerApiKey() rather than env.anthropicApiKey so it
  // gets the same normalization every other provider's key gets (trim, strip one
  // layer of surrounding quotes, drop stray CR/LF — see providers.ts readEnv).
  // env.anthropicApiKey is a raw process.env read, so a key pasted with quotes
  // or a trailing newline used to 401 here while reading as configured
  // everywhere else — and would make the health probe disagree with live
  // traffic, which is the one thing a probe must never do.
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: providerApiKey("anthropic") ?? env.anthropicApiKey,
      maxRetries: 0,
    });
  }
  return anthropic;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Large binary attachments (images / PDFs) are only re-embedded for the most
// recent slice of the conversation. Older ones become a lightweight text
// placeholder so a long chat doesn't re-upload megabytes — and blow the context
// window — on every turn. Extracted document text (cheap) is always kept.
const BINARY_ATTACHMENT_LOOKBACK = 8;

export {
  buildSystemPrompt,
  buildSystemPromptSections,
  type SystemPromptOptions,
} from "@/lib/chat/system-prompt";

/** Per-request dynamic context (currently the date). Kept OUT of the cached
 *  prefix: each adapter appends it after its stable region. */
export function buildDynamicContext(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Today is ${today}.`;
}

/** Convert persisted messages (+ their attachments) into Anthropic message params. */
export async function toAnthropicMessages(messages: MessageForModel[]): Promise<Anthropic.MessageParam[]> {
  const result: Anthropic.MessageParam[] = [];
  // Only the last few messages re-embed heavy binaries; older ones are
  // summarized. Block-anchored (see openai-compat.ts): aging images out
  // one-per-turn would move the cache_control-stable prefix every request.
  const binaryFrom = Math.max(
    0,
    Math.floor((messages.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "SYSTEM") continue;
    const role = msg.role === "ASSISTANT" ? "assistant" : "user";

    if (role === "assistant" || msg.attachments.length === 0) {
      result.push({ role, content: msg.content || "(no content)" });
      continue;
    }

    const embedBinary = i >= binaryFrom;

    // User message with attachments → multimodal content blocks.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType)) {
          if (!embedBinary) {
            blocks.push({ type: "text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: Buffer.from(bytes).toString("base64"),
              },
            });
          }
        } else if (att.mimeType === "application/pdf") {
          if (!embedBinary && att.extractedText) {
            blocks.push({ type: "text", text: `Attached file "${att.fileName}" (shared earlier):\n\n${att.extractedText.slice(0, 100_000)}` });
          } else if (!embedBinary) {
            blocks.push({ type: "text", text: `[PDF "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            blocks.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
            });
          }
        } else if (att.extractedText) {
          blocks.push({
            type: "text",
            text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}`,
          });
        } else {
          blocks.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType}) — content not readable.]` });
        }
      } catch {
        blocks.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    result.push({ role, content: blocks.length ? blocks : msg.content || "(no content)" });
  }

  return result;
}

/**
 * Add an Anthropic prompt-cache breakpoint to the last content block of the last
 * message. Combined with the cached system prompt, this caches the whole growing
 * conversation prefix: each turn reads the previous turn's cache (~0.1x input
 * cost) and only writes the delta — a large saving on long, expensive, or
 * high-thinking chats. Anthropic ignores the marker below its min-cacheable size.
 */
function markConversationCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  const cacheControl = { type: "ephemeral" as const };
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content || "(no content)", cache_control: cacheControl }];
    return;
  }
  const block = last.content[last.content.length - 1];
  // cache_control is honored on text/image/document blocks — exactly what we emit.
  if (block) (block as { cache_control?: typeof cacheControl }).cache_control = cacheControl;
}

/**
 * How many times Claude may call tools before it must answer.
 *
 * Matches the OpenAI adapters so a connector-heavy question behaves the same
 * whichever model serves it — the round budget is a product decision about how
 * long a turn may take, not a provider detail.
 */
const MAX_TOOL_ROUNDS = 6;

/** True when a `speed:"fast"` request failed specifically because fast mode is
 *  unavailable to this account/right now (not enrolled in the research preview,
 *  or fast-tier capacity exhausted) — the cases where retrying at standard speed
 *  is the right move. Other errors propagate unchanged. */
function isFastModeUnavailable(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const status = e?.status;
  const msg = (e?.error?.message || e?.message || "").toLowerCase();
  if (status === 403) return true; // no access to the research preview
  if ((status === 400 || status === 429) && /fast|speed|beta/.test(msg)) return true;
  return false;
}

export async function* streamAnthropic(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  fastMode?: boolean,
  systemStablePrefix?: string
): AsyncGenerator<LlmEvent> {
  const messages = await toAnthropicMessages(history);
  markConversationCacheBreakpoint(messages);
  // Cache the (large, stable) system prompt so it isn't re-billed every turn.
  // A 1h TTL (vs the 5m default) keeps the prefix warm across the pauses a real
  // chat has between turns — a reader who replies 10-40 min later still hits the
  // cache (0.1x read) instead of paying to rewrite the whole prefix. The 2x
  // write premium is repaid after a single later read of a prompt this large.
  // Dynamic per-request context (the date) goes in a SECOND system block after
  // the breakpoint, so its daily change never invalidates the cached prefix.
  // Ordering rule: the 1h block sits before the 5m conversation breakpoint below
  // (all 1h cache_control entries must precede any 5m entry in a request).
  // Two cached tiers when the caller names the stable head (see
  // `buildSystemPromptSections`): the shared rules, then this user's tail.
  // Each carries its own breakpoint, so a memory or project change rewrites
  // only the tail. Anthropic allows four breakpoints per request; with the
  // conversation marker below and the tools marker above, that is all four.
  const splitAt =
    systemStablePrefix && system.startsWith(systemStablePrefix) && system.length > systemStablePrefix.length
      ? systemStablePrefix.length
      : -1;
  const cached1h = { type: "ephemeral" as const, ttl: "1h" as const };
  const systemBlocks: Anthropic.TextBlockParam[] =
    splitAt > 0
      ? [
          { type: "text", text: system.slice(0, splitAt), cache_control: cached1h },
          { type: "text", text: system.slice(splitAt).replace(/^\s+/, ""), cache_control: cached1h },
        ]
      : [{ type: "text", text: system, cache_control: cached1h }];
  if (dynamicContext) systemBlocks.push({ type: "text", text: dynamicContext });
  const thinkingBits = buildAnthropicThinkingBits(model.providerModel, maxTokens, reasoningEffort);
  const hasTools = !!toolset && toolset.tools.length > 0;

  /*
   * Connector tools, declared to Claude as ordinary client tools.
   *
   * Claude therefore returns `tool_use` blocks that Juno executes through
   * `toolset.execute`, which is the brokered chokepoint. The previous native
   * `mcp_servers` route had Claude call the connector itself — faster, but it
   * put the call outside Juno entirely, where no approval could be required.
   */
  const connectorTools = hasTools
    ? toolset!.tools.map((t, i, all) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Messages.Tool.InputSchema,
        // Tool definitions sit at the head of the cacheable prefix and a
        // connector-heavy turn carries thousands of tokens of JSON schema.
        // A breakpoint on the LAST tool caches the whole array; the tools are
        // the same for every turn of a conversation, so it is read every time.
        ...(i === all.length - 1 ? { cache_control: cached1h } : {}),
      }))
    : [];
  const tools = [
    // Claude's native web search server tool — searches + cites inline. It runs
    // inside Anthropic and reaches no account of the user's, so it is not a
    // connector action and does not pass the broker.
    ...(webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : []),
    ...connectorTools,
  ];

  const baseParams = {
    model: providerRequestModel(model),
    max_tokens: thinkingBits.maxTokens,
    system: systemBlocks,
    messages,
    stream: true,
    ...(thinkingBits.thinking ? { thinking: thinkingBits.thinking } : {}),
    ...(thinkingBits.outputConfig ? { output_config: thinkingBits.outputConfig } : {}),
    ...(tools.length ? { tools } : {}),
  } as Anthropic.Messages.MessageCreateParamsStreaming;

  // Open the stream at the requested speed. Fast mode (`speed:"fast"`) streams
  // output ~2.5x faster at premium price on supported Opus models, behind the
  // fast-mode research-preview beta. If the account isn't enrolled or fast
  // capacity is exhausted, fall back to standard speed once rather than failing
  // the whole turn — switching speed only costs a one-off prompt-cache miss.
  const openStream = (fast: boolean, params: Anthropic.Messages.MessageCreateParamsStreaming) => {
    const betas = fast ? ["fast-mode-2026-02-01"] : [];
    return getAnthropic().messages.create(
      (fast ? { ...params, speed: "fast" } : params) as Anthropic.Messages.MessageCreateParamsStreaming,
      { signal, ...(betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : {}) }
    );
  };

  let servedFast = !!fastMode;
  const seen = new Set<string>();

  /*
   * Usage is accumulated in two tiers, and the distinction is a billing one:
   * maximum WITHIN a round (Anthropic repeats cumulative counters, and a partial
   * delta must not wipe what message_start already reported), sum ACROSS rounds
   * (each tool round is a separately billed request). Both live in
   * anthropic-round.ts so a test can pin the arithmetic.
   */
  const acc = emptyAnthropicUsage();
  let servedSpeed: string | null = null;

  /*
   * The tool loop.
   *
   * One extra round past the tool budget, with tools present but `tool_choice`
   * set to none, so a run that keeps reaching for tools still ends in a real
   * sentence rather than a dangling tool_use. Anthropic documents none (and
   * auto) as the two choices compatible with manual extended thinking, which is
   * why the final round narrows the choice instead of dropping `tools` — a
   * history containing tool_use blocks still needs the definitions present.
   */
  const maxRounds = hasTools ? MAX_TOOL_ROUNDS + 1 : 1;
  let lastStopReason: string | null = null;

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const isFinalRound = roundIndex === maxRounds - 1;
    const params = {
      ...baseParams,
      messages,
      ...(hasTools ? { tool_choice: { type: isFinalRound ? "none" : "auto" } } : {}),
    } as Anthropic.Messages.MessageCreateParamsStreaming;

    let stream: Awaited<ReturnType<typeof openStream>>;
    try {
      stream = await openStream(servedFast, params);
    } catch (err) {
      // Only the first round can discover that fast mode is unavailable; later
      // rounds have already been downgraded, so this stays a one-shot fallback.
      if (servedFast && isFastModeUnavailable(err)) {
        // The turn is no longer served fast. `servedFast` is what the final
        // `fast` flag is computed from, so downgrading it here is what stops a
        // provider that never reports `speed` from being billed the premium rate.
        servedFast = false;
        stream = await openStream(false, params);
      } else {
        throw err;
      }
    }

    // Delegated so the block reassembly can be exercised by a test without an
    // API key or a network. See src/lib/anthropic-round.ts.
    const round = yield* readAnthropicRound(stream as AsyncIterable<Anthropic.RawMessageStreamEvent>, {
      labelFor: toolset ? (name) => toolset.labelFor(name) : undefined,
      seen,
    });
    const { blocks, toolUses, stopReason } = round;

    lastStopReason = stopReason;
    addAnthropicUsage(acc, round.usage);
    if (round.usage.speed != null) servedSpeed = round.usage.speed;

    /*
     * Report the running total after every round, not just at the end.
     *
     * The mid-stream budget guard (src/lib/chat-budget-guard.ts) re-costs the
     * turn on each usage event and aborts the provider stream when it would
     * cross the ceiling. While this adapter made exactly one request that was
     * academic — the only usage event arrived as the turn finished. A tool loop
     * makes it matter: each round re-sends the WHOLE conversation, so a
     * six-round connector turn bills input roughly six times, and a guard that
     * first hears about it after the sixth round has nothing left to prevent.
     *
     * Safe to emit repeatedly because these are cumulative and monotonic, and
     * the accumulator merges usage with `preferHigher` (src/lib/usage-merge.ts).
     * `fast` is deliberately withheld until the final event: it is a billing
     * rate, not a counter, and asserting it early would let a turn that later
     * degrades to standard speed be priced at the premium one.
     */
    yield {
      type: "usage",
      input: acc.input || undefined,
      output: acc.output || undefined,
      cacheRead: acc.cacheRead || undefined,
      cacheWrite: acc.cacheWrite || undefined,
      cacheWrite5m: acc.cacheWrite5m || undefined,
      cacheWrite1h: acc.cacheWrite1h || undefined,
      reasoning: acc.reasoning || undefined,
      webSearchRequests: acc.webSearchRequests || undefined,
    } satisfies LlmEvent;

    // Claude asked for tools and the budget allows another round: run them
    // through the broker and feed the results back.
    if (hasTools && !isFinalRound && stopReason === "tool_use" && toolUses.length > 0) {
      messages.push({ role: "assistant", content: blocks });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const label = toolset!.labelFor(call.name);
        const exec = await toolset!.execute(call.name, safeToolInput(call.json), signal, call.id);
        results.push({ type: "tool_result", tool_use_id: call.id, content: exec.text });
        yield {
          type: "tool",
          server: label,
          name: call.name,
          phase: "result",
          callId: call.id,
          // Anthropic's ONLY chance to supply arguments: the call event was
          // yielded from `content_block_start`, before `input_json_delta` had
          // begun. `call.json` is the raw accumulated JSON text, unparsed —
          // redaction and truncation belong to the route, not to an adapter.
          args: call.json,
          result: exec.body,
          ok: exec.ok,
          durationMs: exec.durationMs,
        };
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    break;
  }

  // A trailing `tool_use` means even the forced-answer round wanted more tools.
  // Report it as a length stop so the UI offers Continue rather than showing a
  // clean finish over a turn that never actually answered.
  const finalStop = lastStopReason === "tool_use" ? "max_tokens" : lastStopReason;
  if (finalStop) yield { type: "finish", reason: normalizeFinishReason(finalStop), raw: finalStop };

  // Single authoritative usage event after the stream completes.
  const hasAny =
    acc.input > 0 ||
    acc.output > 0 ||
    acc.cacheRead > 0 ||
    acc.cacheWrite > 0 ||
    acc.reasoning > 0 ||
    acc.webSearchRequests > 0;
  if (hasAny) {
    // Do NOT put cache into `total` — resolveBillableTokens would treat
    // total−input as "missing output" and inflate completion tokens.
    yield {
      type: "usage",
      input: acc.input || undefined,
      output: acc.output || undefined,
      cacheRead: acc.cacheRead || undefined,
      cacheWrite: acc.cacheWrite || undefined,
      cacheWrite5m: acc.cacheWrite5m || undefined,
      cacheWrite1h: acc.cacheWrite1h || undefined,
      reasoning: acc.reasoning || undefined,
      webSearchRequests: acc.webSearchRequests || undefined,
      // Fast only when it was asked for AND the provider did not quietly serve
      // the standard tier. A provider that reports no `speed` at all leaves
      // servedSpeed null, and the request's own outcome decides.
      fast: servedFast && servedSpeed !== "standard",
    } satisfies LlmEvent;
  }
}
