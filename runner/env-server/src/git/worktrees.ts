/**
 * Optional worktree per thread (SPEC §3.9). A session opened with
 * `worktree: true` runs in `<dataDir>/worktrees/<repo>-<session>` on branch
 * `alevr/<session>`, created from the repository's current HEAD. If the
 * repository has an executable `.alevr/worktree-setup` it runs once in the new
 * worktree (install dependencies, copy .env.example …); its output becomes a
 * notice, and a failing setup never blocks the session.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorktreeInfo } from "../contracts/code-v2.js";
import { git, safeRefSegment } from "./checkpoints.js";

export async function createWorktree(repoCwd: string, sessionId: string, dataDir: string): Promise<WorktreeInfo> {
  const top = await git(repoCwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("A worktree needs a git repository.");
  const repoRoot = top.stdout.trim();
  const branch = `alevr/${safeRefSegment(sessionId)}`;
  const dir = path.join(dataDir, "worktrees", `${safeRefSegment(path.basename(repoRoot))}-${safeRefSegment(sessionId)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const head = await git(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) throw new Error("The repository has no commits yet, so there is nothing to branch a worktree from.");
  const r = await git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  return { path: dir, branch, repoRoot };
}

export async function removeWorktree(info: WorktreeInfo, deleteBranch = false): Promise<void> {
  await git(info.repoRoot, ["worktree", "remove", "--force", info.path]);
  if (deleteBranch) await git(info.repoRoot, ["branch", "-D", info.branch]);
}

/** Runs `.alevr/worktree-setup` when present and executable. Resolves with its (bounded) output. */
export function runWorktreeSetup(worktree: string, timeoutMs = 10 * 60_000): Promise<{ ran: boolean; ok: boolean; output: string }> {
  const script = path.join(worktree, ".alevr", "worktree-setup");
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    return Promise.resolve({ ran: false, ok: true, output: "" });
  }
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(script, [], { cwd: worktree, shell: false, env: scriptEnv() });
    const take = (b: Buffer) => {
      output = (output + b.toString("utf8")).slice(-16_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ran: true, ok: false, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ran: true, ok: code === 0, output });
    });
  });
}

/** The user's environment minus anything Alevr set for itself (a repo script is not trusted with it). */
export function scriptEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ALEVR_") || k.startsWith("JUNO_")) continue;
    env[k] = v;
  }
  return env;
}
