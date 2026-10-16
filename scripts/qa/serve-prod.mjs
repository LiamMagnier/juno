#!/usr/bin/env node
// Builds and serves the production app for QA (spec §14, P0 (2) and (3)).
//
//   node scripts/qa/serve-prod.mjs
//
// playwright.config.ts starts this as its webServer: `next build`, then
// `next start` on 127.0.0.1 at E2E_PORT (or PORT, or a free port). Never
// `next dev`: visual and performance QA runs only on production builds.
//
// It re-checks the environment and re-applies the allowlist itself, because
// Playwright spreads its own process.env into the web server's environment
// whatever the config says. Its process group is recorded in
// $ALEVR_QA_RUN_DIR/server.pgid so the runner's teardown can stop it even if
// Playwright dies first.
//
// ALEVR_QA_REUSE_BUILD=1 (run-prod-e2e.sh --reuse-build) skips the build only
// when .next/alevr-qa-build.json matches the current HEAD and working tree
// exactly; anything else rebuilds.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSafeEnv, filterToAllowlist, readTestEnv } from "./lib/safe-env.mjs";
import { freePort, pgidOf } from "./lib/proc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const STAMP = path.join(ROOT, ".next", "alevr-qa-build.json");

function log(message) {
  console.error(`[qa:serve] ${message}`);
}

function treeFingerprint() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "-uall"], { cwd: ROOT });
    const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    const hash = createHash("sha256").update(status).update(diff).digest("hex");
    return { head, tree: hash, node: process.version };
  } catch {
    return null;
  }
}

function canReuseBuild(fingerprint) {
  if (process.env.ALEVR_QA_REUSE_BUILD !== "1" || !fingerprint) return false;
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID")) || !existsSync(STAMP)) return false;
  try {
    const stamp = JSON.parse(readFileSync(STAMP, "utf8"));
    return stamp.head === fingerprint.head && stamp.tree === fingerprint.tree && stamp.node === fingerprint.node;
  } catch {
    return false;
  }
}

function run(command, args, env, label) {
  log(`${label}...`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? result.signal}.`);
  log(`${label} took ${Math.round((Date.now() - started) / 1000)}s.`);
}

async function main() {
  const safety = checkSafeEnv({ env: process.env, dirs: [ROOT, process.cwd()], root: ROOT });
  if (!safety.ok) {
    for (const error of safety.errors) log(`refusing: ${error}`);
    process.exit(2);
  }
  const testEnv = readTestEnv(ROOT);
  const env = filterToAllowlist(process.env, testEnv);
  env.NODE_ENV = "production";
  const port = String(process.env.E2E_PORT || process.env.PORT || (await freePort()));
  env.PORT = port;

  const runDir = process.env.ALEVR_QA_RUN_DIR;
  if (runDir) {
    const pgid = pgidOf(process.pid);
    if (pgid) writeFileSync(path.join(runDir, "server.pgid"), `${pgid}\n`);
  }

  let child = null;
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}; stopping next start.`);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      process.exit(0);
    }, 8_000).unref();
    if (!child || child.exitCode !== null) process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const fingerprint = treeFingerprint();
  if (canReuseBuild(fingerprint)) {
    log(`reusing the production build for ${fingerprint?.head.slice(0, 9)} (tree unchanged).`);
  } else {
    // The same steps as `npm run build` minus `prisma generate`: the client in
    // node_modules is the caller's (worktrees share it), so a schema change
    // needs `npx prisma generate` before the run.
    run(process.execPath, [path.join(ROOT, "scripts", "generate-i18n-catalog.mjs")], env, "i18n catalog");
    const buildEnv = { ...env, NODE_OPTIONS: "--max-old-space-size=8192" };
    run(path.join(BIN, "next"), ["build"], buildEnv, "next build");
    if (fingerprint) writeFileSync(STAMP, `${JSON.stringify(fingerprint, null, 2)}\n`);
  }
  if (stopping) return;

  const startEnv = { ...env, NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}` };
  log(`next start on http://127.0.0.1:${port}`);
  child = spawn(path.join(BIN, "next"), ["start", "-H", "127.0.0.1", "-p", port], { cwd: ROOT, env: startEnv, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!stopping) log(`next start exited (${code ?? signal}).`);
    process.exit(stopping ? 0 : code ?? 1);
  });
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
