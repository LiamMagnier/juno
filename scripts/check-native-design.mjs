import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

/*
 * All four native design gates, in one run, reporting all four outcomes.
 *
 * Deliberately NOT `a && b && c && d` in package.json. Chaining stops at the
 * first failure, so a PR that regresses type AND targets is told about type,
 * fixed, re-run, and told about targets — two round trips for one review. These
 * are cheap source scans; run them all and print everything.
 *
 * Arguments pass straight through, so `--baseline` re-records all four and
 * `--list` prints every violation each of them can see.
 */

const GATES = ["type", "motion", "glass", "targets"];

const results = [];
for (const rule of GATES) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // Resolved against this file rather than the cwd, so the runner still
      // finds its four gates when it is invoked from somewhere other than the
      // repo root. The gates themselves stay cwd-relative — that is what lets
      // them be pointed at a fixture tree.
      [path.join(import.meta.dirname, `check-native-${rule}.mjs`), ...process.argv.slice(2)],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  results.push({ rule, code });
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  console.error(
    `\n  ✗ [native-design] ${failed.length} of ${GATES.length} gate(s) failed: `
      + `${failed.map((result) => result.rule).join(", ")}\n`
      + `    Each ratchets — it fails only when its violation count RISES — so this is\n`
      + `    about something in this change, not about the tree's existing debt.\n`,
  );
  process.exit(1);
}

console.log(`[native-design] all ${GATES.length} gates hold: type, motion, glass, targets.`);
