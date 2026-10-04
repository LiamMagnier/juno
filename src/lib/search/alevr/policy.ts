/**
 * Which search a chat turn gets (BRIEF §15: "web search must not depend on
 * whether a model provider happens to include native search").
 *
 * The rule, decided here once for the route, the tool planner, Auto and the
 * model catalogues:
 *
 *   - When Alevr Search can answer on this deployment and the model takes
 *     function tools, the turn gets Alevr's tool family — `web_search`,
 *     `search_news`, `web_fetch`, `find_in_page` — on EVERY model, whether or
 *     not its provider has a search of its own. Same tools, same ranking, same
 *     cache, same security, same costs on the ledger.
 *   - The provider's own search is then an optional extra, off by default
 *     (`ALEVR_SEARCH_PROVIDER_NATIVE=also` turns it on beside Alevr's), and
 *     the fallback when Alevr Search cannot run: no backend configured, a model
 *     without function tools, or a turn whose transport cannot carry tools
 *     (voice keeps the provider's own search, private chats too — their tool
 *     calls would need the audited broker a private chat may not write to).
 *
 * Pure and client-safe.
 */

import type { ModelInfo } from "@/lib/models";
import { toolCapabilitiesFor } from "@/lib/model-tools";

export type NativeSearchPolicy = "fallback" | "also" | "prefer";

export function nativeSearchPolicy(env: Readonly<Record<string, string | undefined>> = process.env): NativeSearchPolicy {
  const raw = env.ALEVR_SEARCH_PROVIDER_NATIVE?.trim().toLowerCase();
  return raw === "also" || raw === "prefer" ? raw : "fallback";
}

export interface TurnSearchInput {
  /** The person asked for web, and plan, workspace and research state allow it. */
  webRequested: boolean;
  model: Pick<ModelInfo, "id" | "provider" | "modality" | "webSearch">;
  /** `alevrSearchAvailable()` on this deployment. */
  alevrAvailable: boolean;
  voice: boolean;
  private: boolean;
  policy?: NativeSearchPolicy;
}

export interface TurnSearchPlan {
  /** Attach Alevr's search tools. */
  alevr: boolean;
  /** Turn on the provider's own search in the model request. */
  native: boolean;
}

export function alevrToolsUsable(model: TurnSearchInput["model"]): boolean {
  return model.modality === "chat" && toolCapabilitiesFor(model as ModelInfo).supported;
}

export function planTurnSearch(input: TurnSearchInput): TurnSearchPlan {
  if (!input.webRequested) return { alevr: false, native: false };
  const policy = input.policy ?? "fallback";
  const providerHas = !!input.model.webSearch;
  const alevr = input.alevrAvailable && !input.voice && !input.private && alevrToolsUsable(input.model);
  if (!alevr) return { alevr: false, native: providerHas };
  if (policy === "prefer" && providerHas) return { alevr: false, native: true };
  return { alevr: true, native: policy === "also" && providerHas };
}

/** Whether turning web on can do anything for this model here: Alevr's tools, or its provider's search. */
export function webSearchPossible(model: TurnSearchInput["model"], alevrAvailable: boolean): boolean {
  if (model.modality !== "chat") return false;
  return !!model.webSearch || (alevrAvailable && alevrToolsUsable(model));
}
