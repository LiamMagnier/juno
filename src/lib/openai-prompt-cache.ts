/**
 * OpenAI Prompt Caching helpers.
 *
 * Spec: https://developers.openai.com/api/docs/guides/prompt-caching
 *
 * - All recent models (gpt-4o+): automatic caching on ≥1024-token prefixes.
 * - Always send `prompt_cache_key` for same-conversation routing (required for
 *   reliable matching on GPT-5.6+).
 * - GPT-5.6+ families: `prompt_cache_options` + optional explicit breakpoints
 *   on stable system content; cache writes bill 1.25× (handled in pricing.ts).
 * - Pre-5.6 models that support it: `prompt_cache_retention: "24h"`.
 */

import type { ModelInfo } from "@/lib/models";

/** GPT-5.6 and later — explicit breakpoints + prompt_cache_options.ttl. */
export function isOpenAIModernCacheModel(model: ModelInfo): boolean {
  if (model.provider !== "openai") return false;
  const id = model.providerModel.toLowerCase();
  // gpt-5.6* and any future 5.7+ / 6.x line
  if (/gpt-5\.(6|7|8|9|[1-9]\d)/.test(id)) return true;
  if (/^gpt-[6-9]/.test(id)) return true;
  return false;
}

/**
 * The models OpenAI documents for extended retention (prompt-caching guide,
 * "Extended prompt cache retention"). Exact ids, not substrings: `includes()`
 * also sent "24h" to gpt-5.4-mini, gpt-5.4-pro, gpt-5.2-pro and gpt-5.3-codex,
 * which are not on the list.
 */
const EXTENDED_RETENTION_MODELS = new Set(["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5", "gpt-5-codex", "gpt-4.1"]);

/**
 * Models that accept `prompt_cache_retention` (extended / in-memory).
 * Deprecated for GPT-5.6+; those use prompt_cache_options.ttl instead.
 */
export function supportsOpenAIPromptCacheRetention(model: ModelInfo): boolean {
  if (model.provider !== "openai") return false;
  if (isOpenAIModernCacheModel(model)) return false;
  // A dated snapshot (`gpt-4.1-2025-04-14`) is the model it snapshots.
  const id = model.providerModel.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  // The gpt-5.1 family is listed whole: gpt-5.1, -codex, -codex-mini, -codex-max, -chat-latest.
  return EXTENDED_RETENTION_MODELS.has(id) || /^gpt-5\.1($|-)/.test(id);
}

/** gpt-5.5 / gpt-5.5-pro only accept 24h retention. */
export function openAIPromptCacheRetention(model: ModelInfo): "24h" | "in_memory" | null {
  if (!supportsOpenAIPromptCacheRetention(model)) return null;
  const id = model.providerModel.toLowerCase();
  // Prefer extended retention for longer multi-turn chats.
  if (id.includes("gpt-5.5")) return "24h";
  return "24h";
}

/**
 * Top-level request fields for OpenAI Chat Completions / Responses.
 * Only for provider === "openai". Safe to spread onto the params object.
 */
export function openAIPromptCacheRequestFields(
  model: ModelInfo,
  cacheKey: string | undefined
): Record<string, unknown> {
  if (model.provider !== "openai") return {};
  const out: Record<string, unknown> = {};

  // Required for reliable routing on GPT-5.6+; improves hit rates on all models.
  if (cacheKey) out.prompt_cache_key = cacheKey;

  if (isOpenAIModernCacheModel(model)) {
    // implicit: OpenAI still places a breakpoint on the latest message; we also
    // mark the system prefix explicitly so static instructions stay warm.
    // ttl "30m" is the only supported value (and the default).
    out.prompt_cache_options = { mode: "implicit", ttl: "30m" };
  } else {
    const retention = openAIPromptCacheRetention(model);
    if (retention) out.prompt_cache_retention = retention;
  }

  return out;
}

/**
 * Explicit cache breakpoint marker for GPT-5.6+ content parts.
 * Attach to the last block of the stable system prompt.
 */
export function openAIExplicitCacheBreakpoint(
  model: ModelInfo
): { mode: "explicit" } | undefined {
  if (!isOpenAIModernCacheModel(model)) return undefined;
  return { mode: "explicit" };
}

/**
 * Chat Completions system message with an optional GPT-5.6+ breakpoint on the
 * static system text. Older models keep a plain string (breakpoint fields 400).
 */
export function openAISystemMessage(
  model: ModelInfo,
  system: string
): {
  role: "system";
  content:
    | string
    | Array<{ type: "text"; text: string; prompt_cache_breakpoint?: { mode: "explicit" } }>;
} {
  const bp = openAIExplicitCacheBreakpoint(model);
  if (!bp) return { role: "system", content: system };
  return {
    role: "system",
    content: [
      {
        type: "text",
        text: system,
        prompt_cache_breakpoint: bp,
      },
    ],
  };
}

/**
 * Responses API: put the system prompt into `input` as a system message with a
 * breakpoint when on GPT-5.6+, otherwise keep using `instructions`.
 * Returning null means "use instructions field instead".
 */
export function openAIResponsesSystemInput(
  model: ModelInfo,
  system: string
): Array<Record<string, unknown>> | null {
  const bp = openAIExplicitCacheBreakpoint(model);
  if (!bp) return null;
  return [
    {
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: system,
          prompt_cache_breakpoint: bp,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// The other labs on the OpenAI wire
// ---------------------------------------------------------------------------

/**
 * Cache fields for a Chat Completions request to a lab other than OpenAI.
 *
 * - Mistral caches only when `prompt_cache_key` is set (opt-in).
 * - Meta caches automatically; `prompt_cache_key` routes a conversation's
 *   requests to the backend that holds its prefix (dev.meta.ai/docs/prompt-caching).
 * - xAI's chat.completions has no body field; it takes the `x-grok-conv-id`
 *   header instead (openai-compat.ts).
 */
export function compatPromptCacheRequestFields(
  model: Pick<ModelInfo, "provider">,
  cacheKey: string | undefined
): Record<string, unknown> {
  if (!cacheKey) return {};
  if (model.provider === "mistral" || model.provider === "meta") return { prompt_cache_key: cacheKey };
  return {};
}

/**
 * Cache fields for a Responses API request, per host. OpenAI gets the full
 * set (`openAIPromptCacheRequestFields`). xAI and Meta take
 * `prompt_cache_key` in the body; Meta also takes `prompt_cache_retention`,
 * "24h" being a hint it may not honour. Every Grok model routes to xAI's
 * Responses API, so without the key a Grok conversation had no cache routing
 * at all (the `x-grok-conv-id` header lives on the compat path only).
 */
export function responsesPromptCacheRequestFields(
  model: ModelInfo,
  host: "openai" | "xai" | "meta",
  cacheKey: string | undefined
): Record<string, unknown> {
  if (host === "openai") return openAIPromptCacheRequestFields(model, cacheKey);
  if (!cacheKey) return {};
  if (host === "meta") return { prompt_cache_key: cacheKey, prompt_cache_retention: "24h" };
  return { prompt_cache_key: cacheKey };
}

type CompatMessage = { role: string };
const QWEN_EPHEMERAL = { type: "ephemeral" } as const;

/** One message with `cache_control` on its last text part, content as an array (Qwen needs one). */
function withQwenMarker<M extends CompatMessage>(message: M): M | null {
  const ephemeral = { ...QWEN_EPHEMERAL };
  const body = (message as { content?: unknown }).content;
  if (typeof body === "string") {
    if (!body) return null;
    return { ...message, content: [{ type: "text", text: body, cache_control: ephemeral }] };
  }
  if (!Array.isArray(body)) return null;
  const parts = body as Array<{ type?: string }>;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]?.type !== "text") continue;
    const content = [...parts];
    content[i] = { ...parts[i], cache_control: ephemeral } as (typeof parts)[number];
    return { ...message, content };
  }
  return null;
}

/**
 * Qwen explicit-cache markers for ONE request (alibabacloud.com/help/en/model-studio/context-cache).
 *
 * Explicit cache is a 5-minute entry written at each `cache_control` marker
 * and read by a later request whose prefix matches one, looked up through the
 * 20 content blocks before each marker; hits bill 10% of input on
 * qwen3.7-plus against 20% implicit. At most three markers, under the limit
 * of four:
 *
 * - the system prompt, which every turn shares;
 * - the end of the stable history, the message before the per-request
 *   `dynamic` context (the date, spliced in before the newest user turn): a
 *   marker after it would end in bytes the next turn sends elsewhere, so the
 *   next turn could never read it;
 * - the newest message in a tool round (anything after the newest user turn),
 *   moved every round like `withConversationCacheBreakpoint`, so round N+1
 *   reads what round N wrote.
 *
 * Without a dynamic block the newest message carries the conversation marker.
 * `mode` "short" keeps only the system marker and "none" sends none. Copies
 * only the marked messages; the loop's history is never touched.
 */
export function withQwenCacheMarkers<M extends CompatMessage>(
  messages: readonly M[],
  opts: { dynamic?: M; mode?: "none" | "short" } = {}
): M[] {
  const out = [...messages];
  if (opts.mode === "none") return out;
  const mark = (index: number) => {
    const message = out[index];
    if (!message) return;
    const marked = withQwenMarker(message);
    if (marked) out[index] = marked;
  };
  const systemIndex = out[0]?.role === "system" && out[0] !== opts.dynamic ? 0 : -1;
  if (systemIndex === 0) mark(0);
  if (opts.mode === "short") return out;
  const dynamicIndex = opts.dynamic ? messages.indexOf(opts.dynamic) : -1;
  const last = out.length - 1;
  if (dynamicIndex > 0) {
    if (dynamicIndex - 1 !== systemIndex) mark(dynamicIndex - 1);
    if (last > dynamicIndex + 1) mark(last);
  } else if (last > systemIndex) {
    mark(last);
  }
  return out;
}
