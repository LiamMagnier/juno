// Whether an existing `.next` production build can be reused (run-prod-e2e.sh
// --reuse-build). A build is reusable only when every input that can reach
// `next build` is exactly what it was: committed files, uncommitted changes
// and untracked files alike. Paths that cannot reach the build (tests, e2e,
// native, docs, workflows, this harness) are left out, so editing a spec does
// not cost a rebuild.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Paths that cannot change what `next build` produces. */
export const OUTSIDE_THE_BUILD = [
  ".next",
  "e2e",
  "tests",
  "native",
  "docs",
  ".github",
  "artifacts",
  "scripts/qa",
  "playwright.config.ts",
  "test-results",
  "playwright-report",
];

/**
 * @param {string} root
 * @returns {{ head: string, tree: string, node: string } | null} null outside a git checkout
 */
export function buildFingerprint(root) {
  try {
    const spec = ["--", ".", ...OUTSIDE_THE_BUILD.map((p) => `:(exclude)${p}`)];
    const git = (args, input) => execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
    // ls-tree takes no pathspec magic, so the exclusions are applied here.
    const outside = (file) => OUTSIDE_THE_BUILD.some((p) => file === p || file.startsWith(`${p}/`));
    const committed = git(["ls-tree", "-r", "-z", "HEAD"])
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry && !outside(entry.slice(entry.indexOf("\t") + 1)))
      .join("\n");
    const changed = git(["diff", "HEAD", "--binary", ...spec]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", ...spec]).toString("utf8").trim();
    const untrackedHashes = untracked ? git(["hash-object", "--stdin-paths"], `${untracked}\n`) : Buffer.alloc(0);
    const tree = createHash("sha256").update(committed).update(changed).update(untracked).update(untrackedHashes).digest("hex");
    const head = git(["rev-parse", "HEAD"]).toString("utf8").trim();
    return { head, tree, node: process.version };
  } catch {
    return null;
  }
}

/** @param {string} root */
export function stampPath(root) {
  return path.join(root, ".next", "alevr-qa-build.json");
}

/**
 * @param {string} root
 * @param {{ tree: string, node: string } | null} fingerprint
 */
export function canReuseBuild(root, fingerprint) {
  if (!fingerprint) return false;
  if (!existsSync(path.join(root, ".next", "BUILD_ID")) || !existsSync(stampPath(root))) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath(root), "utf8"));
    return stamp.tree === fingerprint.tree && stamp.node === fingerprint.node;
  } catch {
    return false;
  }
}

/** @param {string} root @param {object} fingerprint */
export function writeStamp(root, fingerprint) {
  writeFileSync(stampPath(root), `${JSON.stringify(fingerprint, null, 2)}\n`);
}
