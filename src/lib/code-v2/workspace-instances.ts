/**
 * The provider instances the live workspace offers (DESIGN §5.8 rail): Alevr
 * from the catalogue, the subscriptions the user's Mac reports, and one BYOK
 * instance per stored key. Pure, so the rail's composition is tested.
 */
import {
  BYOK_PROVIDER_VALUES,
  byokInstanceId,
  type ModelSelection,
  type ProviderCapabilities,
  type ProviderInstance,
  type ProviderModel,
} from "@/lib/code-v2/contracts";
import type { ByokKeyRecord } from "@/lib/code-v2/byok-client";

/** What the Alevr engine can do on the web (remote CodeTask path or the env server's built-in engine). */
export const ALEVR_CAPABILITIES: ProviderCapabilities = {
  steering: true,
  queue: true,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: true,
  planMode: true,
  approvals: ["read-only", "ask", "auto-edit", "auto", "full"],
  subagents: true,
  computerUse: true,
  contextTiers: true,
  effortLevels: ["low", "medium", "high", "max"],
  images: true,
  mcpInjection: true,
};

const BYOK_LAB: Record<string, string> = { anthropic: "anthropic", openai: "openai", google: "google", xai: "xai", deepseek: "deepseek", openrouter: "openrouter" };

export function buildInstances(input: {
  /** The catalogue's coding models (codeProviderModels()). */
  alevrModels: ProviderModel[];
  alevrStatus?: ProviderInstance["status"];
  alevrMessage?: string;
  /** From the env server's provider.list; empty when no Mac is linked. */
  deviceInstances?: readonly ProviderInstance[];
  byokKeys?: readonly ByokKeyRecord[];
  /** OpenRouter's models (GET /api/provider-keys/openrouter/models), for a stored OpenRouter key. */
  openRouterModels?: readonly ProviderModel[];
}): ProviderInstance[] {
  const out: ProviderInstance[] = [
    {
      id: "alevr",
      kind: "alevr",
      label: "Alevr",
      status: input.alevrStatus ?? "ready",
      statusMessage: input.alevrMessage,
      capabilities: ALEVR_CAPABILITIES,
      models: input.alevrModels,
    },
  ];
  const seen = new Set(["alevr"]);
  for (const i of input.deviceInstances ?? []) {
    // The Mac's own alevr / byok instances are the same engine as ours; the web keeps one row each.
    if (i.kind === "alevr" || i.kind === "byok" || seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  for (const p of BYOK_PROVIDER_VALUES) {
    const key = input.byokKeys?.find((k) => k.provider === p);
    if (!key) continue;
    const lab = BYOK_LAB[p];
    out.push({
      id: byokInstanceId(p),
      kind: "byok",
      label: `${p} key`,
      ...(p === "openrouter" && !input.openRouterModels?.length && !key.invalid ? { statusMessage: "Loading OpenRouter's models." } : {}),
      status: key.invalid ? "error" : "ready",
      statusMessage: key.invalid ? (key.detail ?? "The lab refused this key.") : undefined,
      capabilities: ALEVR_CAPABILITIES,
      models: p === "openrouter" ? [...(input.openRouterModels ?? [])] : input.alevrModels.filter((m) => m.id.startsWith(`${lab}:`)),
    });
  }
  return out;
}

/** A selection that still names an existing model, else the first usable default. */
export function reconcileSelection(instances: readonly ProviderInstance[], sel: ModelSelection | null | undefined): ModelSelection {
  if (sel) {
    const inst = instances.find((i) => i.id === sel.instanceId);
    if (inst?.models?.some((m) => m.id === sel.model)) return sel;
  }
  const usable = instances.find((i) => (i.status === "ready" || i.status === "limited") && i.models?.length) ?? instances[0];
  const m = usable?.models?.find((x) => x.isDefault) ?? usable?.models?.[0];
  return { instanceId: usable?.id ?? "alevr", model: m?.id ?? "", ...(m?.defaultEffort ? { effort: m.defaultEffort } : {}) };
}
