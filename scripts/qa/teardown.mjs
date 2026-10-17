#!/usr/bin/env node
// The QA runner's teardown and ps check (spec §14, P0 (2)).
//
//   node scripts/qa/teardown.mjs --root-pid <runner pid> --run-dir <dir> [--grace-ms 10000]
//                                [--kill-only | --check-only]
//
// 1. Sends SIGTERM to every process group recorded in <dir>/*.pgid, waits up to
//    the grace period, then SIGKILLs whatever is left of them.
// 2. Lists every process and fails (exit 1) if any node, next or postgres
//    process from the run survives: a descendant of the runner, or a member of
//    a recorded group. The check excludes itself.
//
// `--kill-only` runs step 1 alone and `--check-only` step 2 alone, so the runner
// can drop the database between them and check last.

import { setTimeout as sleep } from "node:timers/promises";
import { findLeftovers, listProcesses, readRecordedPgids } from "./lib/proc.mjs";

function parseArgs(argv) {
  const args = { rootPid: 0, runDir: "", graceMs: 10_000, checkOnly: false, killOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root-pid") args.rootPid = Number(argv[++i]);
    else if (arg === "--run-dir") args.runDir = argv[++i] ?? "";
    else if (arg === "--grace-ms") args.graceMs = Number(argv[++i]);
    else if (arg === "--check-only") args.checkOnly = true;
    else if (arg === "--kill-only") args.killOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.rootPid) || args.rootPid <= 1) throw new Error("--root-pid is required.");
  return args;
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Never signal our own group (the runner's), whatever a pgid file claims.
  const ownGroup = Number(process.env.ALEVR_QA_RUNNER_PGID || 0);
  const pgids = readRecordedPgids(args.runDir).filter((g) => g !== ownGroup);

  if (!args.checkOnly && pgids.length) {
    const live = pgids.filter(groupAlive);
    for (const pgid of live) signalGroup(pgid, "SIGTERM");
    const deadline = Date.now() + args.graceMs;
    while (Date.now() < deadline && live.some(groupAlive)) await sleep(200);
    const stubborn = live.filter(groupAlive);
    for (const pgid of stubborn) {
      console.error(`[qa:teardown] Process group ${pgid} ignored SIGTERM for ${args.graceMs}ms; sending SIGKILL.`);
      signalGroup(pgid, "SIGKILL");
    }
    if (stubborn.length) await sleep(300);
    if (live.length) console.error(`[qa:teardown] Stopped process groups: ${live.join(", ")}.`);
  }

  if (args.killOnly) return 0;

  // Processes exit asynchronously after a signal; give stragglers a moment
  // before calling them leftovers.
  let leftovers = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    leftovers = findLeftovers({ procs: listProcesses(), rootPid: args.rootPid, pgids, excludePids: [process.pid] });
    if (leftovers.length === 0) break;
    await sleep(300);
  }
  if (leftovers.length) {
    console.error("[qa:teardown] FAIL: processes from this run are still alive:");
    for (const p of leftovers) console.error(`[qa:teardown]   pid ${p.pid} (group ${p.pgid}): ${p.command}`);
    return 1;
  }
  console.error("[qa:teardown] ps check: no node, next or postgres process from this run is left.");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`[qa:teardown] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
