import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS, type Provider } from "@/lib/providers";
import { normalizeFinishReason } from "@/lib/finish-reason";
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
  const binaryFrom = Math.max(0, history.length - BINARY_ATTACHMENT_LOOKBACK);

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
export async function* streamOpenAICompat(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset
): AsyncGenerator<LlmEvent> {
  const messages = await toOpenAIMessages(system, history, model.vision);
  const isZhipuThinking = model.provider === "zhipu" && model.reasoning;
  const isMiniMax = model.provider === "minimax";
  // Qwen (DashScope) drives thinking with enable_thinking/thinking_budget, not
  // OpenAI's reasoning_effort — sending both would be redundant or rejected.
  const isQwenThinking = model.provider === "qwen" && model.reasoning;
  // The route already clamped the effort to what this model supports; relay it.
  // For GLM (on/off thinking) an effort means enabled, its absence means off.
  const effectiveReasoningEffort = reasoningEffort;
  const hasTools = !!toolset && toolset.tools.length > 0;

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    model: model.providerModel,
    messages,
    stream: true,
    // Request a final usage chunk on the compat path; without this most
    // providers report usage as null on every chunk. (Gate per-provider only
    // if a specific endpoint ever rejects it.)
    stream_options: { include_usage: true },
  };
  if (effectiveReasoningEffort && !isQwenThinking) (params as Record<string, unknown>)["reasoning_effort"] = effectiveReasoningEffort;
  if (isQwenThinking) {
    // Instant (no effort) turns Qwen thinking off; any effort turns it on and
    // maps to a token budget for the thinking phase (extra_body passthrough).
    params.enable_thinking = !!effectiveReasoningEffort;
    if (effectiveReasoningEffort) {
      params.thinking_budget = { low: 2048, medium: 8192, high: 24000, max: 38000 }[effectiveReasoningEffort];
    }
  }
  if (isZhipuThinking) {
    // Instant (no effort) turns GLM thinking off; any effort turns it on.
    params.thinking = { type: effectiveReasoningEffort ? "enabled" : "disabled" };
  }
  if (isMiniMax) {
    params.reasoning_split = true;
    if (model.providerModel.toLowerCase() === "minimax-m3") {
      params.thinking = { type: effectiveReasoningEffort ? "adaptive" : "disabled" };
    }
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
    params.max_tokens = maxTokens;
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
    const stream = await c.chat.completions.create(params, { signal });

    let assistantText = "";
    let finishReason: string | undefined;
    // Per-round usage — overwrite (last chunk wins) so a provider that repeats
    // usage on every chunk isn't double-counted; totals are summed across rounds.
    let roundInput = 0;
    let roundOutput = 0;
    let roundCached = 0;
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
      const delta = choiceDelta?.content;
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
        roundCached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? roundCached;
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    if (roundSawUsage) {
      sawUsage = true;
      cumInput += roundInput;
      cumOutput += roundOutput;
      cumCached += roundCached;
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

  if (sawUsage) yield { type: "usage", input: cumInput, output: cumOutput, cacheRead: cumCached || undefined };
  // A still-trailing "tool_calls" means even the forced-answer round wanted more
  // tools — report "length" so the UI warns + offers Continue (not a fake stop).
  const finalRaw = lastFinish === "tool_calls" ? "length" : lastFinish;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  console.info("[llm:openai-compat] stream finish", {
    provider: model.provider,
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
  });
}
