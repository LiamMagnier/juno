/**
 * Cloud Work runs across a restart of their runner, against a real Postgres.
 *
 * The first test drives the writes (src/lib/work/restart-resume.ts): a run set
 * aside between two steps is put back in the queue by the next runner, one
 * whose checkpoint shows a tool in flight ends `interrupted`, the switch turns
 * the continuing off, and a person's own pause or resume always wins.
 *
 * The second drives the real cloud executor (scripts/work-runner.ts) as a child
 * process against a local stand-in for Anthropic's streaming API, so the whole
 * path is exercised: SIGINT while a step is in progress, the step finishes and
 * its tool runs once, the run is set aside and the runner exits by itself, a
 * second runner continues it without repeating the tool, and a run still
 * inside a step when the wait runs out ends `interrupted`. No model is called;
 * the "model" is a script.
 *
 * The last sends the stop signal the way PM2's default treekill sends it, to
 * the runner and every process under it, while a browser call's process is
 * running: the run reaches its step boundary all the same, and still ends
 * `interrupted` rather than being continued.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_restart_resume_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/work-restart-resume.integration.test.ts
 *
 * The executor test also needs runner/agent-core/dist (npm run test:prepare).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.ORBIT_TEST_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "anthropic:claude-sonnet-5-5";

if (!url) {
  test("restart-resume suite is skipped without ORBIT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_0-9]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  process.env.AUTH_SECRET ??= "work-restart-resume-integration-test-key";
  process.env.DATA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.WORK_CLOUD_AVAILABLE = "1";

  const RUN_CHECKPOINT = (runId: string, messages: unknown[]) => ({
    runId,
    version: 1,
    messages,
    plan: { steps: [{ id: "work", title: "Do the work", status: "active" }] },
    budget: { accumulatedMs: 0, usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } },
    seq: 3,
    actions: [],
    citations: [],
    decisions: [],
    artifacts: [],
    uncertainties: [],
  });
  const goal = { role: "user", content: [{ type: "text", text: "Save the note." }] };
  const asked = { role: "assistant", content: [{ type: "tool_call", id: "tc_1", name: "cloud_files", input: { operation: "write" } }] };
  const answered = (content: string) => ({ role: "user", content: [{ type: "tool_result", toolCallId: "tc_1", content }] });

  test("the next runner continues a run set aside between two steps, and no other", async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/work/store");
    const restart = await import("../src/lib/work/restart-resume");
    const owner = `restart-store-${randomUUID()}`;
    const EXEC_A = "work-runner:a:test";
    const EXEC_B = "work-runner:b:test";

    async function runningRun(label: string) {
      const session = await store.createWorkSession({ userId: owner, title: label, goal: "Save the note.", requestedTarget: "cloud" });
      const created = await store.createRun({
        sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
        permissionPolicy: {} as never, budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
        idempotencyKey: `restart:${label}:${randomUUID()}`,
      });
      const claim = await store.claimRun({ runId: created.run.id, userId: owner, executorId: EXEC_A });
      assert.equal(claim.claimed, true);
      await db.workRun.update({ where: { id: created.run.id }, data: { status: "running" } });
      return { runId: created.run.id, sessionId: session.id };
    }
    async function parkedWith(label: string, messages: unknown[]) {
      const run = await runningRun(label);
      assert.equal(
        await store.saveRunCheckpoint({ runId: run.runId, userId: owner, executorId: EXEC_A, checkpoint: RUN_CHECKPOINT(run.runId, messages) as never }),
        true
      );
      assert.equal(await restart.parkRunForRestart({ runId: run.runId, userId: owner, executorId: EXEC_A }), true);
      return run;
    }

    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });

      // Set aside between two steps: paused for a restart, lease released,
      // nobody asked anything (not in Needs you).
      const clean = await parkedWith("clean", [goal, asked, answered("Saved restart.txt")]);
      let row = await db.workRun.findUniqueOrThrow({ where: { id: clean.runId } });
      assert.deepEqual([row.status, row.pauseReason, row.claimedBy, row.leaseExpiresAt], ["paused", "server_restart", null, null]);
      const parkedSession = await db.workSession.findUniqueOrThrow({ where: { id: clean.sessionId } });
      assert.deepEqual([parkedSession.status, parkedSession.needsAttention], ["paused", false]);

      const inFlight = await parkedWith("in-flight", [goal, asked, answered("Stopped before this finished.")]);
      const unanswered = await parkedWith("unanswered", [goal, asked]);
      const switchedOff = await parkedWith("switched-off", [goal, asked, answered("Saved restart.txt")]);

      // A run the person paused keeps their pause, even when a restart parks it.
      const personPaused = await runningRun("person-paused");
      await db.workRun.update({ where: { id: personPaused.runId }, data: { status: "paused", pauseReason: "user" } });
      assert.equal(await restart.parkRunForRestart({ runId: personPaused.runId, userId: owner, executorId: EXEC_A }), true);
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: personPaused.runId } })).pauseReason, "user");

      // A run the person resumed before the next runner came up is theirs.
      const personResumed = await parkedWith("person-resumed", [goal]);
      await db.workRun.update({ where: { id: personResumed.runId }, data: { status: "queued", pauseReason: null } });

      // Another executor's park never lands on a run this one does not hold.
      const notMine = await runningRun("not-mine");
      assert.equal(await restart.parkRunForRestart({ runId: notMine.runId, userId: owner, executorId: EXEC_B }), false);
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: notMine.runId } })).status, "running");

      const swept = await restart.resumeRunsParkedForRestart({ executorId: EXEC_B, enabled: true, limit: 100 });
      const mine = (ids: string[]) => ids.filter((id) => [clean, inFlight, unanswered, switchedOff, personPaused, personResumed].some((run) => run.runId === id));
      assert.deepEqual(mine(swept.requeued), [clean.runId, switchedOff.runId]);
      assert.deepEqual(
        swept.ended.filter((entry) => mine([entry.runId]).length > 0).map((entry) => [entry.runId, entry.why]),
        [[inFlight.runId, "tool_in_flight"], [unanswered.runId, "unanswered_call"]]
      );

      row = await db.workRun.findUniqueOrThrow({ where: { id: clean.runId } });
      assert.deepEqual([row.status, row.pauseReason, row.claimedBy], ["queued", null, null]);
      assert.equal((await db.workSession.findUniqueOrThrow({ where: { id: clean.sessionId } })).status, "queued");

      for (const run of [inFlight, unanswered]) {
        const ended = await db.workRun.findUniqueOrThrow({ where: { id: run.runId } });
        assert.equal(ended.status, "interrupted");
        assert.equal(ended.terminalReason, "interrupted");
        assert.equal(ended.terminalDetail, restart.RESTART_NOT_RESUMED_DETAIL);
        assert.notEqual(ended.checkpoint, null, "its progress is kept: interrupted is resumable");
        assert.equal(ended.claimedBy, null);
        const finished = await db.workEvent.findMany({ where: { runId: run.runId, kind: "run_finished" } });
        assert.equal(finished.length, 1);
        assert.equal((finished[0]!.payload as { cause?: string }).cause, "server_restart");
      }
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: personPaused.runId } })).status, "paused");
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: personResumed.runId } })).status, "queued");

      // Swept again: nothing moves twice.
      const again = await restart.resumeRunsParkedForRestart({ executorId: EXEC_B, enabled: true, limit: 100 });
      assert.deepEqual(mine(again.requeued), []);
      assert.deepEqual(again.ended.filter((entry) => mine([entry.runId]).length > 0), []);

      // The switch off: a clean run set aside ends interrupted, its progress kept.
      const off = await parkedWith("off", [goal, asked, answered("Saved restart.txt")]);
      const sweptOff = await restart.resumeRunsParkedForRestart({ executorId: EXEC_B, enabled: false, limit: 100 });
      assert.deepEqual(sweptOff.ended.filter((entry) => entry.runId === off.runId).map((entry) => entry.why), ["switched_off"]);
      const offRow = await db.workRun.findUniqueOrThrow({ where: { id: off.runId } });
      assert.deepEqual([offRow.status, offRow.terminalDetail], ["interrupted", restart.RESTART_RESUME_OFF_DETAIL]);
      assert.notEqual(offRow.checkpoint, null);

      // The resume label: only the runner's own restart pause, never a person's resume.
      await store.appendEvents({ runId: clean.runId, userId: owner, events: [{ kind: "paused", payload: { reason: "x", cause: "server_restart" } }] });
      assert.equal(await restart.resumingAfterRestart({ runId: clean.runId, userId: owner }), true);
      await store.appendEvents({ runId: clean.runId, userId: owner, events: [{ kind: "resumed", payload: { actor: "web" } }] });
      assert.equal(await restart.resumingAfterRestart({ runId: clean.runId, userId: owner }), false);
    } finally {
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // juno-sweepers as a process
  // -------------------------------------------------------------------------

  test("juno-sweepers writes its heartbeat, and starts the scheduler and the trigger poller only when switched on", { timeout: 180_000 }, async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const { SWEEPERS_HEARTBEAT_KEY } = await import("../src/lib/worker-watchdog-rules");
    const { readFileSync } = await import("node:fs");
    const logDir = process.env.RESTART_E2E_LOG_DIR ?? path.join(tmpdir(), "restart-e2e-logs");
    mkdirSync(logDir, { recursive: true });

    async function sweepers(switchedOn: boolean, until: (log: string) => boolean) {
      const logFile = path.join(logDir, `sweepers-${switchedOn ? "on" : "off"}-${Date.now()}.log`);
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/sweepers.ts", "--daemon"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/tmp",
          NODE_OPTIONS: "--conditions=react-server",
          DATABASE_URL: url,
          DIRECT_URL: url,
          AUTH_SECRET: process.env.AUTH_SECRET,
          DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
          SWEEPERS_RUN_WORK_SCHEDULER: switchedOn ? "1" : "",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
      });
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      try {
        const deadline = Date.now() + 90_000;
        let log = "";
        while (Date.now() < deadline) {
          log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
          if (until(log)) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.ok(until(log), `sweepers did not get there (log: ${logFile})`);
        return log;
      } finally {
        child.kill("SIGTERM");
        const code = await Promise.race([exited, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 30_000))]);
        if (code === "hung") child.kill("SIGKILL");
        assert.equal(code, 0, `juno-sweepers stops cleanly on SIGTERM (log: ${logFile})`);
      }
    }

    await db.rateLimit.deleteMany({ where: { key: SWEEPERS_HEARTBEAT_KEY } });
    const off = await sweepers(false, (log) => /are not started in this process/.test(log));
    assert.doesNotMatch(off, /\[work-scheduler\] started/);
    assert.doesNotMatch(off, /\[work-trigger-poller\] started/);
    const beat = await db.rateLimit.findUnique({ where: { key: SWEEPERS_HEARTBEAT_KEY } });
    assert.ok(beat && beat.expiresAt.getTime() > Date.now(), "the watchdog wrote the process's heartbeat on its first look");

    const on = await sweepers(true, (log) => /\[work-scheduler\] started/.test(log) && /\[work-trigger-poller\] started/.test(log));
    assert.doesNotMatch(on, /are not started in this process/);
    assert.doesNotMatch(on, /uncaught exception|unhandled rejection/);
  });

  // -------------------------------------------------------------------------
  // The real executor, end to end
  // -------------------------------------------------------------------------

  const distReady = existsSync(path.join(ROOT, "runner/agent-core/dist/work/index.js"));

  // A local stand-in for Anthropic's streaming Messages API: the "model" is a script.
  type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string };
  const flat = (value: unknown): string =>
    typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => flat((part as Block).text ?? (part as Block).content ?? "")).join("") : "";

  function sse(res: ServerResponse, out: { text: string } | { tool: { name: string; input: Record<string, unknown> } }) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
    if ("tool" in out) {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: out.tool.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(out.tool.input) } });
    } else {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.text } });
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "tool" in out ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    send("message_stop", { type: "message_stop" });
    res.end();
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  }

  /** The real cloud executor as a child process, its output in a log file. */
  function spawnRunner(input: {
    name: string;
    port: number;
    logDir: string;
    stepWaitMs: number;
    runners: ChildProcess[];
    env?: Record<string, string>;
  }) {
    const logFile = path.join(input.logDir, `${input.name}-${Date.now()}.log`);
    const out = openSync(logFile, "a");
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/work-runner.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        NODE_OPTIONS: "--conditions=react-server",
        DATABASE_URL: url,
        DIRECT_URL: url,
        AUTH_SECRET: process.env.AUTH_SECRET,
        DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
        ANTHROPIC_API_KEY: "sk-ant-test-local-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${input.port}`,
        WORK_SHUTDOWN_STEP_WAIT_MS: String(input.stepWaitMs),
        HOSTNAME: input.name,
        ...input.env,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", out, out],
    });
    input.runners.push(child);
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.on("exit", (code) => resolve({ code, at: Date.now() })));
    return { child, exited, logFile };
  }

  /**
   * What PM2 does on `pm2 stop` with its default treekill (lib/TreeKill.js, on
   * Linux): the signal to the process and to every descendant, found by parent
   * pid. juno-work now sets `treekill: false`; a host shutdown or a terminal's
   * Ctrl-C still signals the whole tree.
   */
  function treeKill(pid: number, signal: NodeJS.Signals): void {
    const tree = [pid];
    for (let index = 0; index < tree.length; index += 1) {
      const listed = spawnSync("ps", ["-o", "pid", "--no-headers", "--ppid", String(tree[index])], { encoding: "utf8" });
      for (const line of listed.stdout.split("\n")) {
        const child = Number(line.trim());
        if (Number.isInteger(child) && child > 0) tree.push(child);
      }
    }
    for (const target of tree.reverse()) {
      try {
        process.kill(target, signal);
      } catch {
        // Gone already.
      }
    }
  }

  async function waitFor<T>(what: string, probe: () => Promise<T | null>, logDir: string, ms = 120_000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = await probe();
      if (value !== null) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${what} (logs: ${logDir})`);
  }

  test("SIGINT mid-step: the step finishes, the run is set aside, the next runner continues it once; a step that outlasts the wait ends interrupted", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)", timeout: 300_000 }, async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/work/store");
    const restart = await import("../src/lib/work/restart-resume");

    const requests: Array<{ scenario: string; results: string[] }> = [];
    const gates: { releaseFirst?: () => void; firstArrived?: () => void; holdArrived?: () => void; holdClosed: boolean } = { holdClosed: false };
    const firstRequest = new Promise<void>((resolve) => {
      gates.firstArrived = resolve;
    });
    const holdRequest = new Promise<void>((resolve) => {
      gates.holdArrived = resolve;
    });

    const lab: Server = createServer((req, res) => {
      void readBody(req).then(async (body) => {
        const system = flat(body.system);
        const results: string[] = [];
        for (const message of (body.messages ?? []) as Array<{ content: unknown }>) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Block[]) if (block.type === "tool_result") results.push(flat(block.content));
        }
        const scenario = system.includes("[scenario:restart]") ? "restart" : system.includes("[scenario:hold]") ? "hold" : "other";
        requests.push({ scenario, results });
        if (scenario === "restart" && results.length === 0) {
          // The step is in progress while the runner is told to stop.
          gates.firstArrived?.();
          await new Promise<void>((resolve) => {
            gates.releaseFirst = resolve;
          });
          return sse(res, { tool: { name: "cloud_files", input: { operation: "write", name: "restart-e2e.txt", content: "Saved." } } });
        }
        if (scenario === "restart") return sse(res, { text: "Saved the note to restart-e2e.txt." });
        if (scenario === "hold") {
          gates.holdArrived?.();
          // Never answered: the step outlasts the wait. Closed by the runner's stop.
          res.on("close", () => {
            gates.holdClosed = true;
          });
          return;
        }
        return sse(res, { text: "YES — it saved the note." });
      }, () => {
        res.writeHead(400);
        res.end();
      });
    });
    await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
    const port = (lab.address() as AddressInfo).port;

    const logDir = process.env.RESTART_E2E_LOG_DIR ?? path.join(tmpdir(), "restart-e2e-logs");
    mkdirSync(logDir, { recursive: true });
    const owner = `restart-e2e-${randomUUID()}`;
    const runners: ChildProcess[] = [];
    const startRunner = (name: string, stepWaitMs: number) => spawnRunner({ name, port, logDir, stepWaitMs, runners });
    const waitUntil = <T,>(what: string, probe: () => Promise<T | null>, ms = 120_000): Promise<T> => waitFor(what, probe, logDir, ms);
    const startRun = async (scenario: string) => {
      const session = await store.createWorkSession({ userId: owner, title: scenario, goal: `[scenario:${scenario}] Save the note.`, requestedTarget: "cloud" });
      const created = await store.createRun({
        sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
        // Unattended and permissive: no plan review and no approval, so the
        // only thing that stops this run is the restart.
        permissionPolicy: { policy: "permissive", attended: false } as never,
        budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
        idempotencyKey: `restart-e2e:${scenario}:${randomUUID()}`,
      });
      await db.workSession.update({ where: { id: session.id }, data: { status: "queued" } });
      return { sessionId: session.id, runId: created.run.id };
    };
    const writes = async (runId: string) =>
      (await db.workEvent.findMany({ where: { runId, kind: "tool_finished" } })).filter((e) => (e.payload as { tool?: string }).tool === "cloud_files").length;

    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });

      const run = await startRun("restart");
      const a = startRunner("runner-a", 30_000);
      await firstRequest;
      // SIGINT while the step is in progress (its model reply has not arrived).
      const signalledAt = Date.now();
      a.child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      gates.releaseFirst?.();

      const exitA = await a.exited;
      assert.equal(exitA.code, 0, `runner A exits cleanly by itself (log: ${a.logFile})`);
      assert.ok(exitA.at - signalledAt < 30_000, `and promptly: ${exitA.at - signalledAt} ms`);

      const parked = await db.workRun.findUniqueOrThrow({ where: { id: run.runId } });
      assert.deepEqual([parked.status, parked.pauseReason, parked.claimedBy], ["paused", "server_restart", null], parked.terminalDetail ?? "");
      assert.equal(await writes(run.runId), 1, "the step's tool ran, once");
      assert.equal(requests.filter((r) => r.scenario === "restart").length, 1, "the next step's request never went out");
      const pausedEvents = await db.workEvent.findMany({ where: { runId: run.runId, kind: "paused" } });
      assert.equal(pausedEvents.length, 1);
      assert.equal((pausedEvents[0]!.payload as { cause?: string }).cause, "server_restart");
      assert.equal((pausedEvents[0]!.payload as { reason?: string }).reason, restart.RESTART_PAUSED_COPY);
      assert.deepEqual(restart.restartCheckpointVerdict(parked.checkpoint, run.runId), { clean: true });

      // The next runner continues it from the next step.
      const b = startRunner("runner-b", 2_000);
      const ended = await waitUntil(`${run.runId} to finish`, async () => {
        const row = await db.workRun.findUnique({ where: { id: run.runId } });
        return row && ["completed", "failed", "interrupted", "cancelled", "budget_exceeded", "timed_out"].includes(row.status) ? row : null;
      });
      assert.notEqual(ended.status, "interrupted", ended.terminalDetail ?? "");
      assert.equal(await writes(run.runId), 1, "the tool was not run again");
      const starts = (await db.workEvent.findMany({ where: { runId: run.runId, kind: "run_started" } })).filter((e) => (e.payload as { executor?: string }).executor === "cloud");
      assert.equal(starts.length, 2, "claimed once by each runner");
      const resumed = await db.workEvent.findMany({ where: { runId: run.runId, kind: "resumed" } });
      assert.equal(resumed.length, 1);
      assert.deepEqual(
        [(resumed[0]!.payload as { cause?: string }).cause, (resumed[0]!.payload as { detail?: string }).detail],
        ["server_restart", restart.RESTART_RESUMED_DETAIL]
      );
      const second = requests.filter((r) => r.scenario === "restart")[1];
      assert.ok(second, "the next step went out");
      assert.ok(second.results.some((text) => text.includes("restart-e2e.txt") || text.length > 0), JSON.stringify(second.results));
      assert.ok(!second.results.some((text) => text === "Stopped before this finished." || text === "Cancelled."), "never a stopped placeholder");
      assert.deepEqual((await db.workEvent.findMany({ where: { runId: run.runId, kind: "error" } })).map((e) => e.payload), []);

      // A step that outlasts the wait: stopped mid-step, ended interrupted.
      const held = await startRun("hold");
      await holdRequest;
      const holdSignalledAt = Date.now();
      b.child.kill("SIGINT");
      const exitB = await b.exited;
      assert.equal(exitB.code, 0, `runner B exits cleanly (log: ${b.logFile})`);
      assert.ok(exitB.at - holdSignalledAt < 2_000 + 8_000 + 5_000, `inside the wait and the grace: ${exitB.at - holdSignalledAt} ms`);
      const stopped = await db.workRun.findUniqueOrThrow({ where: { id: held.runId } });
      assert.deepEqual([stopped.status, stopped.terminalReason, stopped.terminalDetail], ["interrupted", "interrupted", restart.RESTART_MID_STEP_DETAIL]);
      assert.notEqual(stopped.checkpoint, null, "its progress is kept");
      const heldPaused = await db.workEvent.findMany({ where: { runId: held.runId, kind: "paused" } });
      assert.equal((heldPaused[0]?.payload as { cause?: string } | undefined)?.cause, "server_restart_mid_step");
      assert.equal(await db.workEvent.count({ where: { runId: held.runId, kind: "run_finished" } }), 1);
      assert.ok(gates.holdClosed, "the request in flight was abandoned, not left open");
    } finally {
      for (const child of runners) if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => lab.close(() => resolve()));
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
      rmSync(path.join(ROOT, ".uploads", "work", owner), { recursive: true, force: true });
      await db.$disconnect();
      console.log(`[restart-e2e] runner logs: ${logDir}`);
    }
  });

  test("a stop signal while a browser call's process runs: the runner drains, and the run is not continued", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)", timeout: 300_000 }, async () => {
    // The browser call's process is a stand-in for Chromium
    // (WORK_BROWSER_EXECUTABLE): it marks that it started, then waits. Two ways
    // the stop reaches the runner:
    //   - to the runner and every process under it (PM2's default treekill, a
    //     host shutdown, a terminal's Ctrl-C): the browser's process dies with
    //     it, the call ends early with an ordinary failure, and the run then
    //     reaches its step boundary;
    //   - to the runner alone (juno-work's `treekill: false`): Playwright's own
    //     SIGINT handler, which closed every browser and exited 130 at once,
    //     is off, so the runner waits for the call (here it fails by itself
    //     after 3 s), drains, and exits 0.
    // Either way the boundary follows a call the stop may have reached, so the
    // run ends `interrupted` and is never set aside for the next runner.
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/work/store");
    const restart = await import("../src/lib/work/restart-resume");

    const requests: number[] = [];
    const lab: Server = createServer((req, res) => {
      void readBody(req).then((body) => {
        let results = 0;
        for (const message of (body.messages ?? []) as Array<{ content: unknown }>) {
          if (Array.isArray(message.content)) results += (message.content as Block[]).filter((block) => block.type === "tool_result").length;
        }
        requests.push(results);
        if (results === 0) return sse(res, { tool: { name: "browser", input: { action: "open", url: "https://example.com/" } } });
        return sse(res, { text: "Opened the page." });
      }, () => {
        res.writeHead(400);
        res.end();
      });
    });
    await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
    const port = (lab.address() as AddressInfo).port;

    const logDir = process.env.RESTART_E2E_LOG_DIR ?? path.join(tmpdir(), "restart-e2e-logs");
    mkdirSync(logDir, { recursive: true });
    const scratch = mkdtempSync(path.join(tmpdir(), "restart-browser-"));
    const sleepBin = ["/bin/sleep", "/usr/bin/sleep"].find((candidate) => existsSync(candidate));
    assert.ok(sleepBin, "a sleep binary");
    const fakeBrowser = (name: string, script: (marker: string) => string) => {
      const marker = path.join(scratch, `${name}-started`);
      const file = path.join(scratch, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\n: > '${marker}'\n${script(marker)}\n`);
      chmodSync(file, 0o755);
      return { file, marker };
    };

    const owner = `restart-browser-${randomUUID()}`;
    const runners: ChildProcess[] = [];
    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });

      const cases = [
        {
          name: "tree",
          browser: fakeBrowser("tree", () => `exec ${sleepBin} 120`),
          stop: (pid: number) => treeKill(pid, "SIGINT"),
          minMs: 0,
        },
        {
          name: "runner-only",
          browser: fakeBrowser("runner-only", () => `${sleepBin} 3\nexit 1`),
          stop: (pid: number) => process.kill(pid, "SIGINT"),
          minMs: 2_000,
        },
      ];
      for (const scenario of cases) {
        requests.length = 0;
        const session = await store.createWorkSession({ userId: owner, title: scenario.name, goal: "Open example.com and read it.", requestedTarget: "cloud" });
        const created = await store.createRun({
          sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
          permissionPolicy: { policy: "permissive", attended: false } as never,
          budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
          idempotencyKey: `restart-browser:${scenario.name}:${randomUUID()}`,
        });
        await db.workSession.update({ where: { id: session.id }, data: { status: "queued" } });
        const runId = created.run.id;

        const runner = spawnRunner({ name: `runner-browser-${scenario.name}`, port, logDir, stepWaitMs: 20_000, runners, env: { WORK_BROWSER_EXECUTABLE: scenario.browser.file } });
        await waitFor(`the ${scenario.name} browser call to start its process`, async () => (existsSync(scenario.browser.marker) ? true : null), logDir, 150_000);
        const signalledAt = Date.now();
        scenario.stop(runner.child.pid!);
        const exit = await runner.exited;
        const tookMs = exit.at - signalledAt;
        assert.equal(exit.code, 0, `${scenario.name}: the runner drained and exited by itself (log: ${runner.logFile})`);
        assert.ok(tookMs >= scenario.minMs && tookMs < 20_000, `${scenario.name}: it waited for the call, inside the step wait: ${tookMs} ms`);

        const ended = await db.workRun.findUniqueOrThrow({ where: { id: runId } });
        assert.deepEqual(
          [ended.status, ended.terminalReason, ended.terminalDetail, ended.pauseReason],
          ["interrupted", "interrupted", restart.RESTART_TOOL_CUT_DETAIL, null],
          `${scenario.name} (log: ${runner.logFile})`
        );
        assert.notEqual(ended.checkpoint, null, "its progress is kept for the person");
        const paused = await db.workEvent.findMany({ where: { runId, kind: "paused" } });
        assert.equal((paused[0]?.payload as { cause?: string } | undefined)?.cause, "server_restart_tool_cut", scenario.name);
        assert.equal(await db.workEvent.count({ where: { runId, kind: "run_finished" } }), 1);
        const browserCalls = (await db.workEvent.findMany({ where: { runId, kind: "tool_finished" } })).filter((e) => (e.payload as { tool?: string }).tool === "browser");
        assert.equal(browserCalls.length, 1, `${scenario.name}: the browser call ended and was recorded`);
        assert.deepEqual(requests, [0], `${scenario.name}: the step after the browser call never went out`);

        // The next runner finds nothing of it to continue.
        const next = await restart.resumeRunsParkedForRestart({ executorId: "restart-browser:next", enabled: true });
        assert.ok(!next.requeued.includes(runId) && !next.ended.some((row) => row.runId === runId));
        assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: runId } })).status, "interrupted");
      }
    } finally {
      for (const child of runners) if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => lab.close(() => resolve()));
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
      await db.$disconnect();
      console.log(`[restart-browser] runner logs: ${logDir}`);
    }
  });
}
