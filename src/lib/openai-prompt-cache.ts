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
 * Models that accept `prompt_cache_retention` (extended / in-memory).
 * Deprecated for GPT-5.6+; those use prompt_cache_options.ttl instead.
 */
export function supportsOpenAIPromptCacheRetention(model: ModelInfo): boolean {
  if (model.provider !== "openai") return false;
  if (isOpenAIModernCacheModel(model)) return false;
  const id = model.providerModel.toLowerCase();
  // Documented extended-retention list + close family members we ship.
  return (
    id.includes("gpt-5.5") ||
    id.includes("gpt-5.4") ||
    id.includes("gpt-5.3") ||
    id.includes("gpt-5.2") ||
    id.includes("gpt-5.1") ||
    /^gpt-5($|[-_])/.test(id) ||
    id.includes("gpt-4.1")
  );
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
