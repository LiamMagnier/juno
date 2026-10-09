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

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<GitResult> {
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

async function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
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
   * paths written or removed and the ref holding the pre-rollback state.
   */
  async rollback(cwd: string, threadId: string, turn: number): Promise<{ restoredFiles: number; undoRef: string }> {
    const root = await this.repoRoot(cwd);
    if (!root) throw new Error("not a git repository");
    const target = await this.resolve(root, threadId, turn);
    if (!target) throw new Error(`no checkpoint for turn ${turn}`);
    const current = await this.snapshot(root, `alevr pre-rollback ${threadId}`);
    const undoRef = `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/pre-rollback/${Date.now()}`;
    await gitOk(root, ["update-ref", undoRef, current]);
    const changed = (await gitOk(root, ["diff", "--name-status", "--no-renames", "-z", current, target])).split("\0").filter(Boolean);
    const toWrite: string[] = [];
    const toDelete: string[] = [];
    for (let i = 0; i + 1 < changed.length; i += 2) {
      const code = changed[i];
      const file = changed[i + 1];
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
    return { restoredFiles: toWrite.length + toDelete.length, undoRef };
  }

  /** Deletes every checkpoint ref of a thread (session deleted). */
  async drop(cwd: string, threadId: string): Promise<void> {
    const root = await this.repoRoot(cwd);
    if (!root) return;
    const r = await git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_ROOT}/${safeRefSegment(threadId)}/`]);
    for (const ref of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) await git(root, ["update-ref", "-d", ref]);
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
