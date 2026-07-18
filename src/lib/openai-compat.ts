import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "@/lib/providers";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import type { McpToolset } from "@/lib/mcp";

const clients = new Map<Provider, OpenAI>();

function client(provider: Provider): OpenAI {
  const apiKey = providerApiKey(provider);
  if (!apiKey) throw new Error(`${PROVIDERS[provider].label} API key is not configured.`);
  let c = clients.get(provider);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: providerBaseUrl(provider), maxRetries: 2 });
    clients.set(provider, c);
  }
  return c;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Only the most recent messages re-embed full images; older ones become a text
// placeholder so a long chat doesn't re-upload megabytes every turn (kept in
// sync with the Anthropic adapter's lookback).
const BINARY_ATTACHMENT_LOOKBACK = 8;

async function toOpenAIMessages(
  system: string,
  history: MessageForModel[],
  vision: boolean
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  // Anchored to LOOKBACK-sized blocks (not a per-turn slide) so image →
  // placeholder rewrites only move the cacheable-prefix boundary once per
  // block, keeping provider prompt caches warm between steps.
  const binaryFrom = Math.max(
    0,
    Math.floor((history.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "SYSTEM") continue;
    if (msg.role === "ASSISTANT") {
      out.push({ role: "assistant", content: msg.content || "(no content)" });
      continue;
    }

    if (msg.attachments.length === 0) {
      out.push({ role: "user", content: msg.content || "(no content)" });
      continue;
    }

    const embedBinary = i >= binaryFrom;
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (msg.content.trim()) parts.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && embedBinary) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({
            type: "image_url",
            image_url: { url: `data:${att.mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
          });
        } else if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && !embedBinary) {
          parts.push({ type: "text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
        } else if (att.extractedText) {
          parts.push({ type: "text", text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}` });
        } else {
          const note = att.kind === "IMAGE" && !vision ? " — this model cannot view images" : "";
          parts.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType})${note}.]` });
        }
      } catch {
        parts.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    out.push({ role: "user", content: parts });
  }

  return out;
}

// Cap the agentic tool loop so a misbehaving model can't call tools forever.
const MAX_TOOL_ROUNDS = 6;

/** Stream a completion from any OpenAI-compatible provider (OpenAI, Gemini, GLM, Kimi).
 *  When `toolset` is provided, runs an MCP tool-use loop: the model may call the
 *  connected tools, we execute them, feed results back, and continue until it
 *  produces a final answer (bounded by MAX_TOOL_ROUNDS). */
/**
 * True when the model expresses "don't think" as reasoning_effort:"none".
 *
 * This must be sent explicitly rather than omitted: GPT-5.5 and GPT-5.6 default
 * to `medium` when the parameter is absent (only 5.4 and earlier default to
 * "none"), so omitting it made Juno's "Instant" option a no-op on the newest
 * models. The original GPT-5 generation predates "none" — its floor is
 * "minimal" — and xAI/DeepSeek/Zhipu express off through their own params.
 */
function canDisableViaNoneEffort(model: ModelInfo): boolean {
  const id = model.providerModel.toLowerCase();
  if (model.provider === "mistral") {
    // Was `return true` UNCONDITIONALLY, which sent reasoning_effort:"none" to
    // every Mistral model and 400'd all of them ("reasoning_effort is not
    // enabled for this model") — only mistral-medium/small expose the parameter
    // at all. Both clauses are load-bearing: `model.reasoning` rejects
    // large/codestral/ministral/devstral (which reach reasoningCaps' top gate
    // and would otherwise report canDisable:true), and canDisable rejects
    // magistral, which reasons but exposes no control.
    return model.reasoning && reasoningCaps(model).canDisable;
  }
  // Google's compat shim accepts reasoning_effort:"none" and genuinely stops
  // thinking (verified on gemini-3.1-flash-lite by budget starvation against
  // native thoughtsTokenCount — see reasoningCaps). This must be sent
  // EXPLICITLY: gemini-3-flash-preview thinks by DEFAULT when the parameter is
  // omitted (native thoughts=380), so omission would make Instant a silent lie.
  if (model.provider === "google") return model.reasoning && reasoningCaps(model).canDisable;
  if (model.provider !== "openai") return false;
  if (/gpt-5(\.\d)?-pro/.test(id)) return false; // always reason
  // Codex is not uniformly always-on: 5.3-codex accepts "none" (-> 0 reasoning
  // tokens) while 5.1/5.2-codex reject it. Defer to the per-model caps rather
  // than a blanket substring rule. (Codex snapshots run on the Responses
  // adapter, which has its own mapEffort; this keeps the two consistent.)
  //
  // `model.reasoning &&` is load-bearing on BOTH lines below, for the same
  // reason it is on the mistral/google branches above: reasoningCaps() returns
  // canDisable:TRUE for a non-reasoning model (its top gate is
  // `if (!model.reasoning) return caps([], true)`), so without this guard a
  // codex- or gpt-5.x-named model marked reasoning:false would be sent
  // reasoning_effort:"none" — the exact shape of the mistral outage. No current
  // model reaches it (every reasoning:false OpenAI id is gpt-4o/4-turbo/3.5 and
  // matches neither test), so this changes no behaviour today; it closes the
  // trapdoor and matches openai-responses.ts's canDisableViaNoneEffort, which
  // already guards this way.
  if (id.includes("codex")) return model.reasoning && reasoningCaps(model).canDisable;
  return model.reasoning && /gpt-5\.\d/.test(id); // 5.1+ — the original gpt-5 has no "none"
}

/**
 * Split a non-string `delta.content` into reasoning vs answer text.
 *
 * Mistral's reasoning models stream thinking as an ARRAY of typed chunks —
 * [{ type: "thinking", thinking: [{ type: "text", text: "…" }] }] — and deliver
 * the final answer as ordinary string deltas afterwards. The plain `+= delta`
 * path stringifies those objects, so a thinking Mistral model rendered its
 * reasoning as literal "[object Object]" repeated into the user's answer
 * (verified live on magistral-medium-2509 and mistral-medium/small at "high").
 */
function splitTypedContent(content: unknown): { reasoning: string; text: string } {
  let reasoning = "";
  let text = "";
  if (!Array.isArray(content)) return { reasoning, text };
  for (const chunk of content) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    const c = chunk as { type?: string; text?: string; thinking?: unknown };
    if (c.type === "thinking") {
      // `thinking` is itself a list of {type:"text",text} parts.
      const inner = Array.isArray(c.thinking) ? c.thinking : [];
      for (const part of inner) {
        if (typeof part === "string") reasoning += part;
        else if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
          reasoning += (part as { text: string }).text;
        }
      }
    } else if (typeof c.text === "string") {
      text += c.text;
    }
  }
  return { reasoning, text };
}

export async function* streamOpenAICompat(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  cacheKey?: string,
  fastMode?: boolean
): AsyncGenerator<LlmEvent> {
  const messages = await toOpenAIMessages(system, history, model.vision);
  // Per-request dynamic context (the date) is injected AFTER the frozen
  // conversation history — providers cache the longest stable prefix, so
  // nothing that changes per request may sit before the history. It lands as
  // a system message just before the newest user turn.
  if (dynamicContext) {
    let lastUser = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    messages.splice(lastUser, 0, { role: "system", content: dynamicContext });
  }
  const modelId = model.providerModel.toLowerCase();
  const isZhipuThinking = model.provider === "zhipu" && model.reasoning;
  const isMiniMax = model.provider === "minimax";
  // Qwen (DashScope) drives thinking with enable_thinking/thinking_budget, not
  // OpenAI's reasoning_effort — sending both would be redundant or rejected.
  const isQwenThinking = model.provider === "qwen" && model.reasoning;
  // The route already clamped the effort to what this model supports; relay it.
  // For GLM (on/off thinking) an effort means enabled, its absence means off.
  const effectiveReasoningEffort = reasoningEffort;
  const hasTools = !!toolset && toolset.tools.length > 0;

  /*
   * Only some providers speak OpenAI's top-level `reasoning_effort`. The rest
   * each have their own dialect, and sending reasoning_effort to them is at best
   * ignored and at worst a 400 — so the parameter is gated to the providers whose
   * docs actually define it (verified 2026-07):
   *   reasoning_effort  → openai, google (Gemini compat shim), deepseek (v4),
   *                       xai, mistral (high|none), zhipu (GLM-5.2 only)
   *   thinking:{type}   → zhipu (all), minimax, moonshot, mimo, longcat
   *   enable_thinking   → qwen
   */
  const usesThinkingObject =
    model.provider === "minimax" || model.provider === "moonshot" || model.provider === "mimo" || model.provider === "longcat";
  const usesReasoningEffort =
    model.provider === "openai" ||
    // Google was previously absent from EVERY send path here, so no thinking
    // parameter ever reached Gemini and every tier in the UI was inert. Its
    // OpenAI-compat shim does take reasoning_effort (enum
    // none|minimal|low|medium|high) and honours it — the shim rejects sending
    // both this and a custom thinking_config with "Expected one of either
    // `reasoning_effort` or custom `thinking_config`", i.e. they set the same
    // backend field. Only gated tiers are ever sent (clampReasoningEffort).
    model.provider === "google" ||
    model.provider === "deepseek" ||
    model.provider === "xai" ||
    model.provider === "mistral" ||
    (model.provider === "zhipu" && modelId.includes("glm-5.2")) ||
    // Kimi K3 introduced a top-level reasoning_effort enum (low|high|max),
    // replacing the K2.x `thinking` object. Only K3 speaks it on Moonshot; the
    // K2.x line stays on the usesThinkingObject path below (and is canDisable:
    // false, so it never actually emits `thinking` either).
    (model.provider === "moonshot" && modelId.includes("k3"));

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    model: model.providerModel,
    messages,
    stream: true,
    // Request a final usage chunk on the compat path; without this most
    // providers report usage as null on every chunk. (Gate per-provider only
    // if a specific endpoint ever rejects it.)
    stream_options: { include_usage: true },
  };
  // OpenAI priority processing: faster, more consistent latency at premium
  // price. The route only sets fastMode on priority-eligible models, so relaying
  // it straight through is safe. (Anthropic's own fast mode lives in the native
  // adapter; this path covers OpenAI.)
  if (fastMode && model.provider === "openai") params.service_tier = "priority";
  // NOTE: assigned through the Record index rather than the SDK's typed field —
  // the installed openai types predate "none"/"xhigh"/"max", which the REST API
  // accepts. Providers reject unknown VALUES, not unknown TS types.
  const setEffort = (value: string) => {
    (params as Record<string, unknown>).reasoning_effort = value;
  };
  if (usesReasoningEffort) {
    if (effectiveReasoningEffort) {
      // Mistral's enum is only high|none, so any depth collapses to "high".
      setEffort(model.provider === "mistral" ? "high" : effectiveReasoningEffort);
    } else if (canDisableViaNoneEffort(model)) {
      // Instant must be sent EXPLICITLY as "none": GPT-5.5/5.6 default to
      // `medium` when the parameter is omitted, so simply leaving it out made
      // Instant silently think anyway. (5.4 and earlier default to "none", but
      // being explicit is correct there too.)
      setEffort("none");
    }
  }
  if (isQwenThinking) {
    // Instant (no effort) turns Qwen thinking off; any effort turns it on and
    // maps to a token budget for the thinking phase (extra_body passthrough).
    params.enable_thinking = !!effectiveReasoningEffort;
    if (effectiveReasoningEffort) {
      params.thinking_budget = { minimal: 1024, low: 2048, medium: 8192, high: 24000, xhigh: 32000, max: 38000 }[
        effectiveReasoningEffort
      ];
    }
  }
  if (isZhipuThinking) {
    // Instant (no effort) turns GLM thinking off; any effort turns it on.
    // GLM-5.2 additionally takes reasoning_effort (handled above).
    params.thinking = { type: effectiveReasoningEffort ? "enabled" : "disabled" };
  }
  if (usesThinkingObject && model.reasoning && reasoningCaps(model).canDisable) {
    // Only send `thinking` to models that can actually switch it — Kimi k2.7
    // REJECTS {type:"disabled"} outright, and MiniMax M2.x silently ignores the
    // field (it always reasons). Both are marked canDisable:false in their caps.
    // MiniMax M3 spells its on-state "adaptive"; the others use "enabled".
    const onType = model.provider === "minimax" ? "adaptive" : "enabled";
    params.thinking = { type: effectiveReasoningEffort ? onType : "disabled" };
  }
  if (isMiniMax) {
    // Ask MiniMax to return reasoning in its own field rather than inline.
    params.reasoning_split = true;
  }
  if (model.provider === "openai") {
    const om = model.providerModel.toLowerCase();
    // Legacy models reject completion caps above their own ceiling with a 400:
    // the gpt-4o line tops out at 16384, gpt-4-turbo / gpt-3.5 at 4096.
    const legacyCap = /gpt-4o/.test(om) ? 16384 : /gpt-4-turbo|gpt-3\.5/.test(om) ? 4096 : Infinity;
    // GPT-5 reasoning models count hidden reasoning toward max_completion_tokens,
    // so a tight cap can yield empty/truncated output — give it headroom.
    params.max_completion_tokens = Math.min(Math.max(maxTokens, 16000), legacyCap);
  } else {
    // Same per-model-ceiling problem as the gpt-4o line above: glm-4.5v rejects
    // max_tokens over 16384 with 400 "max_tokens参数非法：限制数值范围[1,16384]",
    // while every other GLM (incl. 4.5-air/x/airx/flash and the 4.6v line)
    // accepts more — verified live. This matters because the route adds an
    // effort-scaled thinking allowance on top of the plan cap, which pushes a
    // thinking request past 16384.
    const zhipuCap = modelId.includes("glm-4.5v") ? 16384 : Infinity;
    params.max_tokens = Math.min(maxTokens, model.provider === "zhipu" ? zhipuCap : Infinity);
  }
  // Prompt-cache routing hints. OpenAI: automatic caching on >1024-token
  // stable prefixes; prompt_cache_key routes same-prefix requests (one
  // conversation) to the same cache shard. Mistral: caching is OPT-IN and
  // only happens when prompt_cache_key is set. Other providers may reject
  // unknown params, so this stays gated. (xAI takes a header instead, below.)
  // Zhipu/DeepSeek/Moonshot cache IMPLICITLY — no request param exists; hits
  // arrive in usage.prompt_tokens_details.cached_tokens (parsed below) and
  // depend entirely on the prompt prefix staying byte-stable across turns
  // (see HISTORY_STEP in the chat route and the block-anchored binaryFrom).
  if ((model.provider === "openai" || model.provider === "mistral") && cacheKey) {
    params.prompt_cache_key = cacheKey;
  }
  // xAI Grok "Live Search" — a request-body extension that returns citations.
  if (webSearch && model.provider === "xai") {
    params.search_parameters = { mode: "auto", return_citations: true };
  }
  if (hasTools) params.tools = toolset!.tools;

  const seen = new Set<string>();
  const c = client(model.provider);
  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let cumReasoning = 0;
  let cumTotal = 0;
  let sawUsage = false;
  let lastFinish: string | undefined;

  console.info("[llm:openai-compat] stream start", {
    provider: model.provider,
    model: model.providerModel,
    maxTokens,
    reasoningEffort: effectiveReasoningEffort ?? null,
    thinking: isZhipuThinking,
    webSearch: !!webSearch,
    tools: hasTools ? toolset!.tools.length : 0,
  });

  // One extra round beyond the tool cap, forced to answer (tool_choice "none"),
  // so a run that keeps calling tools still ends with a real reply.
  const maxRounds = hasTools ? MAX_TOOL_ROUNDS + 1 : 1;
  for (let round = 0; round < maxRounds; round++) {
    const isFinalRound = round === maxRounds - 1;
    params.messages = messages;
    if (hasTools) (params as Record<string, unknown>).tool_choice = isFinalRound ? "none" : "auto";
    // xAI routes same-conversation requests to the same cache via this header
    // (its chat.completions API has no prompt_cache_key).
    const requestHeaders = model.provider === "xai" && cacheKey ? { "x-grok-conv-id": cacheKey } : undefined;
    const stream = await c.chat.completions.create(params, { signal, headers: requestHeaders });

    let assistantText = "";
    let finishReason: string | undefined;
    // Per-round usage — overwrite (last chunk wins) so a provider that repeats
    // usage on every chunk isn't double-counted; totals are summed across rounds.
    let roundInput = 0;
    let roundOutput = 0;
    let roundCached = 0;
    let roundReasoning = 0;
    let roundTotal = 0;
    let roundSawUsage = false;
    let minimaxReasoningBuffer = "";
    // Accumulate streamed tool-call fragments by their choice index.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const choiceDelta = choice?.delta;
      const reasoning = choiceDelta as unknown as
        | { reasoning_content?: string; reasoning?: string; reasoning_details?: Array<{ text?: string }> }
        | undefined;
      let reasoningText = reasoning?.reasoning_content ?? reasoning?.reasoning;
      if (!reasoningText && reasoning?.reasoning_details?.length) {
        const fullReasoning = reasoning.reasoning_details.map((d) => d.text ?? "").join("");
        reasoningText = fullReasoning.startsWith(minimaxReasoningBuffer)
          ? fullReasoning.slice(minimaxReasoningBuffer.length)
          : fullReasoning;
        minimaxReasoningBuffer = fullReasoning;
      }
      if (reasoningText) yield { type: "reasoning", text: reasoningText };
      // `content` is typed string|null, but Mistral's reasoning models stream an
      // array of typed chunks — normalise before it gets concatenated.
      const rawDelta = choiceDelta?.content as unknown;
      let delta = typeof rawDelta === "string" ? rawDelta : "";
      if (Array.isArray(rawDelta)) {
        const split = splitTypedContent(rawDelta);
        if (split.reasoning) yield { type: "reasoning", text: split.reasoning };
        delta = split.text;
      }
      if (delta) {
        assistantText += delta;
        yield { type: "text", text: delta };
      }
      for (const tc of choiceDelta?.tool_calls ?? []) {
        const cur = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolCalls.set(tc.index, cur);
      }
      const citations = (chunk as unknown as { citations?: string[] }).citations;
      if (citations?.length) {
        const fresh = citations.filter((u) => u && !seen.has(u));
        for (const u of fresh) seen.add(u);
        if (fresh.length) yield { type: "sources", sources: fresh.map((url) => ({ title: url, url, snippet: "" })) };
      }
      if (chunk.usage) {
        roundSawUsage = true;
        roundInput = chunk.usage.prompt_tokens ?? roundInput;
        roundOutput = chunk.usage.completion_tokens ?? roundOutput;
        // Standard field first; DeepSeek reports its disk cache as
        // prompt_cache_hit_tokens, Moonshot/Kimi as a top-level cached_tokens.
        // Reasoning tokens: OpenAI puts them under completion_tokens_details
        // (subset of completion_tokens). Some OpenAI-compat hosts only expose
        // thinking there and leave completion_tokens as the visible answer —
        // resolveBillableTokens lifts output when reasoning > completion.
        const u = chunk.usage as {
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
          prompt_cache_hit_tokens?: number;
          cached_tokens?: number;
          reasoning_tokens?: number;
          total_tokens?: number;
        };
        roundCached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? roundCached;
        const reasoningTok =
          u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0;
        if (reasoningTok > 0) roundReasoning = Math.max(roundReasoning, reasoningTok);
        if (u.total_tokens != null) roundTotal = Math.max(roundTotal, u.total_tokens);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    if (roundSawUsage) {
      sawUsage = true;
      cumInput += roundInput;
      cumOutput += roundOutput;
      cumCached += roundCached;
      cumReasoning += roundReasoning;
      cumTotal += roundTotal;
    }
    lastFinish = finishReason;

    // Model asked to call tools — execute them and loop with the results. Never
    // on the final (forced-answer) round, so the tool results always get consumed.
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((v) => v.id && v.name);
    if (hasTools && !isFinalRound && finishReason === "tool_calls" && calls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.map((v) => ({ id: v.id, type: "function", function: { name: v.name, arguments: v.args || "{}" } })),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      for (const v of calls) {
        const label = toolset!.labelFor(v.name);
        yield { type: "tool", server: label, name: v.name, phase: "call" };
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = v.args ? JSON.parse(v.args) : {};
        } catch {
          parsedArgs = {};
        }
        const result = await toolset!.execute(v.name, parsedArgs, signal);
        messages.push({ role: "tool", tool_call_id: v.id, content: result } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        yield { type: "tool", server: label, name: v.name, phase: "result" };
      }
      continue;
    }
    break; // final answer produced (or tools disabled)
  }

  if (sawUsage) {
    yield {
      type: "usage",
      input: cumInput,
      output: cumOutput,
      reasoning: cumReasoning || undefined,
      total: cumTotal || undefined,
      cacheRead: cumCached || undefined,
    };
  }
  // A still-trailing "tool_calls" means even the forced-answer round wanted more
  // tools — report "length" so the UI warns + offers Continue (not a fake stop).
  const finalRaw = lastFinish === "tool_calls" ? "length" : lastFinish;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  console.info("[llm:openai-compat] stream finish", {
    provider: model.provider,
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
    // Cache hit-rate instrumentation: cachedTokens/promptTokens per response.
    promptTokens: sawUsage ? cumInput : null,
    completionTokens: sawUsage ? cumOutput : null,
    reasoningTokens: sawUsage ? cumReasoning || null : null,
    cachedTokens: sawUsage ? cumCached : null,
  });
}
