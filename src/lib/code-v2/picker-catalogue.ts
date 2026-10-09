/**
 * The Code model picker's catalogue, the way the web chat catalogue reads:
 * a rail of AI labs, then one "Subscriptions" tile.
 *
 * - A lab tile lists that lab's models grouped by where they run: "Alevr"
 *   (Alevr-hosted, metered by Alevr), then "Your <Lab> key" when the user has
 *   that key. Inside a group, newest generation first (sortModelsForDisplay).
 * - The Subscriptions tile lists one group per CONNECTED plan the Mac reports
 *   (Claude, ChatGPT, ACP runtimes). API keys never appear there.
 * - Only models that write code are listed: image, video and audio models are
 *   chosen in Settings (generation-models.ts), never here.
 *
 * Pure, so the Mac's picker can match it row for row and the tests pin it.
 */
import type { ModelInfo } from "@/lib/models";
import { sortModelsForDisplay } from "@/lib/model-metrics";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import type { ModelSelection, ProviderInstance, ProviderModel } from "@/lib/code-v2/contracts";
import { catalogModel, isCodeAgentModel } from "@/lib/code-v2/code-models";
import { displayName, isConnected, isInstanceVisible, isSubscriptionKind, type FeatureFlags } from "@/lib/code-v2/providers-view";
import { formatTokens } from "@/lib/code-v2/tier-view";

/** A rail lab: a catalogue provider, or OpenRouter for an OpenRouter key's models. */
export type PickerLab = Provider | "openrouter";

export type PickerTab = { type: "lab"; lab: PickerLab } | { type: "subscriptions" };

export interface PickerRow {
  instance: ProviderInstance;
  model: ProviderModel;
  /** The second line: "$5 / $25 · 1M", "Your key · 200K", "Included in your plan · 1M". */
  line: string;
}

export interface PickerGroup {
  /** Stable key: "alevr:anthropic", "byok:anthropic", the subscription instance id. */
  id: string;
  title: string;
  /** The subscription instance a group belongs to (its usage line sits on the heading's right). */
  subscription?: ProviderInstance;
  rows: PickerRow[];
}

export interface LabTile {
  lab: PickerLab;
  name: string;
}

export const SUBSCRIPTIONS_TITLE = "Subscriptions";
export const CONNECT_SUBSCRIPTION = { title: "Connect a subscription", sub: "Claude, ChatGPT, Gemini and more, on your Mac" } as const;

/** "Anthropic", "OpenAI", "Google", "OpenRouter": the lab's name, as the chat catalogue heads its groups. */
export function labName(lab: PickerLab): string {
  if (lab === "openrouter") return "OpenRouter";
  return PROVIDERS[lab]?.label.split(" · ")[0] ?? lab;
}

/** The lab a model id belongs to: the prefix before ":" ("anthropic:claude-opus-5-5" → anthropic). */
export function labOfModelId(modelId: string): PickerLab | null {
  const colon = modelId.indexOf(":");
  if (colon <= 0) return null;
  const prefix = modelId.slice(0, colon);
  if (prefix === "openrouter") return "openrouter";
  return (PROVIDER_LIST as readonly string[]).includes(prefix) ? (prefix as Provider) : null;
}

/** Whether a metered model may appear: a catalogue model must be one that drives an agent loop. */
export function isTextCodeModel(model: Pick<ProviderModel, "id">): boolean {
  const info = catalogModel(model.id);
  if (!info) return true; // OpenRouter and other ids the catalogue has not met: their lists are already text-only.
  return isCodeAgentModel(info);
}

function compactRate(perMTok: number): string {
  const s = perMTok.toFixed(2);
  return `$${s.endsWith(".00") ? s.slice(0, -3) : s}`;
}

/** The row's second line, by where the model runs. */
export function pickerRowLine(instance: ProviderInstance, model: ProviderModel): string {
  const tiers = [...(model.contextTiers ?? [])].sort((a, b) => a.tokens - b.tokens);
  const window = tiers.length ? formatTokens(tiers[tiers.length - 1].tokens) : undefined;
  if (instance.kind === "alevr") {
    const rates = tiers[0] ? `${compactRate(tiers[0].inputPerMTok)} / ${compactRate(tiers[0].outputPerMTok)}` : "Alevr";
    return [rates, window].filter(Boolean).join(" · ");
  }
  if (instance.kind === "byok") return ["Your key", window].filter(Boolean).join(" · ");
  return ["Included in your plan", window].filter(Boolean).join(" · ");
}

/** The heading of a subscription group: "Claude plan", "ChatGPT plan", or the runtime's name. */
export function subscriptionTitle(instance: ProviderInstance): string {
  if (instance.kind === "claude-agent") return "Claude plan";
  if (instance.kind === "codex") return "ChatGPT plan";
  return displayName(instance);
}

/** Newest generation first, as the web chat catalogue orders a lab; ids the catalogue does not know keep their order, last. */
export function sortForPicker(models: readonly ProviderModel[]): ProviderModel[] {
  const known: { model: ProviderModel; info: ModelInfo }[] = [];
  const unknown: ProviderModel[] = [];
  for (const m of models) {
    const info = catalogModel(m.id);
    if (info) known.push({ model: m, info });
    else unknown.push(m);
  }
  const order = sortModelsForDisplay(known.map((k) => k.info));
  const rank = new Map(order.map((info, i) => [info, i]));
  known.sort((a, b) => (rank.get(a.info) ?? 0) - (rank.get(b.info) ?? 0));
  return [...known.map((k) => k.model), ...unknown];
}

function usableKey(instance: ProviderInstance): boolean {
  return instance.kind === "byok" && isConnected(instance);
}

/** A key's models: its own list, or (when it reports none) the Alevr models of its lab. Text models only. */
function keyModels(key: ProviderInstance, alevr: ProviderInstance | undefined): ProviderModel[] {
  const provider = key.id.split(":")[1] ?? "";
  if (key.models?.length) return key.models.filter(isTextCodeModel);
  if (provider === "openrouter" || !alevr) return [];
  return (alevr.models ?? []).filter((m) => labOfModelId(m.id) === provider).filter(isTextCodeModel);
}

/** The lab groups for one lab: "Alevr", then "Your <Lab> key" (OpenRouter: only the key's group). */
export function labGroups(instances: readonly ProviderInstance[], lab: PickerLab): PickerGroup[] {
  const alevr = instances.find((i) => i.kind === "alevr");
  const groups: PickerGroup[] = [];
  if (alevr && lab !== "openrouter") {
    const models = sortForPicker((alevr.models ?? []).filter((m) => labOfModelId(m.id) === lab).filter(isTextCodeModel));
    if (models.length) groups.push({ id: `alevr:${lab}`, title: "Alevr", rows: models.map((model) => ({ instance: alevr, model, line: pickerRowLine(alevr, model) })) });
  }
  for (const key of instances) {
    if (!usableKey(key)) continue;
    const models = keyModels(key, alevr).filter((m) => labOfModelId(m.id) === lab);
    if (!models.length) continue;
    const sorted = lab === "openrouter" ? models : sortForPicker(models);
    groups.push({ id: `${key.id}:${lab}`, title: `Your ${labName(lab)} key`, rows: sorted.map((model) => ({ instance: key, model, line: pickerRowLine(key, model) })) });
  }
  return groups;
}

/** Rail lab tiles: every lab with at least one selectable text model, in PROVIDER_LIST order, OpenRouter last. */
export function labTiles(instances: readonly ProviderInstance[]): LabTile[] {
  const labs: PickerLab[] = [...PROVIDER_LIST, "openrouter"];
  return labs.filter((lab) => labGroups(instances, lab).length > 0).map((lab) => ({ lab, name: labName(lab) }));
}

/** The connected subscriptions the Mac reports, one group each. API keys never appear here. */
export function subscriptionGroups(instances: readonly ProviderInstance[], flags: FeatureFlags = {}): PickerGroup[] {
  return instances
    .filter((i) => isSubscriptionKind(i.kind) && isConnected(i) && isInstanceVisible(i, flags))
    .map((i) => ({ id: i.id, title: subscriptionTitle(i), subscription: i, rows: (i.models ?? []).map((model) => ({ instance: i, model, line: pickerRowLine(i, model) })) }))
    .filter((g) => g.rows.length > 0);
}

export function tabKey(tab: PickerTab): string {
  return tab.type === "subscriptions" ? "subscriptions" : `lab:${tab.lab}`;
}

/** The rail in order: the lab tiles, then Subscriptions ("+" is not a tab). */
export function pickerTabs(instances: readonly ProviderInstance[]): PickerTab[] {
  return [...labTiles(instances).map((t): PickerTab => ({ type: "lab", lab: t.lab })), { type: "subscriptions" }];
}

/** Where the picker opens: Subscriptions for a plan's model, else the selected model's lab, else the first lab. */
export function defaultTab(instances: readonly ProviderInstance[], selection: Pick<ModelSelection, "instanceId" | "model">): PickerTab {
  const inst = instances.find((i) => i.id === selection.instanceId);
  if (inst && isSubscriptionKind(inst.kind)) return { type: "subscriptions" };
  const tiles = labTiles(instances);
  const lab = labOfModelId(selection.model);
  if (lab && tiles.some((t) => t.lab === lab)) return { type: "lab", lab };
  return tiles[0] ? { type: "lab", lab: tiles[0].lab } : { type: "subscriptions" };
}

/** ⌘⇧↑/↓: the next tab along the rail. */
export function cycleTab(instances: readonly ProviderInstance[], current: PickerTab, delta: 1 | -1): PickerTab {
  const tabs = pickerTabs(instances);
  const i = tabs.findIndex((t) => tabKey(t) === tabKey(current));
  return tabs[(i < 0 ? 0 : i + delta + tabs.length) % tabs.length];
}

/** The groups a tab shows. */
export function tabGroups(instances: readonly ProviderInstance[], tab: PickerTab, flags: FeatureFlags = {}): PickerGroup[] {
  return tab.type === "subscriptions" ? subscriptionGroups(instances, flags) : labGroups(instances, tab.lab);
}

/**
 * Search labs and subscriptions together: one group per lab with a match
 * (headed by the lab's name), then one "Subscriptions" group. A query that
 * names a lab or a plan lists all of its models.
 */
export function searchCatalogue(instances: readonly ProviderInstance[], query: string, flags: FeatureFlags = {}): PickerGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hit = (row: PickerRow, ...names: string[]) =>
    row.model.label.toLowerCase().includes(q) || row.model.id.toLowerCase().includes(q) || names.some((n) => n.toLowerCase().includes(q));
  const out: PickerGroup[] = [];
  for (const tile of labTiles(instances)) {
    const rows = labGroups(instances, tile.lab).flatMap((g) => g.rows.filter((r) => hit(r, tile.name, g.title)));
    if (rows.length) out.push({ id: `search:${tile.lab}`, title: tile.name, rows });
  }
  const subs = subscriptionGroups(instances, flags).flatMap((g) => g.rows.filter((r) => hit(r, g.title)));
  if (subs.length) out.push({ id: "search:subscriptions", title: SUBSCRIPTIONS_TITLE, rows: subs });
  return out;
}
