/**
 * Coding validator: the delivered project tree is copied to a scratch
 * directory, the HELD-OUT tests are copied in beside the visible ones, and
 * both run with a timeout. Visible tests must be byte-identical to the
 * fixture: weakening a test to make it pass is a failure, not a fix.
 *
 * Submitted code from any product is untrusted. The containment, and what
 * each layer covers:
 *
 *   1. Links refused. Before anything is read or copied, the delivered tree is
 *      walked with lstat. A symlink, FIFO, socket or device anywhere in it
 *      fails the check ("symlink in delivered project") and nothing runs.
 *      Node's permission model FOLLOWS symlinks, so a link inside the copy
 *      (project/leak.txt -> ~/.env.local) would otherwise be readable.
 *   2. Filesystem. The tests run under Node's permission model: reads only
 *      inside the scratch copy (which now holds regular files only), no
 *      writes, no child processes, no workers, no native addons.
 *   3. Network. The child runs in its own empty network namespace
 *      (`unshare -rn`: a user namespace plus a network namespace with only a
 *      loopback interface, which is down). Nothing can be sent anywhere, not
 *      even to a listener on the host's loopback. Where that isolation is not
 *      available (macOS, or Linux without unprivileged user namespaces) the
 *      check is `not_run` with the reason, and the code is not executed,
 *      unless the operator passes --unsafe-code (filesystem limits only; use a
 *      disposable machine).
 *   4. Resources. A 15 s timeout (SIGKILL, so a SIGTERM handler cannot keep it
 *      alive) and a 256 MB heap cap, so a runaway loop dies quickly on a shared
 *      machine.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import { SKIPPED_DIRS, containedFile, fail, linksAndSpecialFiles, notRun, pass, sha256 } from "./util";

type CodeSpec = Extract<ValidatorSpec, { kind: "code_tests" }>;

export const CODE_TIMEOUT_MS = 15_000;
export const CODE_HEAP_MB = 256;

export interface CodeContext {
  outputsDir: string;
  fixturesDir: string;
  hiddenDir: string;
  scratchDir: string;
  /**
   * The command prefix that puts the child in an empty network namespace.
   * Undefined = detect; null = none available (tests use this to exercise
   * the refusal path).
   */
  isolation?: string[] | null;
  /** Run without network isolation (operator's explicit --unsafe-code). */
  unsafeNoIsolation?: boolean;
}

let detected: string[] | null | undefined;

/**
 * `unshare -rn` when this machine can create an unprivileged user + network
 * namespace; null otherwise. Probed once per process.
 */
export function detectNetworkIsolation(): string[] | null {
  if (detected !== undefined) return detected;
  detected = null;
  if (process.platform === "linux") {
    const probe = spawnSync("unshare", ["-rn", "--", process.execPath, "-e", "0"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status === 0) detected = ["unshare", "-rn", "--"];
  }
  return detected;
}

function tapCounts(output: string): { tests: number; pass: number; fail: number } {
  const num = (name: string) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(output)?.[1] ?? 0);
  return { tests: num("tests"), pass: num("pass"), fail: num("fail") };
}

export function validateCodeTests(spec: CodeSpec, ctx: CodeContext): CheckResult[] {
  const id = (what: string) => `code:${spec.projectDir}:${what}`;
  let project: string;
  try {
    project = containedFile(ctx.outputsDir, spec.projectDir);
    const stat = lstatSync(project);
    if (stat.isSymbolicLink()) throw new Error("symlink in delivered project: the project directory itself is a link");
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    return [fail(id("project"), `delivered project missing or refused: ${(error as Error).message}`)];
  }
  const checks: CheckResult[] = [pass(id("project"), "project tree delivered")];
  // Before ANY read: a link in the tree would be followed by readFileSync
  // below, by the copy, and by the permission model in the child.
  const links = linksAndSpecialFiles(project);
  if (links.length) {
    return [...checks, fail(id("links"), `symlink in delivered project (refused; nothing was read or executed): ${links.slice(0, 6).join(", ")}${links.length > 6 ? ", …" : ""}`)];
  }
  checks.push(pass(id("links"), "no symlinks or special files"));
  const fixtureProject = path.join(ctx.fixturesDir, spec.fixtureProject);
  for (const file of spec.protectedFiles) {
    const original = path.join(fixtureProject, file);
    const delivered = path.join(project, file);
    if (!existsSync(delivered)) {
      checks.push(fail(id(`protected:${file}`), "deleted"));
    } else if (sha256(readFileSync(delivered)) !== sha256(readFileSync(original))) {
      checks.push(fail(id(`protected:${file}`), "modified — visible tests must not be weakened or rewritten"));
    } else {
      checks.push(pass(id(`protected:${file}`), "unchanged"));
    }
  }
  const hidden = path.join(ctx.hiddenDir, spec.hiddenTests);
  if (!existsSync(hidden)) return [...checks, fail(id("hidden-tests"), `held-out test file missing from the harness: ${spec.hiddenTests}`)];

  const isolation = ctx.isolation === undefined ? detectNetworkIsolation() : ctx.isolation;
  if (!isolation && !ctx.unsafeNoIsolation) {
    return [
      ...checks,
      notRun(
        id("tests"),
        "the delivered code was not executed: no network isolation here (needs `unshare -rn`, i.e. Linux with unprivileged user namespaces). " +
          "Run the benchmark on such a machine, or pass --unsafe-code to run it with filesystem limits only, on a disposable machine"
      ),
    ];
  }

  mkdirSync(ctx.scratchDir, { recursive: true });
  const work = mkdtempSync(path.join(ctx.scratchDir, "code-"));
  try {
    cpSync(project, work, { recursive: true, filter: (src) => !SKIPPED_DIRS.has(path.basename(src)) });
    const hiddenName = path.basename(spec.hiddenTests);
    cpSync(hidden, path.join(work, hiddenName));
    // The copy must hold regular files only (a link created between the scan
    // and the copy would otherwise reach the child).
    const late = linksAndSpecialFiles(work);
    if (late.length) return [...checks, fail(id("links"), `symlink appeared in the copy (refused): ${late.slice(0, 6).join(", ")}`)];
    const visible = spec.protectedFiles.filter((f) => /\.test\.m?js$|^test\.m?js$/.test(path.basename(f)));
    const nodeArgs = [
      `--max-old-space-size=${CODE_HEAP_MB}`,
      "--permission",
      `--allow-fs-read=${work}`,
      "--experimental-test-isolation=none",
      "--test",
      "--test-reporter=tap",
      hiddenName,
      ...visible,
    ];
    const [command, ...args] = isolation ? [...isolation, process.execPath, ...nodeArgs] : [process.execPath, ...nodeArgs];
    const timeoutMs = spec.timeoutMs ?? CODE_TIMEOUT_MS;
    const run = spawnSync(command, args, {
      cwd: work,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const counts = tapCounts(output);
    const where = isolation ? "network-isolated" : "UNSAFE: network NOT isolated (--unsafe-code)";
    const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (timedOut) {
      checks.push(fail(id("tests"), `test run did not finish within the ${Math.round(timeoutMs / 1000)}s limit (killed)`));
    } else if (run.status !== 0 && /JavaScript heap out of memory|Reached heap limit/i.test(output)) {
      checks.push(fail(id("tests"), `test run exceeded the ${CODE_HEAP_MB} MB heap cap (killed)`));
    } else if (run.error || run.signal) {
      checks.push(fail(id("tests"), `test run did not finish: ${run.error?.message ?? run.signal}`));
    } else if (counts.tests === 0) {
      checks.push(fail(id("tests"), `no tests ran: ${output.trim().split("\n").slice(-4).join(" / ").slice(0, 300)}`));
    } else if (run.status !== 0 || counts.fail > 0) {
      const failing = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).slice(0, 6);
      checks.push(fail(id("tests"), `${counts.fail}/${counts.tests} failing: ${failing.join("; ")}`));
    } else {
      checks.push(pass(id("tests"), `${counts.pass}/${counts.tests} held-out and visible tests pass (${where})`));
    }
    return checks;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
