import "server-only";
import OpenAI from "openai";
import { getObjectBytes } from "@/lib/storage";
import { providerApiKey, providerBaseUrl, PROVIDERS } from "@/lib/providers";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import type { McpToolset } from "@/lib/mcp";

/**
 * OpenAI Responses API adapter — for models that are not served on
 * /chat/completions at all (the gpt-*-pro line and Responses-only Codex
 * snapshots). Mirrors streamOpenAICompat's contract exactly: same LlmEvent
 * stream, same MCP tool loop, same usage/finish semantics, so routes and the
 * UI can't tell which wire protocol served the request.
 */

let cached: OpenAI | null = null;

function client(): OpenAI {
  const apiKey = providerApiKey("openai");
  if (!apiKey) throw new Error(`${PROVIDERS.openai.label} API key is not configured.`);
  if (!cached) cached = new OpenAI({ apiKey, baseURL: providerBaseUrl("openai"), maxRetries: 2 });
  return cached;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const BINARY_ATTACHMENT_LOOKBACK = 8; // kept in sync with the compat/Anthropic adapters
const MAX_TOOL_ROUNDS = 6;

type InputItem = OpenAI.Responses.ResponseInputItem;

async function toResponsesInput(
  history: MessageForModel[],
  vision: boolean
): Promise<InputItem[]> {
  const out: InputItem[] = [];
  // Block-anchored (see openai-compat.ts): keeps the cacheable prefix stable
  // between steps instead of moving it every turn.
  const binaryFrom = Math.max(
    0,
    Math.floor((history.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "SYSTEM") continue;
    if (msg.role === "ASSISTANT") {
      out.push({
        role: "assistant",
        content: [{ type: "output_text", text: msg.content || "(no content)" }],
      } as InputItem);
      continue;
    }

    if (msg.attachments.length === 0) {
      out.push({ role: "user", content: [{ type: "input_text", text: msg.content || "(no content)" }] });
      continue;
    }

    const embedBinary = i >= binaryFrom;
    const parts: Array<Record<string, unknown>> = [];
    if (msg.content.trim()) parts.push({ type: "input_text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && embedBinary) {
          const { bytes } = await getObjectBytes(att.storageKey);
          parts.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${att.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          });
        } else if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType) && vision && !embedBinary) {
          parts.push({ type: "input_text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
        } else if (att.extractedText) {
          parts.push({ type: "input_text", text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}` });
        } else {
          const note = att.kind === "IMAGE" && !vision ? " — this model cannot view images" : "";
          parts.push({ type: "input_text", text: `[Attached file "${att.fileName}" (${att.mimeType})${note}.]` });
        }
      } catch {
        parts.push({ type: "input_text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    out.push({ role: "user", content: parts } as unknown as InputItem);
  }

  return out;
}

/**
 * Map Juno's tier to the Responses API's reasoning.effort.
 *
 * The gpt-5.x-pro models accept medium|high|xhigh and cannot be run
 * non-thinking, so a missing/too-shallow tier is raised to their "high" default
 * rather than dropped. Everything else relays the tier as-is — including
 * "xhigh" and "max", which this used to flatten to "high" and thereby silently
 * cap the deepest settings the user picked.
 */
function mapEffort(model: ModelInfo, effort?: ReasoningEffort): string | undefined {
  const id = model.providerModel.toLowerCase();
  if (/-pro$/.test(id)) {
    if (effort === "medium" || effort === "high" || effort === "xhigh") return effort;
    return "high"; // pro's own default; it has no none/low
  }
  if (!effort) return canDisableViaNoneEffort(model) ? "none" : undefined;
  // "max" exists on gpt-5.6 only; older Responses models top out at xhigh.
  if (effort === "max" && !id.includes("gpt-5.6")) return "xhigh";
  return effort;
}

/**
 * GPT-5.1+ express "don't think" as an explicit effort of "none".
 *
 * The old blanket `codex -> false` rule was WRONG for gpt-5.3-codex, which
 * verifiably accepts "none" (-> 200, reasoning_tokens=0) while 5.1/5.2-codex
 * reject it ("Supported values are: 'low', 'medium', 'high'..."). Defer to the
 * per-model caps, which encode each snapshot's live-probed enum, rather than
 * re-deriving support from a substring here.
 */
function canDisableViaNoneEffort(model: ModelInfo): boolean {
  const id = model.providerModel.toLowerCase();
  if (!/gpt-5\.\d/.test(id)) return false;
  return model.reasoning && reasoningCaps(model).canDisable;
}

export async function* streamOpenAIResponses(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  _webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  cacheKey?: string,
  fastMode?: boolean
): AsyncGenerator<LlmEvent> {
  const input = await toResponsesInput(history, model.vision);
  // Same cache-safe placement as the compat adapter: dynamic context lands as a
  // system item just before the newest user turn, never ahead of the stable prefix.
  if (dynamicContext) {
    let lastUser = input.length;
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i] as { role?: string };
      if (item.role === "user") {
        lastUser = i;
        break;
      }
    }
    input.splice(lastUser, 0, {
      role: "system",
      content: [{ type: "input_text", text: dynamicContext }],
    } as InputItem);
  }

  const hasTools = !!toolset && toolset.tools.length > 0;
  // Responses uses a flat function-tool shape (no nested `function` wrapper).
  const tools: OpenAI.Responses.Tool[] | undefined = hasTools
    ? toolset!.tools.map((t) => {
        const fn = (t as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
        return {
          type: "function" as const,
          name: fn.name,
          description: fn.description ?? "",
          parameters: fn.parameters ?? { type: "object" },
          strict: false,
        };
      })
    : undefined;

  const effort = mapEffort(model, reasoningEffort);
  // ASK FOR WHAT THE MODEL ALREADY MAKES.
  //
  // Without this key the API emits no reasoning_summary_* events at all, so the
  // handler below was dead code and every gpt-*-pro / gpt-*-codex run showed NO
  // reasoning whatsoever. Verified live on all seven api:"responses" models Juno
  // ships (5.5/5.4/5.2-pro, 5.3/5.2/5.1-codex, 5.1-codex-mini): every one
  // accepts summary:"detailed" -> 200.
  //
  // "detailed" over "auto" because "auto" collapses to a single part on most
  // prompts, and the parts ARE the steps. Cost: summary tokens bill as output
  // tokens (already counted by the usage handler below) — measured ~600 chars
  // per part, 17 parts on a hard prompt ≈ 2.5k output tokens.
  //
  // Skipped when effort is "none": the model does not think, so there is
  // nothing to summarise and nothing to pay for.
  const wantsSummary = !!effort && effort !== "none";

  console.info("[llm:openai-responses] stream start", {
    model: model.providerModel,
    maxTokens,
    reasoningEffort: effort ?? null,
    tools: hasTools ? toolset!.tools.length : 0,
  });

  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let sawUsage = false;
  let finishRaw: string | undefined;
  // Declared OUTSIDE the round loop on purpose: a tool round starts a fresh
  // response whose summary_index restarts at 0, but the user is watching one
  // continuous run. Keeping the ordinal monotonic across rounds is what stops
  // round 2's first part from overwriting round 1's.
  let summaryPart = -1;

  const c = client();
  const maxRounds = hasTools ? MAX_TOOL_ROUNDS + 1 : 1;
  for (let round = 0; round < maxRounds; round++) {
    const isFinalRound = round === maxRounds - 1;
    const params: OpenAI.Responses.ResponseCreateParamsStreaming & Record<string, unknown> = {
      model: model.providerModel,
      instructions: system,
      input,
      stream: true,
      // No server-side persistence: history is resent per round, like every
      // other Juno adapter — nothing about the chat lives in OpenAI storage.
      store: false,
      max_output_tokens: maxTokens,
    };
    // Cast: the installed openai types predate the "none"/"xhigh"/"max" values
    // that the Responses API now accepts.
    if (effort) {
      params.reasoning = {
        effort,
        ...(wantsSummary ? { summary: "detailed" } : {}),
      } as OpenAI.Responses.ResponseCreateParams["reasoning"];
    }
    if (tools) {
      params.tools = tools;
      params.tool_choice = isFinalRound ? "none" : "auto";
    }
    if (cacheKey) params.prompt_cache_key = cacheKey;
    // OpenAI priority processing (premium latency). The route gates fastMode to
    // priority-eligible models, so relaying it straight through is safe.
    if (fastMode) params.service_tier = "priority";

    const stream = await c.responses.create(params, { signal });

    const calls: Array<{ callId: string; name: string; args: string }> = [];
    let roundFinish: string | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "text", text: event.delta };
          break;
        // A part boundary is a FACT the API states, not something to infer from
        // the text later. Counting the announcements is the whole mechanism:
        // each `part.added` opens a step, and every delta until the next one
        // belongs to it.
        case "response.reasoning_summary_part.added":
          summaryPart++;
          break;
        case "response.reasoning_summary_text.delta":
          // Defensive: a delta with no preceding part.added still belongs to a
          // real part, so open one rather than emitting part:-1.
          if (summaryPart < 0) summaryPart = 0;
          yield { type: "reasoning", text: event.delta, part: summaryPart };
          break;
        case "response.output_item.done": {
          const item = event.item as { type: string; call_id?: string; name?: string; arguments?: string };
          if (item.type === "function_call" && item.call_id && item.name) {
            calls.push({ callId: item.call_id, name: item.name, args: item.arguments ?? "{}" });
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const resp = event.response;
          if (resp.usage) {
            sawUsage = true;
            cumInput += resp.usage.input_tokens ?? 0;
            cumOutput += resp.usage.output_tokens ?? 0;
            cumCached += resp.usage.input_tokens_details?.cached_tokens ?? 0;
          }
          roundFinish =
            event.type === "response.incomplete"
              ? resp.incomplete_details?.reason === "max_output_tokens"
                ? "length"
                : (resp.incomplete_details?.reason ?? "stop")
              : calls.length > 0
                ? "tool_calls"
                : "stop";
          break;
        }
        case "response.failed": {
          const err = event.response.error;
          throw Object.assign(new Error(err?.message ?? "Responses API run failed."), {
            status: undefined,
            error: { message: err?.message },
          });
        }
        case "error": {
          const ev = event as { message?: string; code?: string };
          throw Object.assign(new Error(ev.message ?? "Responses API stream error."), {
            error: { message: ev.message },
          });
        }
        default:
          break;
      }
    }
    finishRaw = roundFinish;

    if (hasTools && !isFinalRound && calls.length > 0) {
      for (const call of calls) {
        // Echo the call, then its output, exactly as the API expects on replay.
        input.push({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: call.args,
        } as InputItem);
        const label = toolset!.labelFor(call.name);
        yield { type: "tool", server: label, name: call.name, phase: "call" };
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.args ? JSON.parse(call.args) : {};
        } catch {
          parsedArgs = {};
        }
        const result = await toolset!.execute(call.name, parsedArgs, signal);
        input.push({ type: "function_call_output", call_id: call.callId, output: result } as InputItem);
        yield { type: "tool", server: label, name: call.name, phase: "result" };
      }
      continue;
    }
    break;
  }

  if (sawUsage) yield { type: "usage", input: cumInput, output: cumOutput, cacheRead: cumCached || undefined };
  // A trailing tool_calls means even the forced-answer round wanted more tools —
  // surface "length" so the UI warns + offers Continue (same as the compat path).
  const finalRaw = finishRaw === "tool_calls" ? "length" : finishRaw;
  yield { type: "finish", reason: normalizeFinishReason(finalRaw ?? "stop"), raw: finalRaw };
  console.info("[llm:openai-responses] stream finish", {
    model: model.providerModel,
    finishReason: finalRaw ?? "stop",
    promptTokens: sawUsage ? cumInput : null,
    cachedTokens: sawUsage ? cumCached : null,
  });
}
