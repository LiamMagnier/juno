/**
 * Provider instance registry (SPEC §2: "provider instances isolate accounts").
 *
 * Seeds come from presets.ts; the user's own additions and overrides (a
 * second Claude account with its own CLAUDE_CONFIG_DIR, a custom binary path,
 * a custom ACP agent, turning a legal-hold preset on) live in
 * `<dataDir>/instances.json`. Probe results are cached in memory and pushed to
 * clients as `provider.updated`; they are never written to disk, so a stale
 * "ready" can never outlive the process that saw it.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProviderInstance, ProviderKind } from "../contracts/code-v2.js";
import { isProviderKind } from "../contracts/code-v2.js";
import { acpPreset, defaultInstances } from "./presets.js";
import { candidateDirs, expandHome, findBinary } from "./detect.js";
import type { ProbeResult, ProviderAdapter } from "./types.js";
import { isAntigravity, type AntigravityService } from "./antigravity/service.js";
import type { Logger } from "../util.js";
import { describeError, nowIso } from "../util.js";

/** On-disk shape of one entry in instances.json. */
export interface InstanceConfig {
  id: string;
  kind?: ProviderKind;
  label?: string;
  binaryPath?: string;
  configDir?: string;
  env?: Record<string, string>;
  launchArgs?: string[];
  acpCommand?: string[];
  /** Turns a legal-hold preset on (Antigravity), or any instance off. */
  enabled?: boolean;
  /** Removes a seeded instance from the list. */
  hidden?: boolean;
}

export interface RegistryOptions {
  dataDir: string;
  adapters: Map<ProviderKind, ProviderAdapter>;
  logger: Logger;
  /** Directories searched for binaries; tests point this at fake vendor CLIs. */
  searchDirs?: string[];
  onUpdate?: (instance: ProviderInstance) => void;
  /** Antigravity's managed runtime: detection and its install / sign-in state on every instance. */
  antigravity?: AntigravityService;
}

export class ProviderRegistry {
  #instances = new Map<string, ProviderInstance>();
  #enabled = new Map<string, boolean>();
  #probing = new Map<string, Promise<ProviderInstance>>();
  readonly #options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.#options = options;
    this.reload();
  }

  get file(): string {
    return path.join(this.#options.dataDir, "instances.json");
  }

  reload(): void {
    const seeds = defaultInstances();
    let configs: InstanceConfig[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(raw)) configs = raw.filter((c): c is InstanceConfig => !!c && typeof c === "object" && typeof (c as InstanceConfig).id === "string");
    } catch {
      configs = [];
    }
    const merged = new Map<string, ProviderInstance>();
    for (const seed of seeds) merged.set(seed.id, seed);
    this.#enabled.clear();
    for (const config of configs) {
      const base = merged.get(config.id);
      if (config.hidden) {
        merged.delete(config.id);
        continue;
      }
      const kind = config.kind ?? base?.kind ?? inferKind(config.id);
      if (!kind || !isProviderKind(kind)) {
        this.#options.logger.warn(`instances.json: ${config.id} has no valid kind; ignored`);
        continue;
      }
      const instance: ProviderInstance = {
        ...(base ?? { id: config.id, kind, label: config.label ?? config.id, status: "unknown" as const }),
        kind,
      };
      if (config.label) instance.label = config.label;
      if (config.binaryPath) instance.binaryPath = expandHome(config.binaryPath);
      if (config.configDir) instance.configDir = expandHome(config.configDir);
      if (config.env) instance.env = config.env;
      if (config.launchArgs) instance.launchArgs = config.launchArgs;
      if (config.acpCommand?.length) instance.acpCommand = config.acpCommand;
      if (config.enabled !== undefined) this.#enabled.set(config.id, config.enabled);
      merged.set(config.id, instance);
    }
    // Keep live probe state across reloads.
    for (const [id, instance] of merged) {
      const live = this.#instances.get(id);
      if (live) merged.set(id, { ...live, ...instance, status: live.status, statusMessage: live.statusMessage });
    }
    this.#instances = merged;
    for (const instance of this.#instances.values()) this.#detect(instance);
  }

  /** Adds an instance that exists only for this process (BYOK keys pushed with env.configure). */
  ensure(instance: ProviderInstance): ProviderInstance {
    const existing = this.#instances.get(instance.id);
    if (existing) return structuredClone(existing);
    this.#instances.set(instance.id, { ...instance });
    this.#options.onUpdate?.(structuredClone(instance));
    return structuredClone(instance);
  }

  remove(id: string): void {
    this.#instances.delete(id);
  }

  list(): ProviderInstance[] {
    return [...this.#instances.values()].map((i) => this.#decorate(structuredClone(i)));
  }

  get(id: string): ProviderInstance | undefined {
    const instance = this.#instances.get(id);
    return instance ? this.#decorate(structuredClone(instance)) : undefined;
  }

  #decorate(instance: ProviderInstance): ProviderInstance {
    const service = this.#options.antigravity;
    return service && isAntigravity(instance) ? service.decorate(instance) : instance;
  }

  /** Every Antigravity instance (install state is shared by all of them). */
  antigravityIds(): string[] {
    return [...this.#instances.values()].filter((i) => isAntigravity(i)).map((i) => i.id);
  }

  /** Whether a session may be started on this instance (legal holds, user switches). */
  isEnabled(id: string): { enabled: boolean; reason?: string } {
    const instance = this.#instances.get(id);
    if (!instance) return { enabled: false, reason: `No provider instance "${id}".` };
    const explicit = this.#enabled.get(id);
    if (explicit === false) return { enabled: false, reason: `${instance.label} is turned off.` };
    const preset = instance.kind === "acp" ? acpPreset(instance) : undefined;
    if (preset?.legalHold && explicit !== true && process.env.ALEVR_ENABLE_LEGAL_HOLD !== "1") {
      return { enabled: false, reason: preset.legalHold };
    }
    return { enabled: true };
  }

  adapterFor(kind: ProviderKind): ProviderAdapter | undefined {
    return this.#options.adapters.get(kind);
  }

  /** Merges a partial update (probe result, mid-turn limits) and notifies clients. */
  update(id: string, patch: ProbeResult & { checkedAt?: string }): ProviderInstance | undefined {
    const current = this.#instances.get(id);
    if (!current) return undefined;
    const next: ProviderInstance = { ...current, ...patch };
    if (patch.status === "ready" && !patch.statusMessage) delete next.statusMessage;
    for (const key of Object.keys(patch) as (keyof ProviderInstance)[]) if (patch[key as keyof typeof patch] === undefined) delete next[key];
    // Install and sign-in progress is owned by the Antigravity service and decorated on read.
    delete next.install;
    delete next.auth;
    this.#instances.set(id, next);
    const out = this.#decorate(structuredClone(next));
    this.#options.onUpdate?.(out);
    return out;
  }

  /** Runs the adapter's probe (cheap, no sessions, no hooks, no logins). Concurrent probes of one instance share a result. */
  probe(id: string, cwd?: string): Promise<ProviderInstance> {
    const existing = this.#probing.get(id);
    if (existing) return existing;
    const run = (async () => {
      const instance = this.#instances.get(id);
      if (!instance) throw new Error(`No provider instance "${id}".`);
      this.#detect(instance);
      const fresh = this.#instances.get(id)!;
      const adapter = this.#options.adapters.get(fresh.kind);
      if (!adapter) {
        return this.update(id, { status: "error", statusMessage: `This build has no ${fresh.kind} adapter.`, checkedAt: nowIso() })!;
      }
      const capabilities = adapter.capabilities(fresh);
      if (fresh.status === "not-installed") {
        return this.update(id, { capabilities, checkedAt: nowIso() })!;
      }
      try {
        const result = await adapter.probe(fresh, { logger: this.#options.logger, cwd });
        const gate = this.isEnabled(id);
        const patch: ProbeResult & { checkedAt: string } = { capabilities, ...result, checkedAt: nowIso() };
        if (!gate.enabled && patch.status === "ready") {
          patch.status = "error";
          patch.statusMessage = gate.reason;
        }
        return this.update(id, patch)!;
      } catch (error) {
        return this.update(id, { capabilities, status: "error", statusMessage: describeError(error), checkedAt: nowIso() })!;
      }
    })().finally(() => this.#probing.delete(id));
    this.#probing.set(id, run);
    return run;
  }

  /** Probes every installed instance; failures are recorded on the instance, never thrown. */
  async probeAll(cwd?: string): Promise<void> {
    await Promise.all(
      [...this.#instances.values()].map((i) => this.probe(i.id, cwd).catch(() => undefined)),
    );
  }

  /** Filesystem-only detection: binary path and not-installed status. Never runs anything. */
  #detect(instance: ProviderInstance): void {
    const service = this.#options.antigravity;
    if (service && isAntigravity(instance)) {
      // Managed runtime first, then a hand-installed one; the resolved path is never written back.
      const found = service.detect(instance);
      if (found.found) {
        if (instance.status === "not-installed") {
          instance.status = "unknown";
          delete instance.statusMessage;
        }
      } else {
        instance.status = "not-installed";
        instance.statusMessage = found.statusMessage ?? `${instance.label} is not installed on this Mac.`;
      }
      return;
    }
    const dirs = this.#options.searchDirs ?? candidateDirs();
    const names = binaryNames(instance);
    if (names.length === 0) {
      if (instance.status === "unknown" && (instance.kind === "alevr" || instance.kind === "byok")) {
        // Engine-backed instances have no binary; the probe decides.
      }
      return;
    }
    let found: string | undefined;
    for (const name of names) {
      found = findBinary(name, dirs);
      if (found) break;
    }
    if (found) {
      instance.binaryPath = found;
      if (instance.status === "not-installed") {
        instance.status = "unknown";
        delete instance.statusMessage;
      }
    } else {
      instance.status = "not-installed";
      instance.statusMessage = `${instance.label} is not installed on this Mac.`;
    }
  }
}

function inferKind(id: string): ProviderKind | undefined {
  const head = id.split(":")[0];
  return isProviderKind(head) ? head : undefined;
}

/** Binary names to look for, in order. An explicit binaryPath wins. */
export function binaryNames(instance: ProviderInstance): string[] {
  if (instance.binaryPath) return [instance.binaryPath];
  switch (instance.kind) {
    case "claude-agent":
      return ["claude"];
    case "codex":
      return ["codex"];
    case "acp": {
      const first = instance.acpCommand?.[0];
      const preset = acpPreset(instance);
      return [...(first ? [first] : []), ...(preset?.binaryAliases ?? [])];
    }
    default:
      return [];
  }
}
