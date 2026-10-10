/**
 * SKILL.md files: parsing, discovery and rendering (skills lane).
 *
 * SHARED, BYTE FOR BYTE. This file lives in runner/agent-core/src/skills/
 * (the cloud runner's engine) and in runner/env-server/src/skills/ (the Mac's
 * env server); both build standalone, so each carries a copy, and
 * scripts/check-code-v2-contracts.mjs fails when they differ. Edit the
 * agent-core copy, then run it with `--write`. The pure parsing half is
 * skill-parse.ts, which the hosted web shares as well.
 *
 * A skill is a folder holding a `SKILL.md`: YAML front matter with `name` and
 * `description`, then the instructions, the format Claude Code defined and
 * Codex, Alevr and Juno read too. Skills are found in three tiers, and a
 * same-named skill resolves to the nearest one:
 *
 *   project  <cwd>/.alevr/skills, <cwd>/.juno/skills, <cwd>/.claude/skills
 *   user     ~/.alevr/skills, ~/.juno/skills, ~/.claude/skills, ~/.codex/skills
 *   plugin   each enabled Claude Code plugin's skills (installed_plugins.json)
 *
 * Without a home (a cloud runner, which has no reader's folders) only the
 * project tier is read.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { LocalSkillSummary, SkillActivation, SkillOrigin } from "../contracts/code-v2.js";
import { HEAD_BYTES, PROJECT_SKILL_DIRS, SKILL_LIST_MAX, SKILL_MAX_BYTES, parseSkillFile, skillName } from "./skill-parse.js";

// The pure SKILL.md layer (parsing, names, limits), shared with the hosted web.
export * from "./skill-parse.js";

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

export async function exists(p: string): Promise<boolean> {
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

/**
 * Every folder skills are read from, nearest first (precedence order). With no
 * `home`, the project's folders only.
 */
export async function skillRoots(options: { home?: string; cwd?: string }): Promise<SkillRoot[]> {
  const { home, cwd } = options;
  const roots: SkillRoot[] = [];
  if (cwd && path.isAbsolute(cwd) && (!home || path.resolve(cwd) !== path.resolve(home))) {
    for (const { dir, origin } of PROJECT_SKILL_DIRS) roots.push({ dir: path.join(cwd, ...dir.split("/")), source: "project", origin });
  }
  if (!home) return roots;
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
