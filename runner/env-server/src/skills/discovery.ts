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
 * watches every skills root and every SKILL.md it listed. A write, rename or
 * new skill drops the listing at once and, ~150 ms later (one rescan for a
 * burst of events), re-reads it and tells its listeners, which push
 * `skills.updated` to every client so the pickers refresh live. A 60 s poll
 * stays as the fallback for a change no watcher saw (a network volume, a
 * watcher the OS refused).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalSkillSummary } from "../contracts/code-v2.js";
import { discoverAll, exists, skillRoots, toSummaries, type DiscoveredSkill, type SkillRoot } from "./skill-files.js";

// The shared SKILL.md layer (also the cloud runner's, in agent-core).
export * from "./skill-files.js";

export interface SkillCatalogOptions {
  home?: string;
  /** The fallback poll: cached listings are re-read this often even without a change event. */
  maxAgeMs?: number;
  /** Set false in tests that must not hold watchers open. */
  watch?: boolean;
  /** One rescan for a burst of file events, this long after the last. */
  debounceMs?: number;
}

/** What changed: one project's skills (`cwd`), or any listing (absent). */
export interface SkillChange {
  cwd?: string;
}

/** Most SKILL.md files watched one by one; past it the roots' own watchers still see changes. */
const MAX_FILE_WATCHERS = 1_000;

/** A listing's identity: a change to any name, description or path is a change. */
function fingerprint(skills: readonly DiscoveredSkill[]): string {
  return skills.map((s) => `${s.source}\u0000${s.name}\u0000${s.path}\u0000${s.description}`).join("\u0001");
}

/**
 * The skills of this Mac, cached per folder, invalidated by file-system
 * events on the skills roots, on each SKILL.md and on Claude Code's plugin
 * records, with a slow poll behind them.
 */
export class SkillCatalog {
  readonly home: string;
  private readonly maxAgeMs: number;
  private readonly watchEnabled: boolean;
  private readonly debounceMs: number;
  private readonly cache = new Map<string, { at: number; skills: Promise<DiscoveredSkill[]>; print?: string }>();
  /** path → watcher and the listing it belongs to ("" = every listing). */
  private readonly watchers = new Map<string, { watcher: fs.FSWatcher; scope: string; file: boolean }>();
  private readonly listeners = new Set<(change: SkillChange) => void>();
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: SkillCatalogOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.watchEnabled = options.watch ?? true;
    this.debounceMs = options.debounceMs ?? 150;
  }

  /** Called after a watched skill or folder changed and the listing was re-read. */
  onChange(listener: (change: SkillChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every discovered skill for `cwd`, shadowed ones included, nearest first. */
  async discover(cwd?: string): Promise<DiscoveredSkill[]> {
    const key = cwd ? path.resolve(cwd) : "";
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.skills;
    return this.read(key);
  }

  /** The `skills.list` answer for `cwd`. */
  async list(cwd?: string): Promise<LocalSkillSummary[]> {
    return toSummaries(await this.discover(cwd));
  }

  /** Drops every listing now and tells the listeners (any listing may have changed). */
  invalidate(): void {
    this.cache.clear();
    this.notify({});
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
    this.pending.clear();
  }

  private read(key: string): Promise<DiscoveredSkill[]> {
    const entry: { at: number; skills: Promise<DiscoveredSkill[]>; print?: string } = { at: Date.now(), skills: Promise.resolve([]) };
    entry.skills = (async () => {
      const roots = await skillRoots({ home: this.home, cwd: key || undefined });
      const skills = await discoverAll(roots);
      if (this.watchEnabled && !this.closed) await this.watchAll(key, roots, skills);
      entry.print = fingerprint(skills);
      return skills;
    })();
    this.cache.set(key, entry);
    entry.skills.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    if (this.watchEnabled && !this.poll && !this.closed) {
      // The fallback: a change no watcher reported still reaches the pickers.
      this.poll = setInterval(() => void this.sweep(), this.maxAgeMs);
      this.poll.unref?.();
    }
    return entry.skills;
  }

  private notify(change: SkillChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** A watcher fired: drop the listing now, rescan once the burst is over. */
  private changed(scope: string): void {
    if (this.closed) return;
    if (scope) this.cache.delete(scope);
    else {
      // Every listing read the changed folder: re-read each one that was cached.
      for (const key of this.cache.keys()) this.pending.add(key);
      this.cache.clear();
    }
    this.pending.add(scope);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const scopes = [...this.pending];
    this.pending.clear();
    const everything = scopes.includes("");
    // Re-read what was dropped (re-arming watchers on new or replaced files)
    // before telling anyone, so a picker that re-lists gets the new listing.
    await Promise.all(scopes.map((key) => this.read(key).catch(() => [])));
    if (this.closed) return;
    if (everything) this.notify({});
    else for (const cwd of scopes) this.notify({ cwd });
  }

  /** The poll: re-read every cached listing and report the ones that changed. */
  private async sweep(): Promise<void> {
    for (const [key, entry] of [...this.cache]) {
      const before = entry.print ?? (await entry.skills.then(fingerprint, () => ""));
      const after = fingerprint(await this.read(key).catch(() => []));
      if (this.closed) return;
      if (after !== before) this.notify(key ? { cwd: key } : {});
    }
  }

  private async watchAll(key: string, roots: readonly SkillRoot[], skills: readonly DiscoveredSkill[]): Promise<void> {
    const targets: { dir: string; recursive: boolean; scope: string; file: boolean }[] = [];
    for (const root of roots) {
      const scope = root.source === "project" ? key : "";
      // A root that does not exist yet is watched through its parent, so the
      // first skill installed into a new ~/.alevr/skills is still noticed.
      if (await exists(root.dir)) targets.push({ dir: root.dir, recursive: true, scope, file: false });
      else if (await exists(path.dirname(root.dir))) targets.push({ dir: path.dirname(root.dir), recursive: false, scope, file: false });
    }
    const pluginsDir = path.join(this.home, ".claude", "plugins");
    if (await exists(pluginsDir)) targets.push({ dir: pluginsDir, recursive: false, scope: "", file: false });
    // Each skill's own folder and SKILL.md: an edit is seen at once, through a
    // symlinked folder too (a recursive root watcher does not follow links).
    for (const skill of skills) {
      const scope = skill.source === "project" ? key : "";
      targets.push({ dir: skill.dir, recursive: false, scope, file: false });
      targets.push({ dir: skill.path, recursive: false, scope, file: true });
    }
    let files = [...this.watchers.values()].filter((w) => w.file).length;
    for (const target of targets) {
      if (this.watchers.has(target.dir)) continue;
      if (target.file && files >= MAX_FILE_WATCHERS) continue;
      try {
        const watcher = fs.watch(target.dir, { recursive: target.recursive, persistent: false }, (event) => {
          // A replaced or removed file: this watcher follows the old one, so
          // drop it; the rescan watches whatever is at the path now.
          if (target.file && event === "rename") this.unwatch(target.dir);
          this.changed(target.scope);
        });
        watcher.on("error", () => this.unwatch(target.dir));
        this.watchers.set(target.dir, { watcher, scope: target.scope, file: target.file });
        if (target.file) files++;
      } catch {
        /* unwatchable: the poll still refreshes it */
      }
    }
  }

  private unwatch(dir: string): void {
    const entry = this.watchers.get(dir);
    if (!entry) return;
    entry.watcher.close();
    this.watchers.delete(dir);
  }
}
