import type { ModelInfo } from "@/lib/models";
import { providerSearchAvailable, toolCapabilitiesFor } from "@/lib/model-tools";
import { compatCarriesLabSearch } from "@/lib/lab-web-search";

/**
 * Every transport `providerAdapterFor` can pick, as a value, so a test can
 * check that each one has a place to go (`streamChat`'s switch in llm.ts, the
 * capability probe). `"xai-responses"` is the Responses adapter pointed at
 * `api.x.ai/v1`, in xAI's dialect (SPEC §5.5). `"meta-responses"` is the same
 * adapter pointed at Meta's `/v1/responses`, for the turns that search.
 */
export const PROVIDER_ADAPTERS = [
  "anthropic-native",
  "gemini-native",
  "openai-responses",
  "xai-responses",
  "meta-responses",
  "openai-compatible",
] as const;

/** The concrete transport used for one model request. */
export type ProviderAdapter = (typeof PROVIDER_ADAPTERS)[number];

/**
 * Whether every OpenAI model goes through the Responses API.
 *
 * On unless `OPENAI_RESPONSES=0`. The escape hatch is for a deployment whose
 * `OPENAI_BASE_URL` points at a proxy that only speaks `/chat/completions`:
 * there only the Responses-only snapshots and Pro mode keep the Responses
 * route, which is the routing this replaced (SPEC §5.0, O-32).
 */
export function openAIResponsesEnabled(): boolean {
  return process.env.OPENAI_RESPONSES !== "0";
}

/**
 * Resolve transport from the effective model, never from a default provider.
 * Kept pure so routing every lab through its intended API is regression-tested
 * without credentials or a live provider request.
 *
 * EVERY OPENAI MODEL IS A RESPONSES MODEL. GPT-6 Astra cannot call a tool on
 * `/chat/completions` at all, and GPT-6 Sol/Luna and the GPT-5.6 line only at
 * effort "none", so a tooled turn on the old route was a 400 at any real
 * thinking level (gap-provider §0.1). Grok follows for its own reason: xAI
 * retired Live Search on Chat Completions (410 since 2026-01-12), and its
 * server-side search exists only on Responses. A Grok model whose capability
 * record says it is not served there (an unconfirmed slug) stays on compat.
 *
 * `id` and `tools` are optional so callers that only know the provider keep
 * compiling; without an id a model is routed on its lab's capabilities.
 *
 * META ROUTES PER TURN. Muse Spark's `web_search` tool exists only on Meta's
 * Responses API ("Responses API only: Search grounding is not available
 * through the Chat Completions API", dev.meta.ai/docs/search-grounding), so a
 * turn with web search on goes to `/v1/responses` and every other turn stays
 * on Chat Completions, the route Meta's models were proven on. Callers that do
 * not pass `webSearch` (the probe, attachment and reasoning contracts) get the
 * Chat Completions answer, which is what serves a Meta turn by default.
 */
export function providerAdapterFor(
  model: Pick<ModelInfo, "provider" | "api"> & Partial<Pick<ModelInfo, "id" | "tools">>,
  proMode = false,
  opts: { webSearch?: boolean } = {},
): ProviderAdapter {
  if (model.provider === "anthropic") return "anthropic-native";
  if (model.provider === "google") return "gemini-native";
  if (model.provider === "openai") {
    return openAIResponsesEnabled() || model.api === "responses" || proMode ? "openai-responses" : "openai-compatible";
  }
  if (model.provider === "xai") {
    const caps = toolCapabilitiesFor({ provider: "xai", id: model.id ?? "", api: model.api, tools: model.tools });
    if (caps.responses) return "xai-responses";
  }
  if (model.provider === "meta" && opts.webSearch) {
    const caps = toolCapabilitiesFor({ provider: "meta", id: model.id ?? "", api: model.api, tools: model.tools });
    if (caps.nativeSearch) return "meta-responses";
  }
  return "openai-compatible";
}

/**
 * Whether this deployment serves the model's own provider search: the model
 * has it (`providerSearchAvailable`), and the transport it is routed to can
 * carry it. The compat adapter maps the native search of only the labs that
 * put it on Chat Completions (Z.ai, MiMo, Qwen — src/lib/lab-web-search.ts);
 * any other model it serves has none. That covers every OpenAI model a deployment
 * keeps on Chat Completions with `OPENAI_RESPONSES=0`, because OpenAI's hosted
 * search exists only on Responses.
 *
 * For the server only. It reads the deployment's env, which a browser bundle
 * does not have, so the client-visible `ModelInfo.webSearch` never goes
 * through it.
 */
export function providerSearchServed(model: Pick<ModelInfo, "provider" | "id" | "api" | "tools">): boolean {
  // Asked of the transport a turn WITH web search is routed to (Meta's differs).
  if (!providerSearchAvailable(model)) return false;
  return providerAdapterFor(model, false, { webSearch: true }) !== "openai-compatible" || compatCarriesLabSearch(model.provider);
}
