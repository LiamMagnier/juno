// Process bookkeeping for the QA runner's teardown (spec §14: "Nothing is left
// running locally").
//
// The runner records every process group it starts (Playwright's, the web
// server's) in its run directory. Teardown kills those groups, and then this
// module's ps check fails the run if any node, next or postgres process that
// belongs to the run is still alive: a descendant of the runner, or a member of
// one of its recorded groups (which catches a server that was re-parented to
// launchd after its parent died).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** Commands the ps check treats as leftovers of a run. */
export const LEFTOVER_COMMAND = /(^|[\s/])(node|next|next-server|next-router-worker|postgres)(\s|$|:|\()/i;

/**
 * @typedef {{ pid: number, ppid: number, pgid: number, command: string }} Proc
 */

/** @param {string} text `ps -axo pid=,ppid=,pgid=,command=` output */
export function parsePs(text) {
  /** @type {Proc[]} */
  const procs = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    procs.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
  }
  return procs;
}

export function listProcesses() {
  return parsePs(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }));
}

/**
 * @param {number} root
 * @param {Proc[]} procs
 * @returns {Set<number>} every pid below `root` (not including it)
 */
export function descendantsOf(root, procs) {
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    if (out.has(pid)) continue;
    out.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * The run's leftover processes.
 * @param {{ procs: Proc[], rootPid: number, pgids: number[], excludePids?: number[] }} input
 * @returns {Proc[]}
 */
export function findLeftovers({ procs, rootPid, pgids, excludePids = [] }) {
  const exclude = new Set(excludePids);
  for (const pid of excludePids) for (const d of descendantsOf(pid, procs)) exclude.add(d);
  const ours = descendantsOf(rootPid, procs);
  const groups = new Set(pgids.filter((g) => Number.isInteger(g) && g > 1));
  return procs.filter(
    (p) =>
      !exclude.has(p.pid) &&
      p.pid !== rootPid &&
      (ours.has(p.pid) || groups.has(p.pgid)) &&
      LEFTOVER_COMMAND.test(p.command)
  );
}

/** @param {string} runDir @returns {number[]} recorded process groups */
export function readRecordedPgids(runDir) {
  if (!runDir || !existsSync(runDir)) return [];
  const out = [];
  for (const name of readdirSync(runDir)) {
    if (!name.endsWith(".pgid")) continue;
    for (const token of readFileSync(path.join(runDir, name), "utf8").split(/\s+/)) {
      const n = Number(token);
      if (Number.isInteger(n) && n > 1) out.push(n);
    }
  }
  return [...new Set(out)];
}

/** @param {number} pid @returns {number | null} */
export function pgidOf(pid) {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
