/**
 * The workflow benchmark harness (LEDGER P1-7): the catalog is complete and
 * consistent, the frozen inputs match their manifest, states are derived one
 * way only, the runner records attempts/time/cost honestly, imported runs are
 * validated like automated ones, and the report never claims what the records
 * do not show. The validators themselves are tested in
 * workflow-bench-validators.test.ts; a real offline run through the CLI is in
 * workflow-bench-cli.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WORKFLOWS, workflowById } from "../bench/workflows/lib/catalog";
import { importedExecutor, prepareImportDir } from "../bench/workflows/lib/executors/imported";
import { buildLivePrompt, liveExecutor, livePlan, splitReply } from "../bench/workflows/lib/executors/live";
import { FIXTURES_DIR, HIDDEN_DIR, verifyFixtures } from "../bench/workflows/lib/fixtures";
import { acceptance, renderReport, summarize } from "../bench/workflows/lib/report";
import { rescoreRecord, runBenchmark, runWorkflow, type Executor } from "../bench/workflows/lib/runner";
import { deriveVerdict } from "../bench/workflows/lib/status";
import { BENCH_CATEGORIES, PERMITTED_TOOLS, TRACE_CHECKERS, type RunRecord, type WorkflowSpec } from "../bench/workflows/lib/types";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-harness-"));
  roots.push(dir);
  return dir;
}

const OFFLINE_PLANS = [
  "calc-parcels", "calc-cents", "web-injection", "extract-xlsx", "extract-pdf", "extract-docx", "work-document", "chat-docx-export",
  "work-report", "semantic-workbook", "work-spreadsheet", "chat-xlsx-export", "work-presentation", "semantic-deck", "mcp-connector",
  "mcp-ssrf", "tool-dispatch", "tool-stop", "stream-resume", "second-device", "stall-watchdog", "multilingual-export",
];

describe("catalog", () => {
  it("has at least 30 workflows with unique ids, covering every category", () => {
    assert.ok(WORKFLOWS.length >= 30, `${WORKFLOWS.length} workflows`);
    assert.equal(new Set(WORKFLOWS.map((w) => w.id)).size, WORKFLOWS.length);
    for (const category of BENCH_CATEGORIES) assert.ok(WORKFLOWS.some((w) => w.category === category), `no workflow in ${category}`);
  });

  it("every workflow has fixed inputs that exist, known tools, deliverables and an automated validator", () => {
    for (const w of WORKFLOWS) {
      for (const input of w.inputs) assert.ok(existsSync(path.join(FIXTURES_DIR, input)), `${w.id}: missing input ${input}`);
      for (const tool of w.permittedTools) assert.ok(tool in PERMITTED_TOOLS, `${w.id}: unknown tool ${tool}`);
      assert.ok(w.requiredArtifacts.length > 0, `${w.id}: no deliverable`);
      assert.ok(w.prompt.length > 40, `${w.id}: prompt too short`);
      assert.ok(w.limits.timeMinutes > 0 && w.limits.budgetUsd >= 0, `${w.id}: limits`);
      const automated = w.validators.filter((v) => v.kind !== "rubric");
      assert.ok(automated.length > 0, `${w.id}: only a rubric — nothing checks it automatically`);
    }
  });

  it("references only implemented offline plans, trace checkers and held-out tests", () => {
    for (const w of WORKFLOWS) {
      if (w.offline) {
        assert.ok(OFFLINE_PLANS.includes(w.offline.plan), `${w.id}: unknown plan ${w.offline.plan}`);
        assert.ok(w.offline.deliverables.length > 0, `${w.id}: offline plan delivers nothing`);
        assert.ok(w.offline.exercises && w.offline.standsInFor, `${w.id}: offline plan must say what it exercises and stands in for`);
      }
      for (const v of w.validators) {
        if (v.kind === "trace") assert.ok((TRACE_CHECKERS as readonly string[]).includes(v.checker), `${w.id}: checker ${v.checker}`);
        if (v.kind === "code_tests") assert.ok(existsSync(path.join(HIDDEN_DIR, v.hiddenTests)), `${w.id}: hidden tests ${v.hiddenTests}`);
      }
    }
  });

  it("held-out tests are never handed to an executor as inputs", () => {
    for (const w of WORKFLOWS) for (const input of w.inputs) assert.ok(!input.includes("hidden"), `${w.id} exposes ${input}`);
  });

  it("the frozen inputs match MANIFEST.json", () => {
    assert.deepEqual(verifyFixtures(), []);
  });

  it("a workflow that needs a person to judge it says so", () => {
    for (const w of WORKFLOWS) {
      if (w.validators.some((v) => v.kind === "rubric")) assert.ok(w.requires.includes("human_reviewer"), `${w.id}: rubric without human_reviewer requirement`);
    }
  });
});

describe("state derivation", () => {
  const pass = { id: "a", status: "pass" as const, detail: "" };
  const fail = { id: "b", status: "fail" as const, detail: "bad" };
  const pending = { id: "c", status: "not_run" as const, detail: "needs review" };
  it("follows the one table", () => {
    assert.equal(deriveVerdict({ kind: "completed" }, [pass]).state, "passed");
    assert.equal(deriveVerdict({ kind: "completed" }, [pass, fail, pending]).state, "failed");
    assert.equal(deriveVerdict({ kind: "completed" }, [pass, pending]).state, "unverified");
    assert.equal(deriveVerdict({ kind: "completed" }, []).state, "unverified");
    assert.equal(deriveVerdict({ kind: "errored", error: "500" }, [pass]).state, "failed");
    assert.equal(deriveVerdict({ kind: "timeout", error: "slow" }, []).state, "failed");
  });
});

// ── Runner ──────────────────────────────────────────────────────────────────

const WORKFLOW: WorkflowSpec = {
  id: "test-01",
  category: "reasoning",
  title: "Synthetic",
  prompt: "Answer with a line 'ANSWER: 42'. This prompt exists only to exercise the harness.",
  inputs: ["research/brief.md"],
  permittedTools: ["none"],
  requiredArtifacts: [{ name: "answer.md", kind: "markdown" }],
  limits: { timeMinutes: 1, budgetUsd: 0.01 },
  validators: [{ kind: "text", file: "answer.md", finalAnswer: { regex: "^ANSWER:\\s*(\\d+)", equals: 42 } }],
  requires: ["provider_key"],
};

function fakeExecutor(behaviour: (attempt: number, outputsDir: string) => Promise<"ok" | "error" | "hang">, over: Partial<Executor> = {}): Executor {
  return {
    id: "fake",
    identity: "fake-executor",
    kind: "automated",
    product: { id: "alevr", name: "Alevr", version: "test", surface: "test" },
    scope: "end_to_end",
    plan: () => ({ runnable: true }),
    async execute(ctx) {
      const what = await behaviour(ctx.attempt, ctx.outputsDir);
      if (what === "hang") await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (what === "error") return { outcome: { kind: "errored", error: "HTTP 529 overloaded" } };
      return { outcome: { kind: "completed" }, model: "test-model", cost: { usd: 0.001, source: "measured_usage", inputTokens: 10, outputTokens: 5 } };
    },
    ...over,
  };
}

describe("runner", () => {
  it("copies only the declared inputs, validates, and records model, cost and hashes", async () => {
    const out = tmp();
    let sawInputs: string[] = [];
    const record = await runWorkflow(WORKFLOW, {
      runId: "t",
      outDir: out,
      workflows: [WORKFLOW],
      executor: fakeExecutor(async (_n, outputsDir) => {
        sawInputs = [existsSync(path.join(outputsDir, "../inputs/research/brief.md")) ? "brief" : "", existsSync(path.join(outputsDir, "../inputs/research/decision.md")) ? "decision" : ""].filter(Boolean);
        writeFileSync(path.join(outputsDir, "answer.md"), "ANSWER: 42\n");
        return "ok";
      }),
    });
    assert.deepEqual(sawInputs, ["brief"]);
    assert.equal(record.state, "passed");
    assert.equal(record.firstAttemptPassed, true);
    assert.equal(record.model, "test-model");
    assert.equal(record.cost.usd, 0.001);
    assert.equal(record.cost.source, "measured_usage");
    assert.equal(record.attempts.length, 1);
    assert.match(record.artifacts[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(record.startedAt && record.finishedAt && typeof record.durationMs === "number");
    assert.ok(existsSync(path.join(out, record.runDir!, "outputs/answer.md")));
  });

  it("a plan that cannot run records not_run with its reason and no attempts", async () => {
    const record = await runWorkflow(WORKFLOW, { runId: "t", outDir: tmp(), workflows: [WORKFLOW], executor: fakeExecutor(async () => "ok", { plan: () => ({ runnable: false, state: "not_run", reason: "no provider key" }) }) });
    assert.equal(record.state, "not_run");
    assert.equal(record.reason, "no provider key");
    assert.equal(record.attempts.length, 0);
    assert.equal(record.firstAttemptPassed, null);
  });

  it("retries a failure, and a later pass is never a first-attempt pass", async () => {
    const record = await runWorkflow(WORKFLOW, {
      runId: "t",
      outDir: tmp(),
      workflows: [WORKFLOW],
      maxAttempts: 3,
      executor: fakeExecutor(async (n, outputsDir) => {
        if (n === 1) return "error";
        writeFileSync(path.join(outputsDir, "answer.md"), n === 2 ? "ANSWER: 41\n" : "ANSWER: 42\n");
        return "ok";
      }),
    });
    assert.deepEqual(record.attempts.map((a) => a.state), ["failed", "failed", "passed"]);
    assert.equal(record.attempts[0].error, "HTTP 529 overloaded");
    assert.equal(record.state, "passed");
    assert.equal(record.firstAttemptPassed, false);
    assert.ok(Math.abs((record.cost.usd ?? 0) - 0.002) < 1e-9, "cost sums the completed attempts");
  });

  it("a hung product times out as failed", async () => {
    const record = await runWorkflow(WORKFLOW, { runId: "t", outDir: tmp(), workflows: [WORKFLOW], timeoutMs: 50, executor: fakeExecutor(async () => "hang") });
    assert.equal(record.state, "failed");
    assert.equal(record.attempts[0].outcome, "timeout");
  });

  it("a missing deliverable fails even when no validator names it", async () => {
    const wf = { ...WORKFLOW, validators: [] };
    const record = await runWorkflow(wf, { runId: "t", outDir: tmp(), workflows: [wf], executor: fakeExecutor(async () => "ok") });
    assert.equal(record.state, "failed");
    assert.ok(record.checks.some((c) => c.id === "required:answer.md" && c.status === "fail"));
  });

  it("an observed cost above the budget turns a pass into a failure", async () => {
    const wf = { ...WORKFLOW, limits: { timeMinutes: 1, budgetUsd: 0.0001 } };
    const record = await runWorkflow(wf, {
      runId: "t",
      outDir: tmp(),
      workflows: [wf],
      executor: fakeExecutor(async (_n, outputsDir) => {
        writeFileSync(path.join(outputsDir, "answer.md"), "ANSWER: 42\n");
        return "ok";
      }),
    });
    assert.equal(record.state, "failed");
    assert.match(record.reason, /budget/);
  });

  it("rescore picks up a review added after the run, and an edit invalidates it", async () => {
    const wf: WorkflowSpec = { ...WORKFLOW, validators: [...WORKFLOW.validators, { kind: "rubric", criteria: [{ id: "clear", description: "clear", passAt: 4 }] }], requires: ["provider_key", "human_reviewer"] };
    const out = tmp();
    const record = await runWorkflow(wf, {
      runId: "t",
      outDir: out,
      workflows: [wf],
      executor: fakeExecutor(async (_n, outputsDir) => {
        writeFileSync(path.join(outputsDir, "answer.md"), "ANSWER: 42\n");
        return "ok";
      }),
    });
    assert.equal(record.state, "unverified");
    const attemptDir = path.join(out, record.runDir!);
    writeFileSync(
      path.join(attemptDir, "review.json"),
      JSON.stringify({ reviewer: "reviewer-b", reviewedAt: "2026-10-25T00:00:00Z", executorIdentity: "fake-executor", artifactHashes: { "answer.md": record.artifacts[0].sha256 }, scores: { clear: 5 } })
    );
    const opts = { network: false, officeReopen: false, soffice: null };
    const reviewed = await rescoreRecord(record, wf, out, opts);
    assert.equal(reviewed.state, "passed");
    assert.equal(reviewed.firstAttemptPassed, true);
    const overBudget = await rescoreRecord({ ...record, cost: { ...record.cost, usd: 1 } }, wf, out, opts);
    assert.equal(overBudget.state, "failed", "the budget rule applies on rescore too");
    writeFileSync(path.join(attemptDir, "outputs/answer.md"), "ANSWER: 42 (edited after review)\n");
    assert.equal((await rescoreRecord(record, wf, out, opts)).state, "failed");
  });
});

// ── Imported (human-conducted) runs ─────────────────────────────────────────

describe("imported runs", () => {
  const wf = workflowById("chat-02")!;
  function conduct(dir: string, product: string, patch: Record<string, unknown>, answer?: string) {
    const folder = path.join(dir, product, wf.id);
    const result = JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(path.join(folder, "result.json"), JSON.stringify({ ...result, ...patch }));
    if (answer !== undefined) writeFileSync(path.join(folder, "outputs/answer.md"), answer);
  }
  const politeAnswer = "Hi Priya,\n\nA quick reminder that invoice INV-2291 for EUR 1,240.50 was due on 2026-11-14. Could you let me know when payment is planned?\n\nThank you.";

  it("prepare lays out prompt, inputs and a not_run template, and never overwrites a conducted run", () => {
    const dir = tmp();
    assert.equal(prepareImportDir(dir, "chatgpt", [wf]), 1);
    const folder = path.join(dir, "chatgpt", wf.id);
    assert.ok(readFileSync(path.join(folder, "prompt.txt"), "utf8").startsWith(wf.prompt));
    assert.ok(existsSync(path.join(folder, "inputs/data/email-draft.txt")));
    assert.equal(JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8")).status, "not_run");
    conduct(dir, "chatgpt", { status: "completed", executorIdentity: "alice" }, politeAnswer);
    assert.equal(prepareImportDir(dir, "chatgpt", [wf]), 0);
    assert.equal(JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8")).executorIdentity, "alice");
  });

  it("a conducted competitor run is validated like any other and keeps its own metadata", async () => {
    const dir = tmp();
    prepareImportDir(dir, "chatgpt", [wf]);
    conduct(dir, "chatgpt", { status: "completed", executorIdentity: "alice", productVersion: "web 2026-10-25", model: "gpt-6-sol", startedAt: "2026-10-25T10:00:00Z", durationSeconds: 12, costUsd: null }, politeAnswer);
    const records = await runBenchmark({ runId: "imp", outDir: tmp(), workflows: [wf], executor: importedExecutor({ dir, product: { id: "chatgpt", name: "ChatGPT", version: null, surface: "web" } }) });
    const [r] = records;
    assert.equal(r.state, "passed", r.reason);
    assert.equal(r.product.version, "web 2026-10-25");
    assert.equal(r.executor.identity, "alice");
    assert.equal(r.model, "gpt-6-sol");
    assert.equal(r.durationMs, 12_000);
    assert.equal(r.cost.usd, null);
    assert.equal(r.cost.source, "unobserved");
  });

  it("a second attempt or a human fix is never a first-attempt pass", async () => {
    const dir = tmp();
    prepareImportDir(dir, "claude", [wf]);
    conduct(dir, "claude", { status: "completed", executorIdentity: "bob", attempt: 2 }, politeAnswer);
    const [second] = await runBenchmark({ runId: "imp", outDir: tmp(), workflows: [wf], executor: importedExecutor({ dir, product: { id: "claude", name: "Claude", version: null, surface: "web" } }) });
    assert.equal(second.state, "passed");
    assert.equal(second.firstAttemptPassed, false);
    conduct(dir, "claude", { attempt: 1, humanInterventions: ["approval: allowed file read", "edited the answer to fix the date"] });
    const [helped] = await runBenchmark({ runId: "imp", outDir: tmp(), workflows: [wf], executor: importedExecutor({ dir, product: { id: "claude", name: "Claude", version: null, surface: "web" } }) });
    assert.equal(helped.firstAttemptPassed, false);
  });

  it("unsupported needs dated evidence; a mismatched folder is refused", async () => {
    const dir = tmp();
    prepareImportDir(dir, "grok", [wf]);
    const exec = () => importedExecutor({ dir, product: { id: "grok", name: "Grok", version: null, surface: "web" } });
    conduct(dir, "grok", { status: "unsupported" });
    assert.equal((await runBenchmark({ runId: "i", outDir: tmp(), workflows: [wf], executor: exec() }))[0].state, "not_run");
    conduct(dir, "grok", { status: "unsupported", unsupportedEvidence: { source: "https://example.com/docs", accessedAt: "2026-10-25", note: "No file attachments on the free web app." } });
    const [u] = await runBenchmark({ runId: "i", outDir: tmp(), workflows: [wf], executor: exec() });
    assert.equal(u.state, "unsupported");
    assert.equal(u.unsupportedEvidence?.accessedAt, "2026-10-25");
    conduct(dir, "grok", { status: "completed", executorIdentity: "x", workflowId: "chat-01" });
    assert.match((await runBenchmark({ runId: "i", outDir: tmp(), workflows: [wf], executor: exec() }))[0].reason, /does not match/);
  });
});

// ── Live executor ───────────────────────────────────────────────────────────

describe("live executor", () => {
  const env = { providersConfigured: ["anthropic"], network: false, hasCall: true };
  it("runs chat-answer workflows and names every blocker for the rest", () => {
    assert.deepEqual(livePlan(workflowById("chat-02")!, env), { runnable: true });
    const noKey = livePlan(workflowById("chat-02")!, { ...env, providersConfigured: [] });
    assert.ok(!noKey.runnable && /no model provider key/.test(noKey.reason));
    const doc = livePlan(workflowById("documents-01")!, env);
    assert.ok(!doc.runnable && /alevr_deployment/.test(doc.reason) && /memo\.docx/.test(doc.reason) && /import/.test(doc.reason));
    const attach = livePlan(workflowById("files-02")!, env);
    assert.ok(!attach.runnable && /attachments/.test(attach.reason));
    const web = livePlan(workflowById("research-02")!, env);
    assert.ok(!web.runnable && /network/.test(web.reason));
  });

  it("inlines text inputs and splits facts.json from the answer", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data/email-draft.txt"), "draft text");
    assert.match(buildLivePrompt(workflowById("chat-02")!, dir), /File: data\/email-draft\.txt\n```\ndraft text\n```/);
    assert.deepEqual(splitReply('Total is 390.\n```json facts.json\n{"paidEUR": 390}\n```'), { answer: "Total is 390.", facts: '{"paidEUR": 390}' });
  });

  it("records the model and measured cost from the call, and a null price stays unobserved", async () => {
    const executor = liveExecutor({
      product: { id: "alevr", name: "Alevr", version: "t", surface: "api" },
      providersConfigured: ["anthropic"],
      network: false,
      call: async () => ({ text: "Hi Priya, invoice INV-2291 for EUR 1,240.50 was due 2026-11-14. Thanks.", model: "claude-test", inputTokens: 100, outputTokens: 20, costUsd: null }),
    });
    const [r] = await runBenchmark({ runId: "live", outDir: tmp(), workflows: [workflowById("chat-02")!], executor });
    assert.equal(r.state, "passed", r.reason);
    assert.equal(r.model, "claude-test");
    assert.equal(r.cost.usd, null);
    assert.equal(r.cost.source, "unobserved");
    assert.equal(r.cost.inputTokens, 100);
  });
});

// ── Report ──────────────────────────────────────────────────────────────────

describe("report", () => {
  const base = (over: Partial<RunRecord>): RunRecord => ({
    runId: "r",
    workflowId: "chat-02",
    category: "everyday_chat",
    scope: "end_to_end",
    product: { id: "alevr", name: "Alevr", version: "1", surface: "web" },
    model: null,
    settings: {},
    executor: { id: "x", identity: "x", kind: "automated" },
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cost: { usd: null, source: "unobserved" },
    attempts: [],
    state: "not_run",
    reason: "no key",
    firstAttemptPassed: null,
    artifacts: [],
    checks: [],
    review: null,
    runDir: null,
    ...over,
  });
  const ran = (state: RunRecord["state"], first: boolean, over: Partial<RunRecord> = {}) =>
    base({ state, firstAttemptPassed: first, attempts: [{ n: 1, startedAt: "", durationMs: 1, outcome: "completed", state }], artifacts: [{ name: "answer.md", bytes: 1, sha256: "a" }], reason: state, ...over });

  it("rates first attempts over attempted runs and over all workflows, and never mixes scopes", () => {
    const records = [ran("passed", true), ran("failed", false, { workflowId: "chat-01" }), base({ workflowId: "writing-01" }), ran("passed", true, { scope: "offline_pipeline" })];
    const s = summarize(records);
    const e2e = s.find((c) => c.column === "alevr:end_to_end")!;
    assert.equal(e2e.attempted, 2);
    assert.equal(e2e.firstAttemptPassed, 1);
    assert.equal(e2e.firstAttemptRate, 0.5);
    assert.equal(e2e.firstAttemptRateAllWorkflows, 1 / 3);
    assert.equal(s.find((c) => c.column === "alevr:offline_pipeline")!.counts.passed, 1);
  });

  it("acceptance is computed from records: offline passes never satisfy it", () => {
    const offline = WORKFLOWS.map((w) => ran("passed", true, { workflowId: w.id, category: w.category, scope: "offline_pipeline" }));
    const status = acceptance(offline);
    assert.deepEqual(status.map((a) => a.met), [false, false, false]);
    const e2e = WORKFLOWS.map((w) => ran("passed", true, { workflowId: w.id, category: w.category }));
    const competitors = BENCH_CATEGORIES.map((c) => ran("failed", false, { category: c, product: { id: "chatgpt", name: "ChatGPT", version: null, surface: "web" } }));
    assert.deepEqual(acceptance([...e2e, ...competitors]).map((a) => a.met), [true, true, true]);
  });

  it("renders every state, failure detail and not_run reason", () => {
    const md = renderReport(
      [{ benchVersion: "v", runId: "r", createdAt: "", environment: { node: "v22", platform: "linux", providersConfigured: [], libreoffice: null, network: false, gitCommit: "abc", gitDirty: false, fixturesDigest: "d" }, workflowCount: 2, records: [ran("failed", false, { checks: [{ id: "text:x", status: "fail", detail: "missing INV-2291" }] }), base({ workflowId: "chat-01", reason: "no model provider key" })] }],
      WORKFLOWS
    );
    assert.match(md, /## Acceptance \(LEDGER P1-7\)/);
    assert.match(md, /\*\*NOT MET\*\*/);
    assert.match(md, /missing INV-2291/);
    assert.match(md, /no model provider key: `chat-01`/);
    assert.match(md, /model providers configured: none/);
  });
});
