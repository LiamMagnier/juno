/**
 * Small lookups the composer and pickers share: the model a selection names,
 * its description and rates, and the words for efforts and runtime modes.
 */
import { catalogModel } from "@/lib/code-v2/code-models";
import {
  instanceKindOf,
  pickContextTier,
  resolveModelAlias,
  type ContextTier,
  type EffortLevel,
  type ModelSelection,
  type ProviderInstance,
  type ProviderModel,
  type RuntimeMode,
} from "@/lib/code-v2/contracts";
import type { RateLookup } from "@/lib/code-v2/orchestrate";
import { shortModelLabel } from "@/lib/code-v2/providers-view";

export function findInstance(instances: readonly ProviderInstance[], id: string): ProviderInstance | undefined {
  return instances.find((i) => i.id === id);
}

export function findModel(instances: readonly ProviderInstance[], sel: Pick<ModelSelection, "instanceId" | "model">): ProviderModel | undefined {
  return findInstance(instances, sel.instanceId)?.models?.find((m) => m.id === sel.model);
}

/** The catalogue entry behind a model id, for any instance ("opus", "claude-opus-5-5", "anthropic:claude-opus-5-5"). */
function catalogFor(id: string) {
  const alias = resolveModelAlias(id);
  return catalogModel(alias) ?? catalogModel(`anthropic:${id}`) ?? catalogModel(`openai:${id}`) ?? catalogModel(`google:${id}`);
}

export function modelDescription(id: string): string | undefined {
  const d = catalogFor(id)?.description;
  if (!d) return undefined;
  // One line: the first sentence.
  const first = d.split(/(?<=\.)\s/)[0];
  return first.length > 90 ? `${first.slice(0, 88).trimEnd()}…` : first;
}

export function modelLabel(instances: readonly ProviderInstance[], sel: Pick<ModelSelection, "instanceId" | "model">): string {
  return findModel(instances, sel)?.label ?? catalogFor(sel.model)?.name ?? sel.model.split(":").pop() ?? sel.model;
}

export function shortLabel(instances: readonly ProviderInstance[], sel: Pick<ModelSelection, "instanceId" | "model">): string {
  return shortModelLabel(modelLabel(instances, sel));
}

export function tiersOf(instances: readonly ProviderInstance[], sel: ModelSelection): ContextTier[] {
  return findModel(instances, sel)?.contextTiers ?? [];
}

/** The tier a selection runs at: the chosen one, else the smallest (the default window). */
export function currentTier(instances: readonly ProviderInstance[], sel: ModelSelection): ContextTier | undefined {
  const tiers = [...tiersOf(instances, sel)].sort((a, b) => a.tokens - b.tokens);
  if (!tiers.length) return undefined;
  if (sel.contextTokens) return tiers.find((t) => t.tokens === sel.contextTokens) ?? pickContextTier(tiers, sel.contextTokens) ?? tiers[0];
  return tiers[0];
}

export function ratesFor(instances: readonly ProviderInstance[]): RateLookup {
  return (sel) => {
    const kind = instanceKindOf(sel.instanceId);
    if (kind !== "alevr" && kind !== "byok") return undefined;
    const t = currentTier(instances, sel);
    return t ? { inputPerMTok: t.inputPerMTok, outputPerMTok: t.outputPerMTok } : undefined;
  };
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLevelsOf(instances: readonly ProviderInstance[], sel: ModelSelection): EffortLevel[] {
  const m = findModel(instances, sel);
  return m?.effortLevels ?? findInstance(instances, sel.instanceId)?.capabilities?.effortLevels ?? [];
}

export function effectiveEffort(instances: readonly ProviderInstance[], sel: ModelSelection): EffortLevel | undefined {
  return sel.effort ?? findModel(instances, sel)?.defaultEffort;
}

export function cycleEffort(instances: readonly ProviderInstance[], sel: ModelSelection): ModelSelection {
  const levels: EffortLevel[] = effortLevelsOf(instances, sel).filter((l) => l !== "none");
  if (!levels.length) return sel;
  const cur = effectiveEffort(instances, sel);
  const i = cur ? levels.indexOf(cur) : -1;
  return { ...sel, effort: levels[(i + 1) % levels.length] };
}

export const RUNTIME_MODES: { mode: RuntimeMode; label: string; glyph: string; description: string }[] = [
  { mode: "read-only", label: "Read only", glyph: "eye", description: "Reads and plans. Changes nothing." },
  { mode: "ask", label: "Ask first", glyph: "ask-first", description: "Asks before every edit and command." },
  { mode: "auto-edit", label: "Auto-edit", glyph: "lock", description: "Edits files in the workspace; asks before commands." },
  { mode: "auto", label: "Auto", glyph: "shield", description: "Edits and runs commands in the sandbox; asks to leave it." },
  { mode: "full", label: "Full access", glyph: "unlock", description: "No sandbox and no questions. Only on a machine you trust." },
];

export function runtimeModeInfo(mode: RuntimeMode) {
  return RUNTIME_MODES.find((m) => m.mode === mode) ?? RUNTIME_MODES[2];
}

export function cycleRuntimeMode(mode: RuntimeMode, allowed?: readonly RuntimeMode[]): RuntimeMode {
  const list = RUNTIME_MODES.map((m) => m.mode).filter((m) => !allowed?.length || allowed.includes(m));
  const i = list.indexOf(mode);
  return list[(i + 1) % list.length] ?? mode;
}

/** Default selection on an instance: its default model with that model's default effort. */
export function defaultSelection(instance: ProviderInstance): ModelSelection | null {
  const m = instance.models?.find((x) => x.isDefault) ?? instance.models?.[0];
  return m ? { instanceId: instance.id, model: m.id, ...(m.defaultEffort ? { effort: m.defaultEffort } : {}) } : null;
}
