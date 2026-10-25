/**
 * Coding validator: the delivered project tree is copied to a scratch
 * directory, the HELD-OUT tests (never shown to the executor) are copied in
 * beside the visible ones, and both run under Node's permission model — file
 * reads limited to the scratch copy, no writes, no child processes — with a
 * timeout. Visible tests must be byte-identical to the fixture: weakening a
 * test to make it pass is a failure, not a fix.
 *
 * Submitted code from any product is untrusted; the permission model and the
 * timeout are the containment. Run competitor imports on a disposable machine
 * if that is not enough for you.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import { containedFile, fail, pass, sha256 } from "./util";

type CodeSpec = Extract<ValidatorSpec, { kind: "code_tests" }>;

export interface CodeContext {
  outputsDir: string;
  fixturesDir: string;
  hiddenDir: string;
  scratchDir: string;
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
    if (!statSync(project).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    return [fail(id("project"), `delivered project missing: ${(error as Error).message}`)];
  }
  const checks: CheckResult[] = [pass(id("project"), "project tree delivered")];
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

  mkdirSync(ctx.scratchDir, { recursive: true });
  const work = mkdtempSync(path.join(ctx.scratchDir, "code-"));
  try {
    cpSync(project, work, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.git`) });
    const hiddenName = path.basename(spec.hiddenTests);
    cpSync(hidden, path.join(work, hiddenName));
    const visible = spec.protectedFiles.filter((f) => /\.test\.m?js$|^test\.m?js$/.test(path.basename(f)));
    const run = spawnSync(
      process.execPath,
      ["--permission", `--allow-fs-read=${work}`, "--experimental-test-isolation=none", "--test", "--test-reporter=tap", hiddenName, ...visible],
      { cwd: work, encoding: "utf8", timeout: spec.timeoutMs ?? 60_000, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } }
    );
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const counts = tapCounts(output);
    if (run.error || run.signal) {
      checks.push(fail(id("tests"), `test run did not finish: ${run.error?.message ?? run.signal}`));
    } else if (counts.tests === 0) {
      checks.push(fail(id("tests"), `no tests ran: ${output.trim().split("\n").slice(-4).join(" / ").slice(0, 300)}`));
    } else if (run.status !== 0 || counts.fail > 0) {
      const failing = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).slice(0, 6);
      checks.push(fail(id("tests"), `${counts.fail}/${counts.tests} failing: ${failing.join("; ")}`));
    } else {
      checks.push(pass(id("tests"), `${counts.pass}/${counts.tests} held-out and visible tests pass`));
    }
    return checks;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
