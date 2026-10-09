/**
 * Hidden-ref git checkpoints (SPEC §3.8).
 *
 * After every turn the env server snapshots the working tree into a commit
 * that no branch points at: a temporary GIT_INDEX_FILE seeded from HEAD, `git
 * add -A` (so .gitignore is honoured and shell-made changes are captured too,
 * not only the agent's own edits), `write-tree`, `commit-tree`, `update-ref
 * refs/alevr/checkpoints/<thread>/turn/<n>`. The user's index, HEAD, branches
 * and stash are never touched.
 *
 * Rollback restores the working tree to a checkpoint and is itself undoable:
 * the current state is first saved under refs/alevr/checkpoints/<thread>/
 * pre-rollback/<time>. Only paths that differ are written or removed, through
 * a second temporary index, so untouched files keep their mtimes and the
 * user's staging area survives.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileChangeEntry } from "../contracts/code-v2.js";

export const CHECKPOINT_REF_ROOT = "refs/alevr/checkpoints";

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Alevr",
          GIT_AUTHOR_EMAIL: "checkpoints@alevr.local",
          GIT_COMMITTER_NAME: "Alevr",
          GIT_COMMITTER_EMAIL: "checkpoints@alevr.local",
          ...env,
        },
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function gitOk(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export function safeRefSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/\.{2,}/g, "-").replace(/^[.-]+/, "").slice(0, 100);
  if (!cleaned) throw new Error("empty ref segment");
  return cleaned;
}

export function checkpointRef(threadId: string, turn: number): string {
  return `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/turn/${turn}`;
}

export interface CheckpointInfo {
  ref: string;
  commit: string;
  turn: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export class GitCheckpoints {
  #rootCache = new Map<string, string | null>();

  /** Top level of the repository containing cwd, or null when cwd is not in a work tree. */
  async repoRoot(cwd: string): Promise<string | null> {
    if (this.#rootCache.has(cwd)) return this.#rootCache.get(cwd)!;
    const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = r.code === 0 ? r.stdout.trim() : null;
    this.#rootCache.set(cwd, root);
    return root;
  }

  /** Commit of the working tree as it is now, without touching the user's index. */
  async snapshot(cwd: string, message: string, parent?: string): Promise<string> {
    const root = await this.repoRoot(cwd);
    if (!root) throw new Error("not a git repository");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alevr-ckpt-"));
    const index = path.join(tmp, "index");
    try {
      const env = { GIT_INDEX_FILE: index };
      const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]);
      if (head.code === 0) await gitOk(root, ["read-tree", "HEAD"], env);
      await gitOk(root, ["add", "-A", "--", "."], env);
      const tree = (await gitOk(root, ["write-tree"], env)).trim();
      const args = ["commit-tree", tree, "-m", message];
      if (parent) args.splice(2, 0, "-p", parent);
      return (await gitOk(root, args, env)).trim();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Records checkpoint `turn` for a thread and returns what changed since the previous one. */
  async create(cwd: string, threadId: string, turn: number): Promise<CheckpointInfo | null> {
    const root = await this.repoRoot(cwd);
    if (!root) return null;
    const previous = turn > 0 ? await this.resolve(root, threadId, turn - 1) : undefined;
    const commit = await this.snapshot(root, `alevr checkpoint ${threadId} turn ${turn}`, previous);
    const ref = checkpointRef(threadId, turn);
    await gitOk(root, ["update-ref", ref, commit]);
    let stats = { filesChanged: 0, additions: 0, deletions: 0 };
    if (previous) stats = await this.stats(root, previous, commit);
    return { ref, commit, turn, ...stats };
  }

  async resolve(cwd: string, threadId: string, turn: number): Promise<string | undefined> {
    const r = await git(cwd, ["rev-parse", "--verify", "-q", `${checkpointRef(threadId, turn)}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** Turns that have a checkpoint, ascending. */
  async list(cwd: string, threadId: string): Promise<number[]> {
    const root = await this.repoRoot(cwd);
    if (!root) return [];
    const r = await git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/turn/`]);
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => Number(l.split("/").pop()))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  }

  async stats(cwd: string, from: string, to: string): Promise<{ filesChanged: number; additions: number; deletions: number }> {
    const r = await gitOk(cwd, ["diff", "--numstat", "--no-renames", from, to]);
    let files = 0;
    let add = 0;
    let del = 0;
    for (const line of r.split("\n")) {
      const [a, d] = line.split("\t");
      if (a === undefined || d === undefined) continue;
      files++;
      add += Number(a) || 0;
      del += Number(d) || 0;
    }
    return { filesChanged: files, additions: add, deletions: del };
  }

  /** Unified diff plus per-file entries between two commits (or a commit and the live working tree). */
  async diff(cwd: string, from: string, to: string | "worktree"): Promise<{ diff: string; files: FileChangeEntry[] }> {
    const root = await this.repoRoot(cwd);
    if (!root) throw new Error("not a git repository");
    const target = to === "worktree" ? await this.snapshot(root, "alevr diff snapshot") : to;
    const diff = await gitOk(root, ["diff", "--no-color", "--no-ext-diff", "-M", from, target]);
    const status = await gitOk(root, ["diff", "--name-status", "-M", from, target]);
    const numstat = await gitOk(root, ["diff", "--numstat", "-M", from, target]);
    const counts = new Map<string, { a: number; d: number }>();
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const file = parts[parts.length - 1];
      counts.set(file, { a: Number(parts[0]) || 0, d: Number(parts[1]) || 0 });
    }
    const files: FileChangeEntry[] = [];
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      const [code, a, b] = line.split("\t");
      const kind = code[0];
      const file = b ?? a;
      const entry: FileChangeEntry = {
        path: file,
        change: kind === "A" ? "add" : kind === "D" ? "delete" : kind === "R" ? "rename" : "modify",
      };
      if (kind === "R") entry.previousPath = a;
      const c = counts.get(file) ?? counts.get(`${a} => ${b}`);
      if (c) {
        entry.additions = c.a;
        entry.deletions = c.d;
      }
      files.push(entry);
    }
    return { diff, files };
  }

  /**
   * Restores the working tree to checkpoint `turn`. Returns the number of
   * paths written or removed, the ref holding the pre-rollback state, and the
   * paths a scope left alone.
   *
   * Without `scope` every path of the repository that differs is restored.
   * With it (what sessions use) only paths that are both inside
   * `scope.subtree` and were changed by this thread's own turns after `turn`
   * (the diffs between its consecutive checkpoints, up to `scope.latestTurn`,
   * plus `scope.paths`) are touched. A path that changed again after the
   * thread's latest checkpoint (another session, or the user) is skipped and
   * reported, never reverted.
   */
  async rollback(
    cwd: string,
    threadId: string,
    turn: number,
    scope?: RollbackScope,
  ): Promise<{ restoredFiles: number; undoRef: string; skipped: string[] }> {
    const root = await this.repoRoot(cwd);
    if (!root) throw new Error("not a git repository");
    const target = await this.resolve(root, threadId, turn);
    if (!target) throw new Error(`no checkpoint for turn ${turn}`);
    const current = await this.snapshot(root, `alevr pre-rollback ${threadId}`);
    const undoRef = `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/pre-rollback/${Date.now()}`;
    await gitOk(root, ["update-ref", undoRef, current]);
    const changed = (await gitOk(root, ["diff", "--name-status", "--no-renames", "-z", current, target])).split("\0").filter(Boolean);
    let allowed: ((file: string) => boolean) | undefined;
    const skipped: string[] = [];
    if (scope) {
      const prefix = await subtreePrefix(root, scope.subtree ?? cwd);
      const touched = new Set<string>((scope.paths ?? []).map(normalizeRepoPath).filter((p): p is string => !!p));
      const latest = scope.latestTurn ?? turn;
      let previous = target;
      for (let t = turn + 1; t <= latest; t++) {
        const commit = await this.resolve(root, threadId, t);
        if (!commit) continue;
        for (const file of (await gitOk(root, ["diff", "--name-only", "--no-renames", "-z", previous, commit])).split("\0").filter(Boolean)) touched.add(file);
        previous = commit;
      }
      // What the thread's latest checkpoint holds; anything different now was written by someone else since.
      const laterEdits = new Set<string>();
      if (latest > turn && previous !== target) {
        for (const file of (await gitOk(root, ["diff", "--name-only", "--no-renames", "-z", previous, current])).split("\0").filter(Boolean)) laterEdits.add(file);
      }
      allowed = (file) => {
        if (!inPrefix(file, prefix) || !touched.has(file)) return false;
        if (laterEdits.has(file)) {
          skipped.push(file);
          return false;
        }
        return true;
      };
    }
    const toWrite: string[] = [];
    const toDelete: string[] = [];
    for (let i = 0; i + 1 < changed.length; i += 2) {
      const code = changed[i];
      const file = changed[i + 1];
      if (allowed && !allowed(file)) continue;
      if (code === "A" || code === "M" || code === "T") toWrite.push(file);
      else if (code === "D") toDelete.push(file);
    }
    for (const file of toDelete) {
      const abs = path.join(root, file);
      if (!abs.startsWith(root + path.sep)) continue;
      fs.rmSync(abs, { force: true });
      pruneEmptyDirs(path.dirname(abs), root);
    }
    if (toWrite.length) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alevr-rb-"));
      try {
        const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
        await gitOk(root, ["read-tree", target], env);
        // checkout-index takes paths on stdin with -z --stdin; it writes files only, never the real index.
        const r = await git(root, ["checkout-index", "-f", "-z", "--stdin"], env, toWrite.join("\0") + "\0");
        if (r.code !== 0) throw new Error(`git checkout-index failed: ${r.stderr.trim()}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    return { restoredFiles: toWrite.length + toDelete.length, undoRef, skipped: skipped.sort() };
  }

  /**
   * Applies a unified diff to the working tree of the repository holding
   * `cwd`, all or nothing (`git apply`, never the index). Paths are relative
   * to the repository root and must stay inside `cwd`'s subtree: absolute
   * paths, `..`, `.git/` and anything outside the folder are refused before
   * git sees the patch, and git itself refuses to write through a symlink.
   */
  async applyPatch(cwd: string, patch: string, options: { reverse?: boolean; checkOnly?: boolean } = {}): Promise<{ applied: boolean; files: string[] }> {
    const root = await this.repoRoot(cwd);
    if (!root) throw new PatchError("unsupported", "Applying a change needs a git repository.");
    if (!patch.trim()) throw new PatchError("bad_request", "The patch is empty.");
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new PatchError("bad_request", "The patch is too large.");
    const text = patch.endsWith("\n") ? patch : `${patch}\n`;
    const flags = ["--recount", "--whitespace=nowarn", ...(options.reverse ? ["-R"] : [])];
    const prefix = await subtreePrefix(root, cwd);
    const files = patchPaths(text);
    // git's own reading of the patch must agree with ours (no path we did not see).
    const numstat = await git(root, ["apply", ...flags, "--numstat", "-z", "-"], {}, text);
    if (numstat.code !== 0) throw new PatchError("bad_request", `The patch could not be read: ${firstLine(numstat.stderr)}`);
    for (const file of numstatPaths(numstat.stdout)) files.add(file);
    if (files.size === 0) throw new PatchError("bad_request", "The patch names no file.");
    for (const file of files) {
      const clean = normalizeRepoPath(file);
      if (!clean || clean !== file) throw new PatchError("bad_request", `The patch names an unsafe path: ${file}`);
      if (clean === ".git" || clean.startsWith(".git/") || clean.split("/").includes(".git")) throw new PatchError("bad_request", "The patch may not touch .git.");
      if (!inPrefix(clean, prefix)) throw new PatchError("bad_request", `${clean} is outside this session's folder.`);
    }
    const check = await git(root, ["apply", ...flags, "--check", "-"], {}, text);
    if (check.code !== 0) throw new PatchError("conflict", `The change no longer applies: ${firstLine(check.stderr)}`);
    const list = [...files].sort();
    if (options.checkOnly) return { applied: false, files: list };
    const applied = await git(root, ["apply", ...flags, "-"], {}, text);
    if (applied.code !== 0) throw new PatchError("conflict", `The change could not be applied: ${firstLine(applied.stderr)}`);
    return { applied: true, files: list };
  }

  /** Deletes every checkpoint ref of a thread (session deleted). */
  async drop(cwd: string, threadId: string): Promise<void> {
    const root = await this.repoRoot(cwd);
    if (!root) return;
    const r = await git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/`]);
    for (const ref of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) await git(root, ["update-ref", "-d", ref]);
  }
}

export interface RollbackScope {
  /** Folder the session runs in; only paths under it are restored (default: the cwd passed in). */
  subtree?: string;
  /** The thread's newest turn; its checkpoints since `turn` say which paths the thread changed. */
  latestTurn?: number;
  /** Extra repository-relative paths the thread is known to have changed (its file_change items). */
  paths?: string[];
}

export class PatchError extends Error {
  constructor(
    readonly code: "bad_request" | "conflict" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.replace(/^error:\s*/, "").slice(0, 300) || "git refused it";
}

/** Repository-relative, forward-slash path with no `.`/`..` segments; undefined when it escapes or is absolute. */
export function normalizeRepoPath(file: string): string | undefined {
  if (!file || file.includes("\0") || path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return undefined;
  const parts: string[] = [];
  for (const part of file.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

/** The folder's path relative to the repository root ("" = the whole repository). */
async function subtreePrefix(root: string, folder: string): Promise<string> {
  let real = folder;
  let realRoot = root;
  try {
    real = fs.realpathSync(folder);
    realRoot = fs.realpathSync(root);
  } catch {
    /* compare as given */
  }
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PatchError("bad_request", "The session's folder is outside its repository.");
  return rel.split(path.sep).join("/");
}

function inPrefix(file: string, prefix: string): boolean {
  return prefix === "" || file === prefix || file.startsWith(`${prefix}/`);
}

/** Paths named in a unified diff's headers (`diff --git`, `---`, `+++`, rename/copy lines), without their a/ b/ prefix. */
export function patchPaths(patch: string): Set<string> {
  const out = new Set<string>();
  const take = (raw: string, strip: boolean) => {
    let value = raw.trim().replace(/\t.*$/, "");
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "/dev/null" || !value) return;
    if (strip) value = value.replace(/^[ab]\//, "");
    out.add(value);
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) take(line.slice(4), true);
    else if (line.startsWith("+++ ")) take(line.slice(4), true);
    else if (/^(rename|copy) (from|to) /.test(line)) take(line.replace(/^(rename|copy) (from|to) /, ""), false);
    else if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
      if (m) {
        out.add(m[1]);
        out.add(m[2]);
      }
    }
  }
  return out;
}

/** Paths from `git apply --numstat -z` ("adds\tdels\tpath\0", or "adds\tdels\t\0from\0to\0" for a rename). */
function numstatPaths(out: string): string[] {
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    if (!segment) continue;
    const fields = segment.split("\t");
    if (fields.length < 3) continue;
    if (fields[2] === "") {
      if (parts[i + 1]) files.push(parts[i + 1]);
      if (parts[i + 2]) files.push(parts[i + 2]);
      i += 2;
    } else files.push(fields.slice(2).join("\t"));
  }
  return files;
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
