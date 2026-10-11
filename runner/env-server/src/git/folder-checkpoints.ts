/**
 * Checkpoints for folders that are not git repositories.
 *
 * The git path (./checkpoints.ts) snapshots a repository into hidden refs. A
 * plain folder (a projectless conversation's private directory, or a project
 * the user never put under git) gets the same thing from a manifest per turn:
 * every file's content hash, with the contents kept once each in a
 * content-addressed store under the env server's data dir. Shell-made edits
 * are captured as well as the agent's own, exactly like `git add -A` would.
 *
 * Diffs between two manifests (or a manifest and the live folder) are written
 * in git's own unified format, so the Changes pane, the per-turn scope, Undo
 * and per-hunk Reject work the same with or without git.
 *
 * Bounded: generated and vendored folders are skipped, files over
 * `maxFileBytes` are compared by size and time only, and past `maxFiles` or
 * `maxTotalBytes` the walk stops (the manifest is marked partial) while the
 * files the session itself edited are always included. The home folder and a
 * volume root are never walked.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileChangeEntry, TurnItem } from "../contracts/code-v2.js";
import { PatchError, normalizeRepoPath, safeRefSegment } from "./checkpoints.js";
import { HunkMismatch, applyHunks, fileSection, parsePatch } from "./line-diff.js";

interface Entry {
  /** sha256 of the content, or `size:mtime` for a file too large to keep. */
  h: string;
  s: number;
  m: number;
  bin?: boolean;
  big?: boolean;
}

interface Manifest {
  version: 1;
  cwd: string;
  turn: number;
  createdAt: string;
  partial: boolean;
  files: Record<string, Entry>;
}

export interface FolderCheckpointInfo {
  turn: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface FolderLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const FOLDER_LIMITS: FolderLimits = { maxFiles: 5000, maxFileBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

/** Folders that are generated, vendored or tooling state: never part of a session's changes. */
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "Pods", "DerivedData", ".build", ".gradle",
]);
const SKIP_FILES = new Set([".DS_Store"]);

/** Files looked at between two returns to the event loop during a folder walk. */
const YIELD_EVERY = 64;

export class FolderCheckpoints {
  readonly #dir: string;
  readonly #limits: FolderLimits;

  constructor(dir: string, limits: Partial<FolderLimits> = {}) {
    this.#dir = dir;
    this.#limits = { ...FOLDER_LIMITS, ...limits };
  }

  #threadDir(threadId: string): string {
    return path.join(this.#dir, "threads", safeRefSegment(threadId));
  }

  #manifestPath(threadId: string, turn: number): string {
    return path.join(this.#threadDir(threadId), `turn-${turn}.json`);
  }

  #blobPath(hash: string): string {
    return path.join(this.#dir, "blobs", hash.slice(0, 2), hash);
  }

  read(threadId: string, turn: number): Manifest | undefined {
    try {
      const manifest = JSON.parse(fs.readFileSync(this.#manifestPath(threadId, turn), "utf8")) as Manifest;
      return manifest.version === 1 ? manifest : undefined;
    } catch {
      return undefined;
    }
  }

  has(threadId: string, turn: number): boolean {
    return fs.existsSync(this.#manifestPath(threadId, turn));
  }

  /** Turns that have a manifest, ascending. */
  turns(threadId: string): number[] {
    try {
      return fs
        .readdirSync(this.#threadDir(threadId))
        .map((name) => /^turn-(\d+)\.json$/.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * Records checkpoint `turn` (replacing one a rollback superseded) and
   * returns what changed since the previous one. `extra` are paths the
   * session is known to have edited, cwd-relative or absolute.
   */
  async create(cwd: string, threadId: string, turn: number, extra: readonly string[] = []): Promise<FolderCheckpointInfo> {
    const previous = turn > 0 ? this.read(threadId, turn - 1) : undefined;
    const manifest = await this.#scan(cwd, extra, previous ?? this.#latest(threadId), true);
    manifest.turn = turn;
    fs.mkdirSync(this.#threadDir(threadId), { recursive: true });
    const file = this.#manifestPath(threadId, turn);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(manifest));
    fs.renameSync(`${file}.tmp`, file);
    if (!previous) return { turn, filesChanged: 0, additions: 0, deletions: 0 };
    const { files } = this.#compare(cwd, previous, manifest, false);
    return {
      turn,
      filesChanged: files.length,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    };
  }

  /**
   * Unified diff plus per-file entries from checkpoint `from` to checkpoint
   * `to` or the live folder. Undefined when `from` (or `to`) was never taken.
   */
  async diff(cwd: string, threadId: string, from: number, to: number | "worktree", extra: readonly string[] = []): Promise<{ diff: string; files: FileChangeEntry[] } | undefined> {
    const base = this.read(threadId, from);
    if (!base) return undefined;
    const target = to === "worktree" ? await this.#scan(cwd, extra, base, false) : this.read(threadId, to);
    if (!target) return undefined;
    return this.#compare(cwd, base, target, to === "worktree");
  }

  /**
   * Restores the session's own files to checkpoint `turn`: only paths its
   * turns changed after it (or `scope.paths`), and never one that changed
   * again after the session's latest checkpoint (another session or the
   * user); those are reported as skipped. The state before is kept as a
   * manifest so nothing written is lost.
   */
  async rollback(
    cwd: string,
    threadId: string,
    turn: number,
    scope: { latestTurn?: number; paths?: readonly string[] } = {},
  ): Promise<{ restoredFiles: number; undoRef: string; skipped: string[] }> {
    const target = this.read(threadId, turn);
    if (!target) throw new Error(`no checkpoint for turn ${turn}`);
    const latestTurn = scope.latestTurn ?? turn;
    const touched = new Set<string>();
    for (const p of scope.paths ?? []) {
      const rel = this.#relative(cwd, p);
      if (rel) touched.add(rel);
    }
    let previous = target;
    for (let t = turn + 1; t <= latestTurn; t++) {
      const next = this.read(threadId, t);
      if (!next) continue;
      for (const file of changedPaths(previous, next)) touched.add(file);
      previous = next;
    }
    const current = await this.#scan(cwd, [...touched, ...Object.keys(target.files)], previous, true);
    const undoRef = path.join(this.#threadDir(threadId), `pre-rollback-${Date.now()}.json`);
    fs.mkdirSync(this.#threadDir(threadId), { recursive: true });
    fs.writeFileSync(undoRef, JSON.stringify(current));
    const laterEdits = previous !== target ? new Set(changedPaths(previous, current)) : new Set<string>();
    const skipped: string[] = [];
    let restoredFiles = 0;
    for (const file of [...touched].sort()) {
      const want = target.files[file];
      const have = current.files[file];
      if (sameEntry(want, have)) continue;
      if (laterEdits.has(file) || want?.big) {
        skipped.push(file);
        continue;
      }
      const abs = path.join(cwd, file);
      if (!inside(cwd, abs) || isSymlink(abs)) {
        skipped.push(file);
        continue;
      }
      if (want) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(this.#blobPath(want.h)));
      } else {
        fs.rmSync(abs, { force: true });
        pruneEmptyDirs(path.dirname(abs), cwd);
      }
      restoredFiles++;
    }
    return { restoredFiles, undoRef, skipped };
  }

  /**
   * Applies a unified diff (or its reverse) to files under `cwd`, all or
   * nothing, with exact context. Paths are cwd-relative and must stay inside.
   */
  applyPatch(cwd: string, patch: string, options: { reverse?: boolean; checkOnly?: boolean } = {}): { applied: boolean; files: string[] } {
    if (!patch.trim()) throw new PatchError("bad_request", "The patch is empty.");
    if (Buffer.byteLength(patch) > 4 * 1024 * 1024) throw new PatchError("bad_request", "The patch is too large.");
    const parsed = parsePatch(patch);
    if (parsed.length === 0) throw new PatchError("bad_request", "The patch names no file.");
    const writes: { abs: string; text: string | null }[] = [];
    const files: string[] = [];
    for (const file of parsed) {
      const named = file.newPath ?? file.oldPath;
      const clean = named ? normalizeRepoPath(named) : undefined;
      if (!named || !clean || clean !== named) throw new PatchError("bad_request", `The patch names an unsafe path: ${named ?? "(none)"}`);
      if (clean.split("/").includes(".git")) throw new PatchError("bad_request", "The patch may not touch .git.");
      const abs = path.join(cwd, clean);
      if (!inside(cwd, abs) || isSymlink(abs)) throw new PatchError("bad_request", `${clean} is outside this session's folder.`);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      let after: string;
      try {
        after = applyHunks(before, file.hunks, options.reverse === true);
      } catch (error) {
        if (error instanceof HunkMismatch) throw new PatchError("conflict", error.message);
        throw error;
      }
      // Undoing a file's creation (or applying its deletion) removes it rather than leaving it empty.
      const gone = after === "" && (options.reverse ? file.oldPath === null : file.newPath === null);
      writes.push({ abs, text: gone ? null : after });
      files.push(clean);
    }
    const list = [...new Set(files)].sort();
    if (options.checkOnly) return { applied: false, files: list };
    for (const w of writes) {
      if (w.text === null) {
        fs.rmSync(w.abs, { force: true });
        pruneEmptyDirs(path.dirname(w.abs), cwd);
      } else {
        fs.mkdirSync(path.dirname(w.abs), { recursive: true });
        fs.writeFileSync(w.abs, w.text);
      }
    }
    return { applied: true, files: list };
  }

  /** Deletes a thread's manifests (session deleted); shared contents stay for other threads. */
  drop(threadId: string): void {
    fs.rmSync(this.#threadDir(threadId), { recursive: true, force: true });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #latest(threadId: string): Manifest | undefined {
    const turns = this.turns(threadId);
    return turns.length ? this.read(threadId, turns[turns.length - 1]) : undefined;
  }

  #relative(cwd: string, file: string): string | undefined {
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    const rel = path.relative(cwd, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      // The agent may name a file through a symlinked or /private-prefixed path.
      try {
        const real = path.relative(fs.realpathSync(cwd), fs.realpathSync(abs));
        if (real && !real.startsWith("..") && !path.isAbsolute(real)) return normalizeRepoPath(real.split(path.sep).join("/"));
      } catch {
        /* outside, or gone */
      }
      return undefined;
    }
    return normalizeRepoPath(rel.split(path.sep).join("/"));
  }

  /**
   * The folder as it is now. `persist` keeps every content in the store
   * (checkpoints); a live view only hashes. The walk hands the event loop back
   * every few files, so a big folder never stalls the server's other sessions.
   */
  async #scan(cwd: string, extra: readonly string[], reuse: Manifest | undefined, persist: boolean): Promise<Manifest> {
    const files: Record<string, Entry> = {};
    let sinceYield = 0;
    const breathe = async (): Promise<void> => {
      if (++sinceYield < YIELD_EVERY) return;
      sinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    let partial = false;
    let count = 0;
    let total = 0;
    const take = (rel: string, stat: fs.Stats, forced: boolean): void => {
      if (files[rel]) return;
      if (!forced && (count >= this.#limits.maxFiles || total >= this.#limits.maxTotalBytes)) {
        partial = true;
        return;
      }
      const entry = this.#entry(path.join(cwd, rel), stat, reuse?.files[rel], persist);
      if (!entry) return;
      files[rel] = entry;
      count++;
      if (!entry.big) total += entry.s;
    };
    const home = path.resolve(os.homedir());
    const resolved = path.resolve(cwd);
    if (resolved === home || resolved === path.parse(resolved).root) partial = true;
    else {
      const stack: string[] = [""];
      while (stack.length) {
        const rel = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => (a.name < b.name ? 1 : -1));
        for (const dirent of entries) {
          const child = rel ? `${rel}/${dirent.name}` : dirent.name;
          if (dirent.isDirectory()) {
            if (!SKIP_DIRS.has(dirent.name)) stack.push(child);
          } else if (dirent.isFile() && !SKIP_FILES.has(dirent.name)) {
            try {
              take(child, fs.statSync(path.join(cwd, child)), false);
            } catch {
              /* vanished */
            }
            await breathe();
          }
        }
      }
    }
    // What the session edited, and what the base held, are always looked at, walk limits or not.
    const always = new Set<string>(Object.keys(reuse?.files ?? {}));
    for (const p of extra) {
      const rel = this.#relative(cwd, p);
      if (rel) always.add(rel);
    }
    for (const rel of always) {
      if (files[rel]) continue;
      const abs = path.join(cwd, rel);
      try {
        const stat = fs.lstatSync(abs);
        if (stat.isFile()) take(rel, stat, true);
      } catch {
        /* deleted */
      }
      await breathe();
    }
    return { version: 1, cwd, turn: -1, createdAt: new Date().toISOString(), partial, files };
  }

  #entry(abs: string, stat: fs.Stats, prior: Entry | undefined, persist: boolean): Entry | undefined {
    const size = stat.size;
    const mtime = Math.floor(stat.mtimeMs);
    if (size > this.#limits.maxFileBytes) return { h: `big:${size}:${mtime}`, s: size, m: mtime, big: true };
    if (prior && !prior.big && prior.s === size && prior.m === mtime && (!persist || fs.existsSync(this.#blobPath(prior.h)))) return prior;
    let content: Buffer;
    try {
      content = fs.readFileSync(abs);
    } catch {
      return undefined;
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (persist) {
      const blob = this.#blobPath(hash);
      if (!fs.existsSync(blob)) {
        fs.mkdirSync(path.dirname(blob), { recursive: true });
        fs.writeFileSync(`${blob}.tmp`, content);
        fs.renameSync(`${blob}.tmp`, blob);
      }
    }
    const entry: Entry = { h: hash, s: content.length, m: mtime };
    if (isBinary(content)) entry.bin = true;
    return entry;
  }

  #content(cwd: string, file: string, entry: Entry, live: boolean): Buffer | undefined {
    try {
      if (!live) return fs.readFileSync(this.#blobPath(entry.h));
      return fs.readFileSync(path.join(cwd, file));
    } catch {
      return undefined;
    }
  }

  #compare(cwd: string, base: Manifest, target: Manifest, live: boolean): { diff: string; files: FileChangeEntry[] } {
    const sections: string[] = [];
    const files: FileChangeEntry[] = [];
    for (const file of changedPaths(base, target)) {
      const before = base.files[file];
      const after = target.files[file];
      const beforeBytes = before && !before.big ? this.#content(cwd, file, before, false) : undefined;
      const afterBytes = after && !after.big ? this.#content(cwd, file, after, live) : undefined;
      const binary = !!(before?.bin || after?.bin || before?.big || after?.big || (before && !beforeBytes) || (after && !afterBytes));
      const section = fileSection(file, before ? (beforeBytes?.toString("utf8") ?? "") : null, after ? (afterBytes?.toString("utf8") ?? "") : null, binary);
      sections.push(section.text);
      files.push({ path: file, change: !before ? "add" : !after ? "delete" : "modify", additions: section.additions, deletions: section.deletions });
    }
    return { diff: sections.join(""), files };
  }
}

/**
 * Changes as the runtime reported them (file_change items), one git-style
 * section per path with each edit's hunks in order. The stand-in when no
 * manifest covers a scope: the counts are the items' own, so they match the
 * thread's "Changed n files" card exactly.
 */
export function fileChangesDiff(cwd: string, items: readonly TurnItem[]): { diff: string; files: FileChangeEntry[] } {
  const byPath = new Map<string, { entry: FileChangeEntry; hunks: string[] }>();
  for (const item of items) {
    if (item.kind !== "file_change" || item.status === "declined" || item.status === "failed") continue;
    for (const change of item.changes) {
      if (!change.path) continue;
      const rel = path.isAbsolute(change.path) ? path.relative(cwd, change.path) : change.path;
      const file = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : change.path;
      let slot = byPath.get(file);
      if (!slot) {
        slot = { entry: { path: file, change: change.change, additions: 0, deletions: 0 }, hunks: [] };
        if (change.previousPath) slot.entry.previousPath = change.previousPath;
        byPath.set(file, slot);
      } else if (change.change === "delete") slot.entry.change = "delete";
      slot.entry.additions = (slot.entry.additions ?? 0) + (change.additions ?? 0);
      slot.entry.deletions = (slot.entry.deletions ?? 0) + (change.deletions ?? 0);
      const at = change.diff?.search(/^@@/m) ?? -1;
      if (change.diff && at >= 0) slot.hunks.push(change.diff.slice(at).replace(/\n?$/, "\n"));
    }
  }
  const sections: string[] = [];
  for (const [file, { entry, hunks }] of byPath) {
    const head = [`diff --git a/${file} b/${file}`];
    if (entry.change === "add") head.push("new file mode 100644");
    if (entry.change === "delete") head.push("deleted file mode 100644");
    head.push(entry.change === "add" ? "--- /dev/null" : `--- a/${file}`, entry.change === "delete" ? "+++ /dev/null" : `+++ b/${file}`);
    sections.push(head.join("\n") + "\n" + hunks.join(""));
  }
  return { diff: sections.join(""), files: [...byPath.values()].map((s) => s.entry) };
}

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.h === b.h;
}

/** Paths whose content differs between two manifests, sorted. */
function changedPaths(a: Manifest, b: Manifest): string[] {
  const out: string[] = [];
  for (const file of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (!sameEntry(a.files[file], b.files[file])) out.push(file);
  }
  return out.sort();
}

function isBinary(content: Buffer): boolean {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isSymlink(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

function pruneEmptyDirs(dir: string, root: string): void {
  let d = dir;
  while (d.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(d).length > 0) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}
