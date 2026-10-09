/**
 * How provider instances read in the UI (DESIGN §5.8 rail and header, §5.13
 * Connections, §7 copy): display names, which lab mark, rail order, the one
 * sentence of facts, and the action a row offers. Branches on `kind` and
 * declared capabilities, never on a vendor's marketing name (the ACP command
 * is what identifies an ACP runtime).
 *
 * Owner rule: Claude via the user's own CLI is "Claude (your subscription)",
 * never "Claude Code" as if it were ours.
 */
import type { Provider } from "@/lib/providers";
import { instanceKindOf, type ProviderInstance, type ProviderModel, type UsageWindow } from "@/lib/code-v2/contracts";
import { formatReset } from "@/lib/code-v2/tier-view";
import { openRouterLab } from "@/lib/code-v2/openrouter";

/** ACP runtimes Alevr knows how to name, by the binary in `acpCommand[0]` or the instance id suffix. */
export const ACP_RUNTIMES: Record<string, { name: string; lab: Provider | null; note?: string; flag?: string }> = {
  gemini: { name: "Gemini CLI", lab: "google", note: "Personal Google accounts can't be used here." },
  grok: { name: "Grok", lab: "xai" },
  dsh: { name: "DeepSeek Harness", lab: "deepseek" },
  opencode: { name: "OpenCode", lab: null },
  // Enabled by the owner on 2026-10-09: a normal provider, no flag. Alevr installs Google's runtime
  // and signs it in with Google itself (provider.install / provider.auth), see `managedSetup`.
  "antigravity-acp": { name: "Antigravity", lab: "google" },
  antigravity: { name: "Antigravity", lab: "google" },
};

const BYOK_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export function acpRuntimeKey(instance: Pick<ProviderInstance, "id" | "acpCommand">): string | null {
  const bin = instance.acpCommand?.[0]?.split("/").pop();
  if (bin && ACP_RUNTIMES[bin]) return bin;
  const suffix = instance.id.split(":")[1]?.split("@")[0];
  if (suffix && ACP_RUNTIMES[suffix]) return suffix;
  return null;
}

export interface FeatureFlags {
  [flag: string]: boolean | undefined;
}

/** Whether an instance appears at all (a runtime with a flag in ACP_RUNTIMES stays absent until the flag is on). */
export function isInstanceVisible(instance: ProviderInstance, flags: FeatureFlags = {}): boolean {
  if (instance.kind !== "acp") return true;
  const key = acpRuntimeKey(instance);
  const flag = key ? ACP_RUNTIMES[key].flag : undefined;
  return !flag || !!flags[flag];
}

export function displayName(instance: Pick<ProviderInstance, "id" | "kind" | "label" | "acpCommand">): string {
  switch (instance.kind) {
    case "alevr":
      return "Alevr";
    case "claude-agent":
      return "Claude (your subscription)";
    case "codex":
      return "ChatGPT (Codex)";
    case "byok": {
      const p = instance.id.split(":")[1] ?? "";
      return `Your ${BYOK_NAMES[p] ?? p} key`;
    }
    case "acp": {
      const key = acpRuntimeKey(instance);
      return key ? ACP_RUNTIMES[key].name : instance.label;
    }
  }
}

/** Short name for compact places ("Your subscription", "ChatGPT (Codex)", "Alevr"). */
export function shortInstanceName(instance: Pick<ProviderInstance, "id" | "kind" | "label" | "acpCommand">): string {
  if (instance.kind === "claude-agent") return "Your subscription";
  return displayName(instance);
}

/** Which lab mark to draw: a provider, "alevr" for the Continuum mark, or "key" / "terminal" glyphs. */
export type InstanceMark = { type: "lab"; provider: Provider } | { type: "alevr" } | { type: "glyph"; name: string };

export function instanceMark(instance: Pick<ProviderInstance, "id" | "kind" | "acpCommand">): InstanceMark {
  switch (instance.kind) {
    case "alevr":
      return { type: "alevr" };
    case "claude-agent":
      return { type: "lab", provider: "anthropic" };
    case "codex":
      return { type: "lab", provider: "openai" };
    case "byok":
      return { type: "glyph", name: "key" };
    case "acp": {
      const key = acpRuntimeKey(instance);
      const lab = key ? ACP_RUNTIMES[key].lab : null;
      return lab ? { type: "lab", provider: lab } : { type: "glyph", name: "terminal" };
    }
  }
}

/** The lab a model id belongs to ("anthropic:claude-opus-5-5" → anthropic; Codex ids → openai). */
export function modelLab(modelId: string, instance?: Pick<ProviderInstance, "kind" | "id" | "acpCommand">): Provider | null {
  const colon = modelId.indexOf(":");
  // OpenRouter models wear their own lab's mark ("openrouter:anthropic/…" → anthropic), or none.
  if (colon > 0 && modelId.slice(0, colon) === "openrouter") return openRouterLab(modelId.slice(colon + 1));
  if (colon > 0) return modelId.slice(0, colon) as Provider;
  if (instance) {
    const m = instanceMark(instance);
    if (m.type === "lab") return m.provider;
  }
  if (/^(gpt|o\d|codex)/i.test(modelId)) return "openai";
  if (/^claude|opus|sonnet|haiku|fable/i.test(modelId)) return "anthropic";
  if (/^gemini/i.test(modelId)) return "google";
  if (/^grok/i.test(modelId)) return "xai";
  if (/^deepseek/i.test(modelId)) return "deepseek";
  return null;
}

export function isSubscriptionKind(kind: ProviderInstance["kind"]): boolean {
  return kind === "claude-agent" || kind === "codex" || kind === "acp";
}

export function isConnected(instance: ProviderInstance): boolean {
  return instance.status === "ready" || instance.status === "limited";
}

export type RailGroup = "alevr" | "subscription" | "installed" | "byok";

export interface RailEntry {
  instance: ProviderInstance;
  group: RailGroup;
  /** Draw the mark at 50% ink (installed, not connected). */
  dim: boolean;
  tooltip: string;
}

/** Rail order: Alevr, connected subscriptions, installed-but-not-connected, then (separator) BYOK keys. */
export function railEntries(instances: readonly ProviderInstance[], flags: FeatureFlags = {}, now = new Date()): RailEntry[] {
  const visible = instances.filter((i) => isInstanceVisible(i, flags));
  const out: RailEntry[] = [];
  const push = (instance: ProviderInstance, group: RailGroup, dim: boolean) =>
    out.push({ instance, group, dim, tooltip: `${displayName(instance)}: ${statusSentence(instance, now, true)}` });
  for (const i of visible) if (i.kind === "alevr") push(i, "alevr", false);
  for (const i of visible) if (isSubscriptionKind(i.kind) && isConnected(i)) push(i, "subscription", false);
  for (const i of visible) if (isSubscriptionKind(i.kind) && !isConnected(i) && i.status !== "not-installed") push(i, "installed", true);
  for (const i of visible) if (i.kind === "byok") push(i, "byok", i.status !== "ready");
  return out;
}

export function planName(plan?: string): string | undefined {
  if (!plan) return undefined;
  const p = plan.toLowerCase();
  const pretty: Record<string, string> = { max: "Max", pro: "Pro", plus: "Plus", team: "Team", enterprise: "Enterprise", free: "Free" };
  return `${pretty[p] ?? plan} plan`;
}

function windowPhrase(w: UsageWindow, now: Date): string {
  const label = /hour/i.test(w.label) ? `${w.label} window` : w.label.toLowerCase().includes("week") ? "weekly window" : w.label;
  const parts = [label];
  if (w.usedPct !== undefined) parts.push(`${Math.round(w.usedPct)}% used`);
  const s = parts.join(" ");
  return w.resetsAt ? `${s}, resets ${formatReset(w.resetsAt, now)}` : s;
}

/**
 * The one sentence of facts an instance shows (picker header; `short` for the
 * rail tooltip). Words, never a badge.
 */
export function statusSentence(instance: ProviderInstance, now = new Date(), short = false): string {
  const plan = planName(instance.account?.plan);
  const window = instance.limits?.[0];
  switch (instance.status) {
    case "not-installed":
      return "Not installed.";
    case "signed-out":
      return instance.statusMessage ?? "Installed, not signed in.";
    case "error":
      return instance.statusMessage ?? "Could not start. Re-check in Connections.";
    case "unknown":
      return "Not checked yet.";
    case "limited": {
      const w = instance.limits?.find((l) => (l.usedPct ?? 0) >= 100) ?? window;
      return `${plan ?? "Plan"} limit reached${w?.resetsAt ? `. Resets at ${formatReset(w.resetsAt, now)}` : ""}.`;
    }
    case "ready":
      break;
  }
  if (instance.kind === "alevr") return instance.statusMessage ?? "Alevr models on your plan.";
  if (instance.kind === "byok") {
    const p = instance.id.split(":")[1] ?? "";
    return `Your ${BYOK_NAMES[p] ?? p} key. Billed by ${BYOK_NAMES[p] ?? p}, not Alevr.`;
  }
  const facts = [plan, window ? windowPhrase(window, now) : undefined].filter(Boolean).join(", ");
  if (short) return facts ? `${facts}` : "Signed in";
  const how =
    instance.kind === "claude-agent"
      ? "Runs your own claude on this Mac."
      : instance.kind === "codex"
        ? "Runs your own Codex on this Mac."
        : `Runs ${displayName(instance)} on this Mac.`;
  return facts ? `${how} ${facts}.` : how;
}

/** Connections row sentence (binary + version, account, plan). */
export function connectionSentence(instance: ProviderInstance): string {
  const plan = planName(instance.account?.plan);
  const acpKey = instance.kind === "acp" ? acpRuntimeKey(instance) : null;
  const note = acpKey ? ACP_RUNTIMES[acpKey].note : undefined;
  const managed = managedProgress(instance);
  if (managed) return managed;
  if (instance.status === "not-installed") {
    return isManagedRuntime(instance)
      ? "Not installed. Alevr downloads Google's official runtime and checks it before first use."
      : "Not installed. Alevr opens a terminal with the install command so you can read it first.";
  }
  if (instance.status === "signed-out") return instance.statusMessage ?? "Installed, not signed in.";
  if (instance.status === "error") return instance.statusMessage ?? "Could not start.";
  const bin =
    instance.kind === "claude-agent"
      ? `Your own claude CLI${instance.version ? `, version ${instance.version}` : ""}.`
      : instance.kind === "codex"
        ? `Codex app-server${instance.version ? ` ${instance.version}` : ""}.`
        : `${displayName(instance)}${instance.version ? ` ${instance.version}` : ""}.`;
  const who = instance.account?.email
    ? ` Signed in as ${instance.account.email}${plan ? `, ${plan}` : ""}.`
    : instance.account?.tokenSource === "apiKey"
      ? " Signed in with an API key."
      : plan
        ? ` ${plan}.`
        : "";
  return `${bin}${who}${note ? ` ${note}` : ""}`;
}

export type ConnectionAction = "install" | "sign-in" | "sign-in-again" | "manage" | "re-check";

export function connectionAction(instance: ProviderInstance): ConnectionAction {
  switch (instance.status) {
    case "not-installed":
      return "install";
    case "signed-out":
      return instance.account?.email || instance.account?.plan ? "sign-in-again" : "sign-in";
    case "error":
    case "unknown":
      return "re-check";
    default:
      return "manage";
  }
}

export const CONNECTION_ACTION_LABELS: Record<ConnectionAction, string> = {
  install: "Install",
  "sign-in": "Sign in",
  "sign-in-again": "Sign in again",
  manage: "Manage",
  "re-check": "Re-check",
};

/** Expired sign-in reads in coral (needs you). */
export function isExpired(instance: ProviderInstance): boolean {
  return instance.status === "signed-out" && connectionAction(instance) === "sign-in-again";
}

/**
 * Fallback install/login commands when the env server is older than
 * `provider.setup`. Typed into the in-app terminal, never run for the user.
 */
export function fallbackSetupCommand(instance: ProviderInstance, action: "install" | "login"): string | null {
  if (instance.kind === "claude-agent") return action === "install" ? "curl -fsSL https://claude.ai/install.sh | bash" : "claude auth login";
  if (instance.kind === "codex") return action === "install" ? "npm install -g @openai/codex" : "codex login";
  if (instance.kind === "acp") {
    const key = acpRuntimeKey(instance);
    if (key === "gemini") return action === "install" ? "npm install -g @google/gemini-cli" : null;
    if (key === "grok") return action === "login" ? "grok login" : null;
  }
  return null;
}

/** A runtime Alevr installs and signs in itself (Antigravity): the env server reports `install`. */
export function isManagedRuntime(instance: Pick<ProviderInstance, "install">): boolean {
  return !!instance.install;
}

/** The command a Connections action sends for a managed runtime, instead of a terminal step. */
export function managedSetup(
  instance: ProviderInstance,
  action: "install" | "login",
): { type: "provider.install"; params: { instanceId: string; action: "start" } } | { type: "provider.auth"; params: { instanceId: string; action: "start" } } | null {
  if (!isManagedRuntime(instance)) return null;
  return action === "install"
    ? { type: "provider.install", params: { instanceId: instance.id, action: "start" } }
    : { type: "provider.auth", params: { instanceId: instance.id, action: "start" } };
}

/** One sentence for an install or sign-in in progress, or null when none is. */
export function managedProgress(instance: Pick<ProviderInstance, "install" | "auth">): string | null {
  const install = instance.install;
  if (install && (install.phase === "downloading" || install.phase === "extracting" || install.phase === "verifying")) {
    if (install.phase === "downloading" && install.totalBytes) {
      const pct = Math.min(100, Math.floor(((install.downloadedBytes ?? 0) / install.totalBytes) * 100));
      return `Downloading Google's runtime, ${pct}%.`;
    }
    return install.message ?? "Installing.";
  }
  if (install?.phase === "failed" && install.message) return install.message;
  const auth = instance.auth;
  if (auth?.phase === "waiting") return "Waiting for Google sign-in. On another device, paste the address the sign-in page ends on.";
  if (auth?.phase === "starting" || auth?.phase === "verifying") return auth.message ?? "Signing in.";
  if (auth?.phase === "failed" && auth.message) return auth.message;
  return null;
}

/** Models an instance lists in the picker: its own list; for Alevr/BYOK, the catalogue's coding list. */
export function pickerModels(instance: ProviderInstance, query = ""): ProviderModel[] {
  const list = instance.models ?? [];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

/** Search across every instance (results carry the instance for the sub-line). */
export function searchAllModels(instances: readonly ProviderInstance[], query: string): { instance: ProviderInstance; model: ProviderModel }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { instance: ProviderInstance; model: ProviderModel }[] = [];
  for (const instance of instances) for (const model of pickerModels(instance, q)) out.push({ instance, model });
  return out;
}

/** "Opus 5.5" from "Claude Opus 5.5" — the composer's short model label. */
export function shortModelLabel(label: string): string {
  return label.replace(/^(Claude|Google|OpenAI|xAI)\s+/i, "").trim();
}

/** Cycle the instance selection for ⌘⇧↑/↓. */
export function cycleInstance(entries: readonly RailEntry[], currentId: string, delta: 1 | -1): string {
  if (entries.length === 0) return currentId;
  const i = entries.findIndex((e) => e.instance.id === currentId);
  const next = (i < 0 ? 0 : i + delta + entries.length) % entries.length;
  return entries[next].instance.id;
}

export { instanceKindOf };
