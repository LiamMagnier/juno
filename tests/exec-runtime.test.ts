import test from "node:test";
import assert from "node:assert/strict";

/*
 * The pure parts of the hosted execution runtime (src/lib/exec), without a
 * database or an execution host: what the model reads back, argument
 * validation, the identifiers the host sees, the contract mapping, the skill
 * mounts, the attach decision, the tool specs and the broker rules. The live
 * paths are covered by tests/exec-runtime.integration.test.ts and
 * tests/exec-chat-route.integration.test.ts (opt-in, real host and Postgres).
 */

import {
  formatStream,
  installedPackagesLine,
  missingModule,
  moduleHint,
  outcomeText,
  runSummary,
  statusLine,
} from "@/lib/exec/format";
import { parseCheckRunArgs, parseRunCodeArgs } from "@/lib/exec/args";
import { hostAccountId, hostIdempotencyKey, hostSessionId, runArgsDigest } from "@/lib/exec/ids";
import { toToolOutcome, toToolProgress } from "@/lib/exec/contract";
import { clearSkillMounts, mountSkill, skillMountsFor } from "@/lib/exec/mounts";
import { execEntitlement, surfaceLimits } from "@/lib/exec/config";
import { imageDimensions } from "@/lib/exec/image-size";
import { runCodeSpec, RUN_CODE_TIMEOUT_MS } from "@/lib/tools/specs/run-code";
import { checkRunSpec } from "@/lib/tools/specs/check-run";
import { execToolProvider } from "@/lib/exec/provider";
import { classifyExternalAction } from "@/lib/action-approval";
import { portableSchemaProblem, TOOL_PROGRESS_MAX_LINES } from "@/lib/tools/types";
import type { ExecRunFacts, ToolRunStatus } from "@/lib/exec/types";

const page = (offset: number) => `call check_run with offset ${offset}`;

test("a short stream is shown whole; a long one as head, tail and how to page the rest", () => {
  assert.equal(formatStream("stdout", { head: "42\n", tail: "", bytes: 3 }, page), "stdout:\n42");
  assert.equal(formatStream("stderr", { head: "", tail: "", bytes: 0 }, page), "");
  const head = "h".repeat(8192);
  const tail = "t".repeat(8192);
  const long = formatStream("stdout", { head, tail, bytes: 5_000_000, storedBytes: 5_000_000 }, page);
  assert.match(long, /stdout \(4\.8 MB in total; the start and the end are shown\):/);
  assert.match(long, /omitted here/);
  assert.match(long, /call check_run with offset 8192/);
  assert.ok(long.startsWith("stdout (") && long.endsWith("t"));
  const lost = formatStream("stdout", { head, tail, bytes: 20_000_000, storedBytes: 16 * 1024 * 1024 }, page);
  assert.match(lost, /that part is gone/);
});

test("the status line never presents a failed, stopped, unknown or running run as one that worked", () => {
  const statuses: ToolRunStatus[] = ["failed", "timed_out", "cancelled", "outcome_unknown", "refused", "running", "queued"];
  for (const status of statuses) {
    const line = statusLine({ status, language: "python", exitCode: status === "failed" ? 1 : null, durationMs: 1200, finishedLate: false });
    assert.doesNotMatch(line, /^Ran /, status);
  }
  assert.match(statusLine({ status: "failed", language: "python", exitCode: 1, durationMs: 1200 }), /FAILED: exit code 1/);
  assert.match(statusLine({ status: "succeeded", language: "javascript", exitCode: 0, durationMs: 400 }), /^Ran JavaScript \(Node\): exit code 0, 400 ms\./);
  assert.match(statusLine({ status: "succeeded", language: "bash", exitCode: 0, durationMs: 1500, finishedLate: true }), /finished after the turn/);
  assert.match(statusLine({ status: "outcome_unknown", language: "python", exitCode: null, durationMs: null }), /Do not say it succeeded; it was not run again/);
});

test("a missing module names what is installed and that nothing can be installed", () => {
  const stderr = "Traceback (most recent call last):\n  File \"/juno/program/main.py\", line 1\nModuleNotFoundError: No module named 'polars'\n";
  assert.equal(missingModule(stderr), "polars");
  assert.equal(missingModule("Error: Cannot find module 'lodash'"), "lodash");
  assert.equal(missingModule("ValueError: nope"), null);
  const hint = moduleHint(stderr, [{ name: "pandas", version: "2.2.3" }, { name: "six", version: "1.17.0" }, { name: "numpy", version: "2.1.3" }]);
  assert.match(hint, /"polars" is not installed\. This sandbox has no internet, so packages cannot be installed\./);
  assert.match(hint, /Installed Python packages: pandas 2\.2\.3, numpy 2\.1\.3\./);
  assert.doesNotMatch(installedPackagesLine([{ name: "pandas", version: "2" }, { name: "six", version: "1" }]), /six/);
});

test("the outcome text states the context, the files and the next step", () => {
  const base = {
    language: "python" as const,
    surface: "chat" as const,
    toolRunId: "ckrun123456",
    durationMs: 2400,
    stdout: { head: "{\"East\": 60.0}\n", tail: "", bytes: 15 },
    stderr: { head: "", tail: "", bytes: 0 },
    skippedFiles: [{ name: "big.bin", bytes: 30_000_000, reason: "larger than 25 MB" }],
    imagesAttached: 1,
    checkRunAvailable: true,
  };
  const ok = outcomeText({ ...base, status: "succeeded", exitCode: 0, files: [{ attachmentId: "a1", name: "chart.png", mime: "image/png", bytes: 10240, kind: "IMAGE" }] });
  assert.match(ok, /Ran Python: exit code 0, 2\.4 s\./);
  assert.match(ok, /no internet access and no access to the user's computer/);
  assert.match(ok, /Files produced, attached to this conversation .*chart\.png \(image\/png, 10 KB\)/);
  assert.match(ok, /Files not kept: big\.bin \(larger than 25 MB\)/);
  assert.match(ok, /\[1 image from this run follows\.\]/);
  const running = outcomeText({ ...base, status: "running", exitCode: null, files: [], imagesAttached: 0 });
  assert.match(running, /Call check_run with run_id "ckrun123456"/);
  assert.match(running, /Do not describe its result/);
  const noCheck = outcomeText({ ...base, status: "running", exitCode: null, files: [], imagesAttached: 0, checkRunAvailable: false });
  assert.doesNotMatch(noCheck, /check_run/);
  assert.equal(runSummary({ language: "python", status: "succeeded", exitCode: 0, files: [{ attachmentId: "a", name: "chart.png", mime: "image/png", bytes: 1, kind: "IMAGE" }] }), "run_code python → succeeded exit 0, 1 file: chart.png");
});

test("run_code arguments are validated before anything is recorded", () => {
  assert.deepEqual(parseRunCodeArgs({ code: "print(1)" }, "chat"), { language: "python", code: "print(1)", files: null, timeoutMs: 120_000 });
  const work = parseRunCodeArgs({ code: "x", timeout_seconds: 7200 }, "work");
  assert.ok(!("error" in work) && work.timeoutMs === 30 * 60_000, "clamped to the surface maximum");
  const chat = parseRunCodeArgs({ code: "x", timeout_seconds: 7200 }, "chat");
  assert.ok(!("error" in chat) && chat.timeoutMs === 10 * 60_000);
  for (const bad of [
    {},
    { code: "" },
    { code: 3 },
    { code: "x", language: "ruby" },
    { code: "x", files: "sales.csv" },
    { code: "x", files: [1] },
    { code: "x", timeout_seconds: 1.5 },
    { code: "x", timeout_seconds: 0 },
    { code: "x", network: true },
    { code: "x".repeat(300 * 1024) },
  ]) {
    assert.ok("error" in parseRunCodeArgs(bad as Record<string, unknown>, "chat"), JSON.stringify(bad).slice(0, 60));
  }
  assert.ok(!("error" in parseCheckRunArgs({ run_id: "cmabc1234567", wait_seconds: 99 })));
  assert.equal((parseCheckRunArgs({ run_id: "cmabc1234567", wait_seconds: 99 }) as { wait_seconds: number }).wait_seconds, 60);
  for (const bad of [{}, { run_id: "../x" }, { run_id: "cmabc1234567", stream: "both" }, { run_id: "cmabc1234567", offset: -1 }, { run_id: "cmabc1234567", extra: 1 }]) {
    assert.ok("error" in parseCheckRunArgs(bad as Record<string, unknown>), JSON.stringify(bad));
  }
  assert.equal(surfaceLimits("chat").inlineWaitMs, 90_000);
  assert.ok(RUN_CODE_TIMEOUT_MS > surfaceLimits("chat").inlineWaitMs + 60_000, "the dispatcher never aborts a call the runtime would still answer");
});

test("the host sees opaque identifiers only, and the same call has the same key", () => {
  process.env.AUTH_SECRET ??= "unit-test-secret";
  const session = hostSessionId("chat", "generation-1");
  assert.match(session, /^s_[0-9a-f]{32}$/);
  assert.equal(session, hostSessionId("chat", "generation-1"));
  assert.notEqual(session, hostSessionId("work", "generation-1"));
  const account = hostAccountId("user_abc");
  assert.match(account, /^a_[0-9a-f]{32}$/);
  assert.doesNotMatch(account, /user_abc/);
  const digest = runArgsDigest({ language: "python", code: "print(1)", files: ["b", "a"], timeoutMs: 1000 });
  assert.equal(digest, runArgsDigest({ language: "python", code: "print(1)", files: ["a", "b"], timeoutMs: 1000 }));
  assert.notEqual(digest, runArgsDigest({ language: "python", code: "print(2)", files: ["a", "b"], timeoutMs: 1000 }));
  const key = hostIdempotencyKey("chat", "generation-1", "toolu_1", digest);
  assert.equal(key, hostIdempotencyKey("chat", "generation-1", "toolu_1", digest));
  assert.ok(hostIdempotencyKey("chat", "g", "x".repeat(500), digest).length < 300);
});

function facts(status: ToolRunStatus, overrides: Partial<ExecRunFacts> = {}): ExecRunFacts {
  return {
    toolRunId: "tr1", runId: "r_1", context: "hosted_sandbox", language: "python", status, exitCode: status === "succeeded" ? 0 : null,
    durationMs: 10, stdoutBytes: 1, stderrBytes: 0, files: [], skippedFiles: [], finishedLate: false,
    skillVersionId: null, skillSlug: null, skillBundleDigest: null, ...overrides,
  };
}

test("outcomes map onto L1's contract without inventing success", () => {
  const running = toToolOutcome({ status: "running", text: "still running", body: "still running", run: facts("running") });
  assert.equal(running.status, "succeeded", "the call did what it said");
  assert.equal(running.run?.status, "running", "but the run is still running: receipts read this");
  const unknown = toToolOutcome({ status: "outcome_unknown", text: "?", body: "?", error: { code: "outcome_unknown" }, run: facts("outcome_unknown") });
  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(unknown.error?.code, "outcome_unknown");
  const refused = toToolOutcome({ status: "failed", text: "no", body: "no", error: { code: "capability_unavailable" } });
  assert.equal(refused.error?.code, "unavailable");
  const invalid = toToolOutcome({ status: "failed", text: "no", body: "no", error: { code: "invalid_arguments" } });
  assert.equal(invalid.error?.code, "invalid_args");
  const skill = toToolOutcome({ status: "succeeded", text: "ok", body: "ok", run: facts("succeeded", { skillSlug: "report", skillVersionId: "v1", skillBundleDigest: "d" }) });
  assert.deepEqual(skill.run?.skill, { slug: "report", versionId: "v1", bundleDigest: "d" });
  const record = toToolOutcome({ status: "failed", text: "x", body: "x", run: facts("refused") });
  assert.equal(record.run?.status, "failed");
  const progress = toToolProgress({
    toolRunId: "tr1", status: "running", stdoutTail: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    stderrTail: "warning: " + "x".repeat(900), stdoutBytes: 300, stderrBytes: 900, elapsedMs: 5000, timeoutMs: 120000,
  });
  assert.equal(progress.lines.length, TOOL_PROGRESS_MAX_LINES);
  assert.equal(progress.lines.at(-1)?.stream, "stderr");
  assert.ok(progress.lines.every((line) => line.text.length <= 500));
});

test("skill mounts are per session, validated and bounded", () => {
  const digest = "a".repeat(64);
  const mount = (slug: string) => ({ slug, skillVersionId: `v-${slug}`, bundleDigest: digest, openBundle: async () => new Uint8Array() });
  clearSkillMounts("chat", "s1");
  assert.equal(mountSkill("chat", "s1", mount("Bad Slug")), false);
  assert.equal(mountSkill("chat", "s1", { ...mount("report"), bundleDigest: "nothex" }), false);
  assert.equal(mountSkill("chat", "s1", mount("report")), true);
  assert.deepEqual(skillMountsFor("chat", "s1").map((entry) => entry.slug), ["report"]);
  assert.deepEqual(skillMountsFor("chat", "s2"), []);
  assert.deepEqual(skillMountsFor("work", "s1"), []);
  for (let i = 0; i < 7; i++) assert.equal(mountSkill("chat", "s1", mount(`s${i}`)), true);
  assert.equal(mountSkill("chat", "s1", mount("ninth")), false, "at most eight per session");
  clearSkillMounts("chat", "s1");
});

test("the attach decision: private and lockdown first, then configuration, plan and evidence", () => {
  const saved = { flag: process.env.TOOL_RUNTIME, url: process.env.CODE_INTERPRETER_URL, token: process.env.CODE_INTERPRETER_TOKEN };
  try {
    process.env.TOOL_RUNTIME = "1";
    process.env.CODE_INTERPRETER_URL = "https://exec.example";
    process.env.CODE_INTERPRETER_TOKEN = "k".repeat(40);
    const ok = { privateMode: false, lockdown: false, paidPlan: true, modelToolsVerified: true };
    assert.deepEqual(execEntitlement(ok), { attach: true });
    assert.deepEqual(execEntitlement({ ...ok, privateMode: true, lockdown: true }), { attach: false, reason: "private" });
    assert.deepEqual(execEntitlement({ ...ok, lockdown: true }), { attach: false, reason: "lockdown" });
    assert.deepEqual(execEntitlement({ ...ok, paidPlan: false }), { attach: false, reason: "plan" });
    assert.deepEqual(execEntitlement({ ...ok, workspaceAllowsCode: false }), { attach: false, reason: "workspace" });
    assert.deepEqual(execEntitlement({ ...ok, modelToolsVerified: false }), { attach: false, reason: "model_unverified" });
    delete process.env.TOOL_RUNTIME;
    assert.deepEqual(execEntitlement(ok), { attach: false, reason: "not_configured" });
  } finally {
    for (const [name, value] of [["TOOL_RUNTIME", saved.flag], ["CODE_INTERPRETER_URL", saved.url], ["CODE_INTERPRETER_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("the specs are portable reads, not parallel-safe, and brokered", async () => {
  const run = runCodeSpec({ vision: true, manifestLine: "Python 3.12 (pandas)" });
  const check = checkRunSpec({ vision: false });
  for (const spec of [run, check]) {
    assert.equal(portableSchemaProblem(spec.input), null);
    assert.equal(spec.risk, "read");
    assert.equal(spec.parallelSafe, false, "calls share a workspace and run in order");
    assert.equal(spec.broker, "juno_runtime");
  }
  assert.equal(run.id, "run_code");
  assert.equal(check.id, "check_run");
  assert.deepEqual(run.input.required, ["code"]);
  assert.match(run.description, /no internet access, cannot install packages and cannot reach the user's computer/);
  assert.match(run.description, /Python 3\.12 \(pandas\)/);
  assert.match(run.description, /inputs\/ \(read-only\)/);
  const unconfigured = await execToolProvider.availability({ userId: "u", surface: "chat", sessionId: "s", conversationId: null, projectId: null, plan: "PRO", modelId: "m", vision: true, skillSlug: null });
  if (!process.env.CODE_INTERPRETER_URL) assert.deepEqual(unconfigured, { available: false, reason: "not_configured" });
});

test("the broker classifies hosted execution as a read, so it does not ask on every run", () => {
  for (const toolName of ["run_code", "check_run", "code_interpreter"]) {
    const classified = classifyExternalAction({ connectorId: "juno_runtime", toolName, args: { code: "print(1)" } });
    assert.equal(classified.riskClass, "read_only", toolName);
  }
});

test("produced images report their real dimensions", () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageDimensions(png), { width: 640, height: 480 });
  const gif = Buffer.from("GIF89a\x20\x03\x58\x02", "latin1");
  assert.deepEqual(imageDimensions(gif), { width: 800, height: 600 });
  assert.equal(imageDimensions(Buffer.from("not an image")), null);
});
