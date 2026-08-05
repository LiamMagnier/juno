import { discoverModels } from "@/lib/model-discovery";
import { getModelMetrics, withSupersededMarked } from "@/lib/model-metrics";
import { GEN_MODELS, type ModelInfo } from "@/lib/models";
import { configuredProviders, PROVIDERS } from "@/lib/providers";
import { ensureProviderHealthFresh, providerHealthy } from "@/lib/provider-health";
import { isVideoGenSupported } from "@/lib/video-gen";

// The native manifest builder lives in its own module because this one reaches
// for `model-discovery`, which is server-only — the manifest shape itself is
// pure and must stay directly testable.
export { nativeModelCatalog } from "@/lib/native-model-manifest";

export async function loadAvailableModels(): Promise<ModelInfo[]> {
  // Refresh stale provider verdicts in the background. Never awaited: this
  // function is on the critical path of /api/v1/bootstrap, and probing 14
  // providers inline would stall app load.
  ensureProviderHealthFresh();

  const configured = new Set(configuredProviders());
  const chat = await discoverModels();
  const generated = GEN_MODELS.filter((model) => configured.has(model.provider) && (model.modality !== "video" || isVideoGenSupported(model)));
  const byId = new Map<string, ModelInfo>();
  for (const model of [...chat, ...generated]) byId.set(model.id, model);
  // Every configured lab is listed, INCLUDING one whose account is out of
  // credit or whose key is rejected.
  //
  // This used to end in `.filter((model) => providerHealthy(model.provider))`,
  // on the reasoning that a model which cannot answer should not be offered.
  // What that produced was worse than the problem: an unfunded Anthropic
  // account deleted Claude — every model, on the website, on iOS and on macOS
  // at once — with no message anywhere saying why, because the manifest has no
  // way to say "this lab is down" (availability is available|coming_soon|
  // requires_plan). A whole lab silently ceasing to exist reads as a bug in
  // Juno, not as a billing state of one provider account, and it is not
  // recoverable from the UI: the models are simply gone.
  //
  // Health did not stop being useful, it stopped being a *filter*. It still
  // reports through /api/health, still alerts an operator on the down/recovered
  // transition, still marks `available` on the runner catalog below, and
  // /api/chat still reroutes a request off a dead provider with a visible
  // warning instead of streaming a guaranteed failure — which is the honest
  // place to handle it, because that is the moment there is a user to tell.
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The catalog the model pickers are handed: every configured lab, every model
 * still being served, with the newest of each product line current and the
 * older generations marked so the UI files them under "Past models".
 *
 * Split from `loadAvailableModels` because the two audiences differ. A picker
 * wants a catalog it can group; the cloud runner wants it flat, because a task
 * already running was pinned to whatever model it started with and the marking
 * would tell it nothing it can act on.
 *
 * This used to *prune* to one model per line, which needed a `keepIds` escape
 * hatch so an account whose saved default had been superseded did not get a
 * blank settings dropdown. Marking removes the need for both: nothing is
 * withheld, so every stored selection is still in the list — under the
 * disclosure, where it belongs.
 */
export async function loadSelectableModels(): Promise<ModelInfo[]> {
  return withSupersededMarked(await loadAvailableModels());
}

/**
 * The backend model catalog in the shape `@juno/agent-core`'s proxy provider
 * expects (BackendConfig.models — see runner/agent-core/src/providers/proxy.ts).
 * Built from the SAME server source the Mac app consumes (loadAvailableModels),
 * so the cloud runner and the native host bill/route identically.
 *
 * `provider` is the path segment under /api/agent; `model` is the id sent to the
 * provider API. Chat models only, and never Responses-only entries (the proxy
 * provider speaks /chat/completions or /v1/messages, not the Responses API).
 */
export interface BackendAgentModel {
  provider: string;
  providerName: string;
  kind: "anthropic" | "openai";
  model: string;
  label: string;
  available: boolean;
  vision: boolean;
  contextWindow: number;
}

export function backendAgentCatalog(models: ModelInfo[]): BackendAgentModel[] {
  return models
    .filter((model) => model.modality === "chat" && model.api !== "responses" && !model.comingSoon)
    .map((model) => {
      const metrics = getModelMetrics(model);
      return {
        provider: model.provider,
        providerName: PROVIDERS[model.provider].label,
        kind: PROVIDERS[model.provider].kind,
        model: model.providerModel,
        label: model.name,
        // The runner is the one consumer that still wants the health verdict as
        // a value: it picks a provider to route a whole task through with no
        // user present to warn, so advertising a lab whose account is dead
        // would burn a task on a guaranteed 401. It was hardcoded `true` back
        // when loadAvailableModels had already dropped unhealthy providers;
        // now that the catalog lists them, the flag has to carry the fact.
        available: providerHealthy(model.provider),
        vision: model.vision,
        contextWindow: model.contextWindow ?? metrics.contextTokens,
      };
    });
}
