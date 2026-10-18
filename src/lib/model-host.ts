import type { ModelInfo } from "@/lib/models";
import {
  DEEPINFRA,
  PROVIDERS,
  deepInfraApiKey,
  deepInfraBaseUrl,
  isProviderConfigured,
  providerApiKey,
  providerBaseUrl,
  type Provider,
} from "@/lib/providers";
import { DEEPINFRA_MODELS, type DeepInfraModelEntry } from "@/lib/deepinfra-models.generated";
import type { ReasoningEffort } from "@/types/chat";

/**
 * WHERE a model is served, as opposed to WHOSE model it is.
 *
 * Every catalog row belongs to one lab (`ModelInfo.provider`), and that never
 * changes. A row may additionally be served by DeepInfra (`deepinfra: "<id>"`
 * in models.ts). The rule, the whole of it:
 *
 *   DEEPINFRA_API_KEY set  AND  the row has a DeepInfra id  AND  DeepInfra has
 *   not deprecated that id   →  DeepInfra, with DeepInfra's id
 *   otherwise                →  the lab's own API with the lab's key, as before
 *
 * A model is available when EITHER route is configured, so a deployment with
 * only DEEPINFRA_API_KEY offers exactly the rows DeepInfra serves, and one with
 * only lab keys behaves as it always did.
 *
 * Deprecation matters because DeepInfra keeps a deprecated id answering by
 * forwarding it to its `replaced_by` model — sometimes another lab's. Serving a
 * reader GLM-4.6V's request with Gemma, billed and labelled as GLM, is worse
 * than not routing at all, so from `deprecatedOn` the row falls back to its lab.
 *
 * Reads the server environment. In the browser no key is visible, so every
 * row answers "lab" there, which is what the client-side price display wants
 * anyway: the authoritative figures are computed on the server.
 */
export type ModelHost = "lab" | "deepinfra";

/** Today as the catalog reckons it ("YYYY-MM-DD", UTC), matching models.ts CATALOG_TODAY. */
function catalogToday(): string {
  return process.env.JUNO_CATALOG_TODAY ?? new Date().toISOString().slice(0, 10);
}

/**
 * The DeepInfra listing for a canonical model id, when the id is one DeepInfra
 * may serve today. Ignores whether a key is configured — see `deepInfraRoute`.
 */
export function deepInfraEntry(
  model: Pick<ModelInfo, "id"> & Partial<Pick<ModelInfo, "deepinfra">>,
  today: string = catalogToday(),
): DeepInfraModelEntry | null {
  const entry = DEEPINFRA_MODELS[model.id];
  if (!entry) return null;
  // A row passed in full must still name this listing: the generated table and
  // the catalog are kept in step by a test, and a mismatch is not routed.
  if (model.deepinfra !== undefined && model.deepinfra !== entry.model) return null;
  if (entry.deprecatedOn && entry.deprecatedOn <= today) return null;
  return entry;
}

/** The DeepInfra listing this request will be served by, or null for the lab's own API. */
export function deepInfraRoute(
  model: Pick<ModelInfo, "id"> & Partial<Pick<ModelInfo, "deepinfra">>,
): DeepInfraModelEntry | null {
  if (!deepInfraApiKey()) return null;
  return deepInfraEntry(model);
}

export function modelHost(model: Pick<ModelInfo, "id"> & Partial<Pick<ModelInfo, "deepinfra">>): ModelHost {
  return deepInfraRoute(model) ? "deepinfra" : "lab";
}

/** Whether this deployment can serve the model at all: the lab's key, or a DeepInfra route. */
export function isModelConfigured(model: Pick<ModelInfo, "id" | "provider"> & Partial<Pick<ModelInfo, "deepinfra">>): boolean {
  return isProviderConfigured(model.provider) || deepInfraRoute(model) !== null;
}

/** Everything a transport needs to send one request. Never logged: it holds the key. */
export interface ModelRoute {
  host: ModelHost;
  /** The `model` field of the request — DeepInfra's id when routed there. */
  requestModel: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Who is answering, for logs and error attribution ("Moonshot · Kimi via DeepInfra"). */
  label: string;
  deepinfra: DeepInfraModelEntry | null;
}

export function modelRoute(model: Pick<ModelInfo, "id" | "provider" | "providerModel"> & Partial<Pick<ModelInfo, "deepinfra">>): ModelRoute {
  const entry = deepInfraRoute(model);
  if (entry) {
    return {
      host: "deepinfra",
      requestModel: entry.model,
      apiKey: deepInfraApiKey(),
      baseUrl: deepInfraBaseUrl(),
      label: hostLabel(model.provider, "deepinfra"),
      deepinfra: entry,
    };
  }
  return {
    host: "lab",
    requestModel: model.providerModel,
    apiKey: providerApiKey(model.provider),
    baseUrl: providerBaseUrl(model.provider),
    label: hostLabel(model.provider, "lab"),
    deepinfra: null,
  };
}

export function hostLabel(provider: Provider, host: ModelHost): string {
  return host === "deepinfra" ? `${PROVIDERS[provider].label} via ${DEEPINFRA.label}` : PROVIDERS[provider].label;
}

/** The provider label to attribute this model's errors to. */
export function modelProviderLabel(model: Pick<ModelInfo, "id" | "provider"> & Partial<Pick<ModelInfo, "deepinfra">>): string {
  return hostLabel(model.provider, modelHost(model));
}

/**
 * The labs with at least one model this deployment can serve — by the lab's
 * own key or through DeepInfra. What the client is told under
 * `features.providers`, where it filters the first paint of the picker.
 */
export function reachableProviders(models: readonly ModelInfo[], providers: readonly Provider[]): Provider[] {
  return providers.filter((p) => isProviderConfigured(p) || models.some((m) => m.provider === p && deepInfraRoute(m)));
}

/**
 * The reasoning fields of a DeepInfra request.
 *
 * DeepInfra speaks one dialect for every model it hosts: OpenAI's top-level
 * `reasoning_effort` (none|low|medium|high). None of the labs' own spellings
 * (`thinking:{type}`, `enable_thinking`, `thinking_budget`, `reasoning_split`)
 * belong on its wire. Sent only to listings DeepInfra tags as reasoning, and
 * "none" only to those it tags `can-disable-reasoning`; anything else gets no
 * field and runs at DeepInfra's default.
 */
export function deepInfraReasoningFields(
  entry: DeepInfraModelEntry,
  model: Pick<ModelInfo, "reasoning">,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> {
  const reasons = entry.tags.includes("reasoning") || entry.tags.includes("can-disable-reasoning");
  if (!model.reasoning || !reasons) return {};
  if (effort) {
    const level = effort === "minimal" ? "low" : effort === "xhigh" || effort === "max" ? "high" : effort;
    return { reasoning_effort: level };
  }
  return entry.tags.includes("can-disable-reasoning") ? { reasoning_effort: "none" } : {};
}
