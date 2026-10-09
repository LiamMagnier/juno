/**
 * Find a vendor CLI the way the user's own shell would — PATH first, then the
 * places installers put binaries when PATH is not inherited (a Mac app started
 * from Finder sees launchd's minimal PATH, not the user's zsh one).
 *
 * Detection only stats files; the one thing it ever runs is `<binary>
 * --version` with a 4 s deadline, a 4 KiB output cap and no shell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function candidateDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".alevr", "runtimes", "bin"),
    path.join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  // nvm: newest node version first.
  const nvm = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = fs
      .readdirSync(nvm)
      .filter((v) => /^v\d/.test(v))
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
    for (const v of versions) extra.push(path.join(nvm, v, "bin"));
  } catch {
    /* no nvm */
  }
  const seen = new Set<string>();
  return [...fromPath, ...extra].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/** Absolute path of the first executable named `name`, or undefined. An absolute `name` is checked as-is. */
export function findBinary(name: string, dirs = candidateDirs()): string | undefined {
  if (path.isAbsolute(name)) return isExecutable(name) ? name : undefined;
  if (name.includes("/") || name.includes("\\")) return undefined;
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH for spawned vendor processes: the user's dirs plus the binary's own dir (node shims need their node). */
export function spawnPath(binaryPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dirs = candidateDirs(env);
  if (binaryPath) dirs.unshift(path.dirname(binaryPath));
  return [...new Set(dirs)].join(path.delimiter);
}

export async function readVersion(binaryPath: string, args: string[] = ["--version"], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...process.env, PATH: spawnPath(binaryPath), NO_COLOR: "1" },
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    const take = (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString("utf8").slice(0, 4096 - out.length);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 || out.trim() ? parseVersion(out) : undefined));
  });
}

/** "2.1.14 (Claude Code)" → "2.1.14"; "codex-cli 0.160.0" → "0.160.0". */
export function parseVersion(text: string): string | undefined {
  const match = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : text.trim().split("\n")[0]?.slice(0, 64) || undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Expands a leading "~/" — env vars handed to spawn are not shell-expanded. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** POSIX single-quote for text typed into a terminal (setup steps). */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
