/**
 * The remote lane (docs/code-v2/REMOTE-CONTROL.md): what a paired phone or
 * browser needs beyond driving a session.
 *
 * - `fs.list`: the folders under a path, for the new-session folder browser.
 * - `git.status` / `git.commit` / `git.push` / `git.pr`: ship what a session
 *   did, in that session's own folder.
 *
 * The env server answers these for any client that holds its launch token;
 * which folders a REMOTE client may name is the Mac app's decision
 * (EnvServerDeviceLink: inside the folders shared with paired devices, and
 * git only on sessions the link opened). Commits are made as the user (their
 * own git identity), never as the checkpoint author.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FsEntry, GitFileStatus, GitStatusResult } from "../contracts/code-v2.js";
import { WireError } from "../sessions/session-manager.js";

export const FS_LIST_LIMIT = 500;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a tool with no prompt (a push that needs a password fails rather than hangs). */
export function run(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_ASKPASS: "", SSH_ASKPASS: "" },
        maxBuffer: OUTPUT_LIMIT,
        timeout: timeoutMs,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: unknown }) | null;
        const code = err ? (typeof err.code === "number" ? err.code : 127) : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? ""), code });
      },
    );
  });
}

const firstLine = (r: Run): string => (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 400);

/** The folders (and with `files`, the files) directly inside `dir`, folders first. */
export async function listFolder(dir: string, opts: { files?: boolean; showHidden?: boolean } = {}): Promise<{ path: string; parent?: string; entries: FsEntry[] }> {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new WireError("bad_request", "path must be an absolute path.");
  const resolved = path.resolve(dir);
  let names: import("node:fs").Dirent[];
  try {
    names = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new WireError("not_found", "That folder does not exist.");
    if (code === "ENOTDIR") throw new WireError("bad_request", "That is a file, not a folder.");
    if (code === "EACCES" || code === "EPERM") throw new WireError("bad_request", "Alevr cannot read that folder.");
    throw error;
  }
  const entries: FsEntry[] = [];
  for (const entry of names) {
    if (!opts.showHidden && entry.name.startsWith(".")) continue;
    const full = path.join(resolved, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      isDir = stat.isDirectory();
    }
    if (!isDir && !opts.files) continue;
    if (isDir) {
      const isRepo = await fs
        .stat(path.join(full, ".git"))
        .then(() => true)
        .catch(() => false);
      entries.push({ name: entry.name, path: full, kind: "dir", ...(isRepo ? { isRepo: true } : {}) });
    } else {
      entries.push({ name: entry.name, path: full, kind: "file" });
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  const parent = path.dirname(resolved);
  return { path: resolved, ...(parent !== resolved ? { parent } : {}), entries: entries.slice(0, FS_LIST_LIMIT) };
}

/** Parses `git status --porcelain=v1 --branch -z`. */
export function parsePorcelain(raw: string): { branch?: string; upstream?: string; ahead: number; behind: number; files: GitFileStatus[] } {
  const parts = raw.split("\0").filter((p) => p.length > 0);
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("## ")) {
      let header = part.slice(3).replace(/^(No commits yet on |Initial commit on )/, "");
      let tracking = "";
      const bracket = header.indexOf(" [");
      if (bracket >= 0) {
        tracking = header.slice(bracket + 2, header.endsWith("]") ? -1 : undefined);
        header = header.slice(0, bracket);
      }
      const [local, remote] = header.split("...");
      branch = local && !local.startsWith("HEAD") ? local : undefined;
      upstream = remote || undefined;
      const a = /ahead (\d+)/.exec(tracking);
      const b = /behind (\d+)/.exec(tracking);
      ahead = a ? Number(a[1]) : 0;
      behind = b ? Number(b[1]) : 0;
      continue;
    }
    const status = part.slice(0, 2);
    const file = part.slice(3);
    files.push({ path: file, status });
    // A rename or copy is followed by its source path.
    if (status[0] === "R" || status[0] === "C") i++;
  }
  return { branch, upstream, ahead, behind, files };
}

/** `git@github.com:o/r.git` and `https://github.com/o/r(.git)` → `https://github.com/o/r`. */
export function remoteWebUrl(remote: string): string | undefined {
  const r = remote.trim();
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(r);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(r);
  if (https) return `https://${https[1]}/${https[2]}`;
  return undefined;
}

export async function gitStatus(cwd: string, opts: { probeGh?: boolean } = {}): Promise<GitStatusResult> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd, 15_000);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { ahead: 0, behind: 0, files: [], isRepo: false, canOpenPr: false };
  const status = await run("git", ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], cwd, 30_000);
  if (status.code !== 0) throw new WireError("internal", `git status failed: ${firstLine(status)}`);
  const parsed = parsePorcelain(status.stdout);
  const origin = await run("git", ["remote", "get-url", "origin"], cwd, 15_000);
  const remoteUrl = origin.code === 0 ? remoteWebUrl(origin.stdout) : undefined;
  let canOpenPr = false;
  if (opts.probeGh !== false && remoteUrl) {
    const gh = await run("gh", ["auth", "status"], cwd, 15_000);
    canOpenPr = gh.code === 0;
  }
  return { ...parsed, isRepo: true, canOpenPr, ...(remoteUrl ? { remoteUrl } : {}) };
}

export async function gitCommit(cwd: string, message: string): Promise<{ sha: string; summary: string }> {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new WireError("bad_request", "A commit message is required.");
  if (text.length > 10_000) throw new WireError("bad_request", "That commit message is too long.");
  const add = await run("git", ["add", "-A"], cwd);
  if (add.code !== 0) throw new WireError("internal", `git add failed: ${firstLine(add)}`);
  const staged = await run("git", ["diff", "--cached", "--quiet"], cwd);
  if (staged.code === 0) throw new WireError("conflict", "There is nothing to commit.");
  const commit = await run("git", ["commit", "--no-verify", "-m", text], cwd);
  if (commit.code !== 0) throw new WireError("internal", `git commit failed: ${firstLine(commit)}`);
  const sha = (await run("git", ["rev-parse", "HEAD"], cwd)).stdout.trim();
  const summary = (await run("git", ["log", "-1", "--format=%s"], cwd)).stdout.trim();
  return { sha, summary };
}

export async function gitPush(cwd: string): Promise<{ branch: string; remote: string }> {
  const head = await run("git", ["symbolic-ref", "--short", "HEAD"], cwd);
  if (head.code !== 0) throw new WireError("conflict", "This folder is not on a branch, so there is nothing to push.");
  const branch = head.stdout.trim();
  const upstream = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  const push =
    upstream.code === 0 ? await run("git", ["push"], cwd, 300_000) : await run("git", ["push", "--set-upstream", "origin", branch], cwd, 300_000);
  if (push.code !== 0) throw new WireError("internal", `git push failed: ${firstLine(push)}`);
  const remote = upstream.code === 0 ? upstream.stdout.trim().split("/")[0] : "origin";
  return { branch, remote };
}

export async function gitPullRequest(
  cwd: string,
  params: { title: string; body?: string; draft?: boolean; base?: string },
): Promise<{ url: string }> {
  const title = typeof params.title === "string" ? params.title.trim() : "";
  if (!title) throw new WireError("bad_request", "A pull request needs a title.");
  const args = ["pr", "create", "--title", title, "--body", params.body ?? ""];
  if (params.draft) args.push("--draft");
  if (params.base) args.push("--base", params.base);
  const pr = await run("gh", args, cwd, 120_000);
  if (pr.code === 127 && /ENOENT|not found/i.test(pr.stderr)) {
    throw new WireError("unsupported", "Install the GitHub CLI (gh) on your Mac and sign in to open pull requests.");
  }
  if (pr.code !== 0) throw new WireError("internal", `Could not open the pull request: ${firstLine(pr)}`);
  const url = /https?:\/\/\S+/.exec(pr.stdout)?.[0];
  if (!url) throw new WireError("internal", "The GitHub CLI did not return the pull request's address.");
  return { url };
}
