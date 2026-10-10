/**
 * Skills installed on this Mac (skills lane, contracts `skills.list`).
 *
 * A skill is a folder holding a `SKILL.md`: YAML front matter with `name` and
 * `description`, then the instructions, the format Claude Code defined and
 * Codex, Alevr and Juno read too. This module finds them, the way Claude Code
 * would, in three tiers, and a same-named skill resolves to the nearest one:
 *
 *   project  <cwd>/.alevr/skills, <cwd>/.juno/skills, <cwd>/.claude/skills
 *   user     ~/.alevr/skills, ~/.juno/skills, ~/.claude/skills, ~/.codex/skills
 *   plugin   each enabled Claude Code plugin's skills (installed_plugins.json)
 *
 * WHAT LEAVES THE MAC. `skills.list` reports names, descriptions and paths,
 * never a body: the list crosses the device link to the hosted web, and a
 * skill's instructions are the reader's own files. The body is read here, on
 * the Mac, when a turn runs under the skill (`loadSkillInstructions`), and the
 * path a client sends back is only ever used to pick between same-named skills
 * this module itself discovered, never opened as given.
 *
 * Watched, not polled: a `SkillCatalog` caches one listing per folder and
 * drops it when anything under a skills root changes, so the composer's
 * selector reflects a skill installed a moment ago.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalSkillSummary, SkillActivation, SkillOrigin } from "../contracts/code-v2.js";

/** Front matter is read from the head of the file; a SKILL.md larger than this is not a skill. */
export const SKILL_MAX_BYTES = 256 * 1024;
/** What a listing reads per file: enough for any front matter. */
const HEAD_BYTES = 16 * 1024;
/** Descriptions past this are cut; the selector shows two lines. */
export const SKILL_DESCRIPTION_MAX = 500;
/** A safety cap on one listing. */
export const SKILL_LIST_MAX = 500;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface SkillRoot {
  dir: string;
  source: LocalSkillSummary["source"];
  origin: SkillOrigin;
  plugin?: string;
}

/** A discovered skill: the wire summary plus its folder. */
export interface DiscoveredSkill extends LocalSkillSummary {
  dir: string;
}

export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
}

/** The value of one front-matter scalar, unquoted. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, " ") : inner.replace(/''/g, "'");
  }
  return v;
}

/**
 * Splits a SKILL.md into its front matter's `name` and `description` and its
 * body. Reads the YAML subset skills use: `key: value`, quoted values, and
 * block scalars (`>` / `|`, with indented continuation lines). Without front
 * matter the first line of prose stands in for the description.
 */
export function parseSkillFile(text: string): ParsedSkill {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const fields: Record<string, string> = {};
  let body = normalized;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (close > 0) {
      for (let i = 1; i < close; i++) {
        const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!);
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        let value = match[2]!;
        if (/^[>|][-+]?\s*$/.test(value)) {
          const parts: string[] = [];
          while (i + 1 < close && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
            i++;
            parts.push(lines[i]!.trim());
          }
          value = value.startsWith("|") ? parts.join("\n").trim() : parts.filter(Boolean).join(" ");
        } else {
          value = unquote(value);
          // A plain scalar may continue on more-indented lines.
          while (i + 1 < close && /^\s+\S/.test(lines[i + 1]!) && !/^\s*[A-Za-z_][\w-]*\s*:/.test(lines[i + 1]!)) {
            i++;
            value += " " + lines[i]!.trim();
          }
        }
        if (!(key in fields)) fields[key] = value;
      }
      body = lines.slice(close + 1).join("\n");
    }
  }
  body = body.trim();
  let description: string | undefined = fields.description?.trim();
  if (!description) {
    description = body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"));
  }
  const name = fields.name?.trim();
  return {
    name: name || undefined,
    description: description ? description.replace(/\s+/g, " ").slice(0, SKILL_DESCRIPTION_MAX) : undefined,
    body,
  };
}

/** The `/name` a skill answers to: its front matter's name, else its folder's. */
export function skillName(parsed: ParsedSkill, folder: string): string | null {
  for (const candidate of [parsed.name, folder]) {
    const name = candidate?.trim().toLowerCase().replace(/\s+/g, "-");
    if (name && NAME_RE.test(name)) return name;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Each enabled Claude Code plugin's install folder, from its own records. */
export async function claudePluginRoots(home: string): Promise<SkillRoot[]> {
  const pluginsDir = path.join(home, ".claude", "plugins");
  const installed = (await readJson(path.join(pluginsDir, "installed_plugins.json"))) as
    | { plugins?: Record<string, Array<{ installPath?: string; lastUpdated?: string }> | { installPath?: string }> }
    | undefined;
  const settings = (await readJson(path.join(home, ".claude", "settings.json"))) as { enabledPlugins?: Record<string, boolean> } | undefined;
  const enabled = settings?.enabledPlugins ?? {};
  const roots: SkillRoot[] = [];
  for (const [key, value] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[key] === false) continue;
    const entries = Array.isArray(value) ? value : [value];
    // The newest install of the plugin: the one Claude Code itself loads.
    const entry = [...entries].sort((a, b) => String((b as { lastUpdated?: string }).lastUpdated ?? "").localeCompare(String((a as { lastUpdated?: string }).lastUpdated ?? "")))[0];
    const installPath = entry?.installPath;
    if (!installPath || !path.isAbsolute(installPath)) continue;
    const plugin = key.split("@")[0] || key;
    const manifest = (await readJson(path.join(installPath, ".claude-plugin", "plugin.json"))) as { skills?: string | string[] } | undefined;
    const declared = manifest?.skills === undefined ? [] : Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
    const dirs = new Set<string>([path.join(installPath, "skills")]);
    for (const rel of declared) {
      if (typeof rel !== "string") continue;
      const dir = path.resolve(installPath, rel);
      // A manifest names folders inside its own plugin, nothing else.
      if (dir === installPath || dir.startsWith(installPath + path.sep)) dirs.add(dir);
    }
    for (const dir of dirs) roots.push({ dir, source: "plugin", origin: "claude", plugin });
  }
  return roots;
}

/** Every folder skills are read from, nearest first (precedence order). */
export async function skillRoots(options: { home: string; cwd?: string }): Promise<SkillRoot[]> {
  const { home, cwd } = options;
  const roots: SkillRoot[] = [];
  if (cwd && path.isAbsolute(cwd) && path.resolve(cwd) !== path.resolve(home)) {
    roots.push(
      { dir: path.join(cwd, ".alevr", "skills"), source: "project", origin: "alevr" },
      { dir: path.join(cwd, ".juno", "skills"), source: "project", origin: "juno" },
      { dir: path.join(cwd, ".claude", "skills"), source: "project", origin: "claude" },
    );
  }
  roots.push(
    { dir: path.join(home, ".alevr", "skills"), source: "user", origin: "alevr" },
    { dir: path.join(home, ".juno", "skills"), source: "user", origin: "juno" },
    { dir: path.join(home, ".claude", "skills"), source: "user", origin: "claude" },
    { dir: path.join(home, ".codex", "skills"), source: "user", origin: "codex" },
  );
  roots.push(...(await claudePluginRoots(home)));
  return roots;
}

async function readHead(file: string): Promise<string | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > SKILL_MAX_BYTES) return null;
    handle = await fsp.open(file, "r");
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The skills directly inside one root: `<root>/<folder>/SKILL.md`. Symlinked folders are followed. */
export async function readRoot(root: SkillRoot): Promise<DiscoveredSkill[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: DiscoveredSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(root.dir, entry.name);
    const file = path.join(dir, "SKILL.md");
    const head = await readHead(file);
    if (head === null) continue;
    const parsed = parseSkillFile(head);
    const name = skillName(parsed, entry.name);
    if (!name) continue;
    found.push({
      name,
      description: parsed.description ?? "",
      source: root.source,
      origin: root.origin,
      path: file,
      dir,
      ...(root.plugin ? { plugin: root.plugin } : {}),
    });
  }
  return found;
}

/**
 * Every skill under `roots`, in precedence order, shadowed ones included
 * (`resolveSkillActivation` may be handed the path of one).
 */
export async function discoverAll(roots: readonly SkillRoot[]): Promise<DiscoveredSkill[]> {
  const all: DiscoveredSkill[] = [];
  for (const root of roots) all.push(...(await readRoot(root)));
  return all;
}

/** One skill per name, the nearest winning (project > user > plugin, then root order). */
export function dedupeSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

/** The listing `skills.list` answers with: deduped, summaries only (no `dir`, no body). */
export function toSummaries(skills: readonly DiscoveredSkill[]): LocalSkillSummary[] {
  return dedupeSkills(skills)
    .slice(0, SKILL_LIST_MAX)
    .map(({ name, description, source, origin, path: file, plugin }) => ({
      name,
      description,
      source,
      origin,
      path: file,
      ...(plugin ? { plugin } : {}),
    }));
}

/** A skill a turn runs under, with its instructions read. */
export interface ResolvedSkill {
  name: string;
  title?: string;
  source: SkillActivation["source"];
  /** The SKILL.md, for a local skill; its folder holds the files it refers to. */
  path?: string;
  instructions: string;
  once: boolean;
}

/** The instructions of a discovered skill: the body after its front matter. */
export async function loadSkillInstructions(file: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > SKILL_MAX_BYTES) return null;
    const body = parseSkillFile(await fsp.readFile(file, "utf8")).body;
    return body || null;
  } catch {
    return null;
  }
}

/** An account skill's instructions are capped like a local one's. */
const ACCOUNT_INSTRUCTIONS_MAX = SKILL_MAX_BYTES;

/**
 * The skills a turn runs under, instructions loaded. A local activation is
 * resolved by NAME among the skills discovered here; its `path` only picks a
 * shadowed same-named skill this module also found, and is never opened as
 * given. Unknown or unreadable skills are dropped and reported in `missing`.
 */
export async function resolveSkillActivations(
  activations: readonly SkillActivation[],
  discovered: readonly DiscoveredSkill[],
): Promise<{ skills: ResolvedSkill[]; missing: string[] }> {
  const skills: ResolvedSkill[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const activation of activations) {
    const name = typeof activation.name === "string" ? activation.name.trim().toLowerCase() : "";
    const key = `${activation.source}:${name}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const once = activation.once === true;
    if (activation.source === "account") {
      const instructions = typeof activation.instructions === "string" ? activation.instructions.trim().slice(0, ACCOUNT_INSTRUCTIONS_MAX) : "";
      if (!instructions) {
        missing.push(name);
        continue;
      }
      skills.push({ name, title: activation.title, source: "account", instructions, once });
      continue;
    }
    const named = discovered.filter((skill) => skill.name === name);
    const match = named.find((skill) => activation.path && skill.path === activation.path) ?? named[0];
    const instructions = match ? await loadSkillInstructions(match.path) : null;
    if (!match || !instructions) {
      missing.push(name);
      continue;
    }
    skills.push({ name, source: match.source, path: match.path, instructions, once });
  }
  return { skills, missing };
}

/**
 * The block a turn's instructions carry for its skills: one `<skill>` per
 * skill with where its files live, so the agent can read the scripts and
 * references a SKILL.md points at, as Claude Code's own skills do.
 */
export function renderSkillInstructions(skills: readonly ResolvedSkill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((skill) => {
    const attrs = [`name="${skill.name}"`];
    if (skill.path) attrs.push(`folder="${path.dirname(skill.path)}"`);
    const where = skill.path
      ? `Files this skill mentions are relative to ${path.dirname(skill.path)}; read them from there when it tells you to.\n\n`
      : "";
    return `<skill ${attrs.join(" ")}>\n${where}${skill.instructions}\n</skill>`;
  });
  const names = skills.map((skill) => skill.name).join(", ");
  return [
    `The user turned on ${skills.length === 1 ? "a skill" : "skills"} for this work: ${names}.`,
    "Follow the instructions in each <skill> block below for this request; they take precedence over your general habits where they conflict, but not over the user's own words.",
    ...blocks,
  ].join("\n\n");
}

export interface SkillCatalogOptions {
  home?: string;
  /** Cached listings older than this are re-read even without a change event. */
  maxAgeMs?: number;
  /** Set false in tests that must not hold watchers open. */
  watch?: boolean;
}

/**
 * The skills of this Mac, cached per folder and invalidated by file-system
 * events under any skills root (and Claude Code's plugin records).
 */
export class SkillCatalog {
  readonly home: string;
  private readonly maxAgeMs: number;
  private readonly watchEnabled: boolean;
  private readonly cache = new Map<string, { at: number; skills: Promise<DiscoveredSkill[]> }>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly listeners = new Set<() => void>();

  constructor(options: SkillCatalogOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.watchEnabled = options.watch ?? true;
  }

  /** Called whenever a watched folder changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every discovered skill for `cwd`, shadowed ones included, nearest first. */
  async discover(cwd?: string): Promise<DiscoveredSkill[]> {
    const key = cwd ? path.resolve(cwd) : "";
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.skills;
    const skills = (async () => {
      const roots = await skillRoots({ home: this.home, cwd: key || undefined });
      if (this.watchEnabled) await this.watchRoots(roots);
      return discoverAll(roots);
    })();
    this.cache.set(key, { at: Date.now(), skills });
    skills.catch(() => this.cache.delete(key));
    return skills;
  }

  /** The `skills.list` answer for `cwd`. */
  async list(cwd?: string): Promise<LocalSkillSummary[]> {
    return toSummaries(await this.discover(cwd));
  }

  invalidate(): void {
    this.cache.clear();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
  }

  private async watchRoots(roots: readonly SkillRoot[]): Promise<void> {
    const targets = new Map<string, boolean>();
    for (const root of roots) {
      // A root that does not exist yet is watched through its parent, so the
      // first skill installed into a new ~/.alevr/skills is still noticed.
      if (await exists(root.dir)) targets.set(root.dir, true);
      else if (await exists(path.dirname(root.dir))) targets.set(path.dirname(root.dir), false);
    }
    const pluginsDir = path.join(this.home, ".claude", "plugins");
    if (await exists(pluginsDir)) targets.set(pluginsDir, false);
    for (const [dir, recursive] of targets) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive, persistent: false }, () => this.invalidate());
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        /* unwatchable: the max age still refreshes it */
      }
    }
  }
}
