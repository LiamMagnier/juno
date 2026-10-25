/**
 * Coding validator: the delivered project tree is copied to a scratch
 * directory, the HELD-OUT tests are copied in beside the visible ones, and
 * both run with a timeout. Visible tests must be byte-identical to the
 * fixture: weakening a test to make it pass is a failure, not a fix.
 *
 * Submitted code from any product is untrusted. What contains it:
 *
 *   1. Links refused. Before anything is read or copied, the delivered tree is
 *      walked with lstat. A symlink, FIFO, socket or device anywhere in it
 *      fails the check ("symlink in delivered project") and nothing runs.
 *   2. The sandbox (./sandbox.ts) is the security boundary. The tests run in
 *      their own user, mount, network and PID namespaces, chrooted into a
 *      fresh root that holds only the system directories (read-only), the
 *      node binary and the scratch copy (read-only). The host's home, repo,
 *      /tmp, /run and every Unix socket by path are not there; nothing on the
 *      host can be written; the network namespace has no usable interface, so
 *      nothing can be sent anywhere (TCP, UDP, abstract sockets, the host's
 *      loopback included); capabilities are dropped. Where the sandbox cannot
 *      be built (macOS, or Linux without unprivileged user namespaces) the
 *      check is `not_run` with the reason and the code is not executed,
 *      unless the operator passes --unsafe-code on a disposable machine.
 *   3. Node's permission model as well (reads only inside the copy, no
 *      writes, no child processes, workers or native addons) and node:sqlite
 *      switched off (--no-experimental-sqlite), because SQLite ignores the
 *      permission model. This is defence in depth, NOT a boundary: Node's own
 *      documentation says the permission model does not protect against
 *      malicious code. Under --unsafe-code it is the only layer left, which is
 *      why that mode is for disposable machines only.
 *   4. Resources. A 15 s timeout (SIGKILL; the sandbox's --kill-child takes
 *      the whole process tree with it) and a 256 MB heap cap, so a runaway
 *      loop dies quickly on a shared machine.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import { detectSandbox, nodeBinary, runSandboxed, type SandboxStatus } from "./sandbox";
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
   * Undefined = detect. false = behave as if no sandbox can be built (tests
   * use this to exercise the refusal path).
   */
  sandbox?: false;
  /** Run without the sandbox (operator's explicit --unsafe-code). */
  unsafeNoSandbox?: boolean;
}

/** node:sqlite ignores the permission model; switch it off where this node knows the flag. */
export function nodeHardeningFlags(): string[] {
  return process.allowedNodeEnvironmentFlags.has("--no-experimental-sqlite") ? ["--no-experimental-sqlite"] : [];
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

  const sandbox: SandboxStatus = ctx.sandbox === false ? { available: false, reason: "sandbox disabled for this run" } : detectSandbox();
  if (!sandbox.available && !ctx.unsafeNoSandbox) {
    return [
      ...checks,
      notRun(
        id("tests"),
        `the delivered code was not executed: no sandbox here (${sandbox.reason}). It needs Linux with unprivileged user namespaces and util-linux. ` +
          "Run the benchmark on such a machine, or pass --unsafe-code to run it unsandboxed on a disposable machine (Node's permission model alone is not a security boundary)"
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
      ...nodeHardeningFlags(),
      "--experimental-test-isolation=none",
      "--test",
      "--test-reporter=tap",
      hiddenName,
      ...visible,
    ];
    const timeoutMs = spec.timeoutMs ?? CODE_TIMEOUT_MS;
    const options = {
      encoding: "utf8" as const,
      timeout: timeoutMs,
      killSignal: "SIGKILL" as const,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    };
    const node = nodeBinary();
    const run = sandbox.available
      ? runSandboxed(node, nodeArgs, { readOnly: [work, node], cwd: work }, options)
      : spawnSync(node, nodeArgs, { ...options, cwd: work });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const counts = tapCounts(output);
    const where = sandbox.available ? "sandboxed: own filesystem view, no network" : "UNSAFE: not sandboxed (--unsafe-code)";
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
