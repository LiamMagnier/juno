import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SHUTDOWN_STEP_WAIT_MS,
  HARD_STOP_GRACE_MS,
  RESTART_PARK_MESSAGE,
  RESTART_PAUSED_COPY,
  RunRestartSignal,
  SHUTDOWN_EXIT_MARGIN_MS,
  drainRuns,
  fittedShutdownStepWaitMs,
  pauseAtStepBoundary,
  restartCheckpointVerdict,
  restartResumeEnabled,
  RESTART_PAUSE_REASON,
  shutdownExitDeadlineMs,
  shutdownStepWaitMs,
  toolRunsInChildProcess,
} from "../src/lib/work/restart-resume-rules";
import { GOAL_WAITING_FOR_ANSWER, GOAL_WAITING_FOR_RESTART, planGoalStep, type GoalTaskView, type GoalView } from "../src/lib/agents/goals";

/*
 * A cloud Work run across a restart of its runner
 * (src/lib/work/restart-resume-rules.ts): it is stopped at a step boundary and
 * set aside, and continued only when its checkpoint shows nothing in flight.
 * The last two tests drive the real agent runtime (runner/agent-core/dist) with
 * a scripted model: no provider is called.
 */

const RUN = "run_restart";

function checkpoint(messages: unknown[]) {
  return { runId: RUN, version: 1, messages, plan: { steps: [] }, budget: {}, seq: 0 };
}
const goal = { role: "user", content: [{ type: "text", text: "Send the note." }] };
const call = (id: string, name = "send_note") => ({ type: "tool_call", id, name, input: {} });
const result = (id: string, content: string) => ({ type: "tool_result", toolCallId: id, content });

test("a checkpoint is clean only when the last step's tool results are all recorded", () => {
  assert.deepEqual(restartCheckpointVerdict(null, RUN), { clean: false, why: "missing" });
  assert.deepEqual(restartCheckpointVerdict({ ...checkpoint([goal]), version: 2 }, RUN), { clean: false, why: "unreadable" });
  assert.deepEqual(restartCheckpointVerdict(checkpoint([goal]), "another_run"), { clean: false, why: "unreadable" });
  assert.deepEqual(restartCheckpointVerdict({ ...checkpoint([goal]), plan: null }, RUN), { clean: false, why: "unreadable" });

  // Nothing asked for yet, or the model was answering in words.
  assert.deepEqual(restartCheckpointVerdict(checkpoint([goal]), RUN), { clean: true });
  assert.deepEqual(
    restartCheckpointVerdict(checkpoint([goal, { role: "assistant", content: [{ type: "text", text: "Done." }] }]), RUN),
    { clean: true }
  );
  // A finished step: every call answered with a real result.
  assert.deepEqual(
    restartCheckpointVerdict(
      checkpoint([goal, { role: "assistant", content: [call("a"), call("b")] }, { role: "user", content: [result("a", "sent"), result("b", "ok")] }]),
      RUN
    ),
    { clean: true }
  );
  // A call the model asked for whose result is not there: it may be running.
  assert.deepEqual(
    restartCheckpointVerdict(checkpoint([goal, { role: "assistant", content: [call("a")] }]), RUN),
    { clean: false, why: "unanswered_call" }
  );
  assert.deepEqual(
    restartCheckpointVerdict(
      checkpoint([goal, { role: "assistant", content: [call("a"), call("b")] }, { role: "user", content: [result("a", "sent")] }]),
      RUN
    ),
    { clean: false, why: "unanswered_call" }
  );
  // A tool cut short, or never started because the run stopped: in flight.
  for (const stopped of ["Stopped before this finished.", "Cancelled.", "Not started — the run stopped first."]) {
    assert.deepEqual(
      restartCheckpointVerdict(
        checkpoint([goal, { role: "assistant", content: [call("a"), call("b")] }, { role: "user", content: [result("a", "sent"), result("b", stopped)] }]),
        RUN
      ),
      { clean: false, why: "tool_in_flight" },
      stopped
    );
  }
});

test("the switch is on unless said otherwise, and the step wait is bounded", () => {
  assert.equal(restartResumeEnabled(undefined), true);
  assert.equal(restartResumeEnabled(""), true);
  assert.equal(restartResumeEnabled("1"), true);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(restartResumeEnabled(off), false, off);
  assert.equal(shutdownStepWaitMs(undefined), DEFAULT_SHUTDOWN_STEP_WAIT_MS);
  assert.equal(shutdownStepWaitMs("nonsense"), DEFAULT_SHUTDOWN_STEP_WAIT_MS);
  assert.equal(shutdownStepWaitMs("2.5"), DEFAULT_SHUTDOWN_STEP_WAIT_MS);
  assert.equal(shutdownStepWaitMs("10"), 1_000);
  assert.equal(shutdownStepWaitMs("30000"), 30_000);
  assert.equal(shutdownStepWaitMs("99999999"), 5 * 60_000);
});

test("the owner's switches are documented where the owner looks", () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const example = read(".env.example");
  const decisions = read("docs/OPEN_DECISIONS.md");
  for (const name of ["WORK_RESUME_AFTER_RESTART", "WORK_SHUTDOWN_STEP_WAIT_MS", "SWEEPERS_RUN_WORK_SCHEDULER"]) {
    assert.match(example, new RegExp(`# ${name}="`), name);
    assert.match(decisions, new RegExp(name), name);
  }
  // The runner reads them through the rules, and parks only at a boundary.
  const runner = read("scripts/work-runner.ts");
  assert.match(runner, /enabled: restartResumeEnabled\(\)/);
  assert.match(runner, /const configuredStepWaitMs = shutdownStepWaitMs\(\);/);
  assert.match(runner, /const stepWaitMs = fittedShutdownStepWaitMs\(configuredStepWaitMs\);/);
  assert.match(runner, /if \(outcome\.restart === "boundary"\) \{/);
  assert.match(runner, /outcome\.paused && \(outcome\.restart === "mid_step" \|\| outcome\.restart === "cut_short"\)/);
  // Every tool call is reported to the run's restart signal.
  assert.match(runner, /if \(event\.kind === "tool_started"\) input\.restart\.toolStarted\(event\.callId, event\.tool\);/);
  assert.match(runner, /else if \(event\.kind === "tool_finished"\) input\.restart\.toolFinished\(event\.callId, event\.isError\);/);
  // A claim in hand is waited for by the drain.
  assert.match(runner, /remaining: \(\) => active\.size \+ claimsInHand,/);
});

function fakeProvider() {
  const requests: Array<{ cacheKey?: string }> = [];
  return {
    requests,
    provider: {
      id: "fake",
      name: "Fake",
      defaultModel: "fake-1",
      models: () => ["fake-1"],
      capabilities: () => ({}),
      async *stream(request: { cacheKey?: string }) {
        requests.push(request);
        yield { type: "done" as const };
      },
    },
  };
}

async function drain(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test("the boundary wrapper stops only the run's own next step, once, and never after a hard stop", async () => {
  const { provider, requests } = fakeProvider();
  const signal = new RunRestartSignal();
  let paused = 0;
  const wrapped = pauseAtStepBoundary(provider, {
    runId: RUN,
    signal,
    pause: () => {
      paused += 1;
    },
    park: () => new Error(RESTART_PARK_MESSAGE),
  });

  await drain(wrapped.stream({ cacheKey: RUN }));
  assert.equal(requests.length, 1, "no shutdown: the step goes out");

  signal.request();
  // A delegated child's request and a context summary carry another key or none.
  await drain(wrapped.stream({ cacheKey: `${RUN}:d1` }));
  await drain(wrapped.stream({}));
  assert.equal(requests.length, 3, "a child finishes the step it is part of");
  assert.equal(paused, 0);

  await assert.rejects(drain(wrapped.stream({ cacheKey: RUN })), new RegExp(RESTART_PARK_MESSAGE));
  assert.equal(paused, 1);
  assert.equal(requests.length, 3, "nothing went out for the step that did not start");
  assert.equal(signal.outcome(), "boundary");
  signal.stopNow();
  assert.equal(signal.outcome(), "boundary", "a run already set aside is not stopped again");

  const hard = new RunRestartSignal();
  let stopped = 0;
  hard.onHardStop(() => {
    stopped += 1;
    return true;
  });
  hard.stopNow();
  assert.equal(hard.outcome(), "mid_step");
  const wrappedHard = pauseAtStepBoundary(provider, { runId: RUN, signal: hard, pause: () => assert.fail("no boundary after a hard stop"), park: () => new Error("x") });
  await drain(wrappedHard.stream({ cacheKey: RUN }));
  assert.equal(stopped, 1);

  const early = new RunRestartSignal();
  early.stopNow();
  assert.equal(early.outcome(), null, "no session yet: nothing to stop, the boundary does it");
  assert.equal(early.requested, true);
});

test("the drain waits for the step, stops what is still inside one, and is bounded", async () => {
  let clock = 0;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const quick = new RunRestartSignal();
  const slow = new RunRestartSignal();
  slow.onHardStop(() => true);
  const live = new Set([quick, slow]);
  // `quick` reaches its boundary after 2 s; `slow` never does on its own.
  const result = await drainRuns({
    signals: () => live,
    remaining: () => {
      if (clock >= 2_000) live.delete(quick);
      if (slow.hardStopApplied && clock >= 12_000) live.delete(slow);
      return live.size;
    },
    stepWaitMs: 10_000,
    hardStopGraceMs: 8_000,
    pollMs: 500,
    now: () => clock,
    sleep,
  });
  assert.equal(quick.requested, true);
  assert.equal(quick.hardStopApplied, false, "a run that reached its boundary is never stopped mid-step");
  assert.equal(slow.hardStopApplied, true);
  assert.equal(result.stoppedMidStep, 1);
  assert.equal(result.left, 0);
  assert.ok(result.waitedMs <= 18_000, `bounded: ${result.waitedMs}`);

  clock = 0;
  const stuck = new RunRestartSignal();
  const bounded = await drainRuns({ signals: () => [stuck], remaining: () => 1, stepWaitMs: 1_000, hardStopGraceMs: 500, pollMs: 100, now: () => clock, sleep });
  assert.equal(bounded.left, 1, "a run that never unwinds is left to its lease");
  assert.ok(bounded.waitedMs >= 1_500 && bounded.waitedMs <= 1_700, String(bounded.waitedMs));
});

test("a claim still in hand when the shutdown began is waited for like a run in flight", async () => {
  // scripts/work-runner.ts counts `claimsInHand` in `remaining`: a claim that
  // lands after the drain began becomes a run that starts already asked to
  // stop, and the drain does not finish before it is set aside.
  let clock = 0;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const active = new Map<string, RunRestartSignal>();
  let claimsInHand = 1;
  const result = await drainRuns({
    signals: () => active.values(),
    remaining: () => {
      if (claimsInHand === 1 && clock >= 1_000) {
        claimsInHand = 0;
        active.set("late", new RunRestartSignal(true));
      }
      const late = active.get("late");
      if (late && clock >= 2_000) {
        assert.equal(late.requested, true, "it starts already asked to stop");
        late.pausedAtBoundary = true;
        active.delete("late");
      }
      return active.size + claimsInHand;
    },
    stepWaitMs: 10_000,
    hardStopGraceMs: 1_000,
    pollMs: 250,
    now: () => clock,
    sleep,
  });
  assert.equal(result.left, 0);
  assert.equal(result.stoppedMidStep, 0);
  assert.ok(result.waitedMs >= 2_000 && result.waitedMs < 3_000, `waited for the late claim: ${result.waitedMs}`);
});

test("the step wait fits inside the kill_timeout PM2 hands the runner", () => {
  // Outside PM2, or unreadable: as configured.
  assert.equal(fittedShutdownStepWaitMs(45_000, undefined), 45_000);
  assert.equal(fittedShutdownStepWaitMs(45_000, ""), 45_000);
  assert.equal(fittedShutdownStepWaitMs(45_000, "soon"), 45_000);
  assert.equal(fittedShutdownStepWaitMs(45_000, "0"), 45_000);
  // juno-work's 60 s leaves the default alone.
  assert.equal(fittedShutdownStepWaitMs(DEFAULT_SHUTDOWN_STEP_WAIT_MS, "60000"), DEFAULT_SHUTDOWN_STEP_WAIT_MS);
  // A wait raised to 5 min without raising kill_timeout is cut to what fits.
  assert.equal(fittedShutdownStepWaitMs(300_000, "60000"), 60_000 - HARD_STOP_GRACE_MS - SHUTDOWN_EXIT_MARGIN_MS);
  // PM2's own 1.6 s leaves no room: stop mid-step at once rather than be killed.
  assert.equal(fittedShutdownStepWaitMs(45_000, "1600"), 0);
});

test("a tick stuck past the drain does not keep the runner alive until PM2's SIGKILL", () => {
  // The runner exits at this deadline once the drain has resolved, whether or
  // not its main loop's tick has returned. Fitted, it is inside kill_timeout.
  for (const killTimeout of ["60000", "30000", "12000", "1600"]) {
    const deadline = shutdownExitDeadlineMs(fittedShutdownStepWaitMs(DEFAULT_SHUTDOWN_STEP_WAIT_MS, killTimeout));
    if (Number(killTimeout) >= HARD_STOP_GRACE_MS + SHUTDOWN_EXIT_MARGIN_MS) {
      assert.ok(deadline < Number(killTimeout), `${killTimeout}: exits at ${deadline} ms`);
    }
  }
  assert.equal(shutdownExitDeadlineMs(45_000), 45_000 + HARD_STOP_GRACE_MS + SHUTDOWN_EXIT_MARGIN_MS / 2);
  // And the runner wires it: armed when the drain starts, exiting only after the drain.
  const runner = readFileSync(new URL("../scripts/work-runner.ts", import.meta.url), "utf8");
  assert.match(
    runner,
    /setTimeout\(\(\) => void drain\.then\(\(\) => exitAfterDrain\(\{ tickStillRunning: true \}\)\), shutdownExitDeadlineMs\(stepWaitMs\)\)\.unref\(\);/
  );
});

test("a goal whose step is set aside for a restart says so, and does not ask the person to resume it", () => {
  const goal: GoalView = {
    id: "g1", title: "Ship the note", detail: "", status: "active", milestones: [{ id: "a", title: "Write it", done: false }],
    successCriteria: [], budgetMicroUsd: null, spentMicroUsd: 0, maxRuns: 6, runsUsed: 1, maxAttemptsPerStep: 2, dueAt: null, cadence: "none",
  };
  const task = (partial: Partial<GoalTaskView>): GoalTaskView => ({
    sessionId: "s1", stepKey: "a", status: "running", attempt: 1, acted: false, costMicroUsd: 0, createdAt: new Date("2026-10-27T10:00:00Z"), ...partial,
  });
  const now = new Date("2026-10-27T11:00:00Z");
  const line = (partial: Partial<GoalTaskView>) => planGoalStep(goal, [task(partial)], now).nextAction;
  assert.equal(line({ status: "paused", pauseReason: RESTART_PAUSE_REASON }), GOAL_WAITING_FOR_RESTART);
  assert.doesNotMatch(GOAL_WAITING_FOR_RESTART, /resume/i);
  assert.equal(planGoalStep(goal, [task({ status: "paused", pauseReason: RESTART_PAUSE_REASON })], now).kind, "idle");
  // The others are unchanged.
  assert.equal(line({ status: "paused", pauseReason: "user" }), "Paused on the current step; resume it to continue");
  assert.equal(line({ status: "paused", pauseReason: "waiting" }), GOAL_WAITING_FOR_ANSWER);
  assert.equal(line({ status: "running" }), "Working on the current step");
});

test("a heartbeat write that hangs or throws does not hold the drain past its deadline", async () => {
  const stuck = new RunRestartSignal();
  const started = Date.now();
  const hung = await drainRuns({
    signals: () => [stuck],
    remaining: () => 1,
    stepWaitMs: 200,
    hardStopGraceMs: 100,
    pollMs: 20,
    onPollTimeoutMs: 30,
    // A write that waits on a database that never answers.
    onPoll: () => new Promise<void>(() => {}),
  });
  const took = Date.now() - started;
  assert.equal(hung.left, 1);
  assert.ok(took >= 290 && took < 700, `bounded by the wait and the grace: ${took} ms`);

  let polls = 0;
  const thrown = await drainRuns({
    signals: () => [new RunRestartSignal()],
    remaining: () => (polls >= 3 ? 0 : 1),
    stepWaitMs: 1_000,
    hardStopGraceMs: 100,
    pollMs: 5,
    onPoll: () => {
      polls += 1;
      throw new Error("database gone");
    },
  });
  assert.equal(thrown.left, 0, "a throwing write is ignored and the drain goes on");
  assert.equal(thrown.stoppedMidStep, 0);
});

test("a step boundary after a tool call the restart may have reached is not a clean stop", () => {
  assert.ok(toolRunsInChildProcess("browser"));
  assert.ok(toolRunsInChildProcess("computer_shell"));
  assert.ok(toolRunsInChildProcess("computer_click"));
  assert.ok(!toolRunsInChildProcess("cloud_files"));
  assert.ok(!toolRunsInChildProcess("web_fetch"));
  assert.ok(!toolRunsInChildProcess("run_code"), "a sandbox on the execution host, reached over HTTP");

  const atBoundary = (signal: RunRestartSignal) => {
    signal.pausedAtBoundary = true;
    return signal.outcome();
  };

  // Running when the restart was asked for, then failed.
  const failed = new RunRestartSignal();
  failed.toolStarted("c1", "cloud_files");
  failed.request();
  failed.toolFinished("c1", true);
  assert.equal(atBoundary(failed), "cut_short");
  assert.deepEqual(failed.cutShort, { callId: "c1", tool: "cloud_files" });

  // Running then in a child process: whatever it reported ("exit 130" is not an error).
  const child = new RunRestartSignal();
  child.toolStarted("c1", "computer_shell");
  child.request();
  child.toolFinished("c1", false);
  assert.equal(atBoundary(child), "cut_short");

  // A child-process call that started after the restart was asked for and failed.
  const later = new RunRestartSignal();
  later.request();
  later.toolStarted("c2", "browser");
  later.toolFinished("c2", true);
  assert.equal(atBoundary(later), "cut_short");

  // Clean: a call running then that finished well, outside any child process;
  // a call that failed before the restart; a later call that failed in-process;
  // a later child-process call that finished well.
  const clean = new RunRestartSignal();
  clean.toolStarted("c0", "browser");
  clean.toolFinished("c0", true);
  clean.toolStarted("c1", "cloud_files");
  clean.request();
  clean.toolFinished("c1", false);
  clean.toolStarted("c2", "web_fetch");
  clean.toolFinished("c2", true);
  clean.toolStarted("c3", "computer_screenshot");
  clean.toolFinished("c3", false);
  assert.equal(atBoundary(clean), "boundary");
  assert.equal(clean.cutShort, null);

  // A run claimed once the shutdown began has nothing running to doubt.
  const claimedLate = new RunRestartSignal(true);
  claimedLate.toolStarted("c1", "cloud_files");
  claimedLate.toolFinished("c1", false);
  assert.equal(atBoundary(claimedLate), "boundary");

  // Stopped mid-step stays mid-step.
  const hard = new RunRestartSignal();
  hard.toolStarted("c1", "computer_shell");
  hard.onHardStop(() => true);
  hard.stopNow();
  assert.equal(hard.outcome(), "mid_step");
});

// ---------------------------------------------------------------------------
// The real runtime: a run mid-step parks at the boundary, and resumes once
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const distReady = existsSync(path.join(ROOT, "runner/agent-core/dist/work/index.js"));
type Runtime = typeof import("../runner/agent-core/src/work/index.js");
const loadRuntime = async (): Promise<Runtime> =>
  (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

/** One side-effecting tool whose calls are counted, and held until released. */
function heldTool(runtime: Runtime) {
  const state = { runs: 0, hold: null as null | { release: () => void; fail: (error: Error) => void }, started: null as null | (() => void) };
  const tool = {
    spec: { name: "send_note", description: "Send a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    kind: "read" as const,
    tier: "connector" as const,
    intents: ["send_note"],
    intentFor: () => "send_note",
    actionFor: () => "send_note",
    riskFor: () => "low" as const,
    provenanceFor: () => ({ source: "test", sourceKind: "user" as const, action: "send_note", untrusted: false }),
    summarize: () => "Send a note",
    async execute() {
      state.runs += 1;
      state.started?.();
      await new Promise<void>((resolve, reject) => {
        state.hold = { release: resolve, fail: reject };
      });
      return { output: "sent" };
    },
  };
  void runtime;
  return { tool, state };
}

function scriptedModel(options: { twoSends?: boolean } = {}) {
  let turns = 0;
  const provider = {
    id: "fake",
    name: "Fake",
    defaultModel: "fake-1",
    models: () => ["fake-1"],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 200_000, streaming: true, mcp: false }),
    async *stream() {
      turns += 1;
      if (turns === 1) {
        yield { type: "tool_call" as const, id: "tc_plan", name: "update_plan", input: { stepId: "send", status: "active" } };
        yield { type: "tool_call" as const, id: "tc_send", name: "send_note", input: { text: "hello" } };
        if (options.twoSends) yield { type: "tool_call" as const, id: "tc_send_2", name: "send_note", input: { text: "again" } };
      } else if (turns === 2) {
        yield { type: "tool_call" as const, id: "tc_done", name: "update_plan", input: { stepId: "send", status: "done" } };
      } else {
        yield { type: "text_delta" as const, text: "Sent the note." };
      }
      yield {
        type: "done" as const,
        stopReason: turns <= 2 ? ("tool_use" as const) : ("end_turn" as const),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { provider, turns: () => turns };
}

/**
 * The session's options. With `signal`, its tool events feed the restart
 * signal the way the runner's `onEvent` does (scripts/work-runner.ts).
 */
function sessionOptions(runtime: Runtime, provider: unknown, tool: unknown, events: string[], signal?: RunRestartSignal) {
  return {
    runId: RUN,
    goal: "Send the note.",
    provider: provider as never,
    model: "fake-1",
    cwd: "/tmp",
    tools: [tool as never],
    budget: runtime.NO_BUDGET,
    approvalMode: "permissive" as const,
    callbacks: {
      onEvent: (event: { kind: string; callId?: string; tool?: string; isError?: boolean }) => {
        if (event.kind === "tool_started") signal?.toolStarted(event.callId!, event.tool!);
        else if (event.kind === "tool_finished") signal?.toolFinished(event.callId!, event.isError === true);
        events.push(event.kind);
      },
      requestApproval: async () => "allowed" as const,
      askQuestion: async () => "ok",
    },
  };
}

test("a run mid-step finishes the step, parks at the boundary with a clean checkpoint, and resumes once", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)" }, async () => {
  const runtime = await loadRuntime();
  const { tool, state } = heldTool(runtime);
  const model = scriptedModel();
  const signal = new RunRestartSignal();
  const events: string[] = [];
  let session: InstanceType<Runtime["WorkAgentSession"]> | null = null;
  const provider = pauseAtStepBoundary(model.provider, {
    runId: RUN,
    signal,
    pause: () => session!.pause(RESTART_PAUSED_COPY),
    park: () => new runtime.WorkRunParked(RESTART_PARK_MESSAGE),
  });
  session = new runtime.WorkAgentSession({
    ...sessionOptions(runtime, provider, tool, events, signal),
    plan: new runtime.WorkPlan([{ id: "send", title: "Send the note" }]),
  });

  const started = new Promise<void>((resolve) => {
    state.started = resolve;
  });
  const running = session.run();
  await started;
  // The shutdown arrives while the step's tool call is in flight; the call
  // runs in this process and finishes well, so the boundary is clean.
  signal.request();
  state.hold!.release();
  const parked = await running;

  assert.equal(parked.state, "paused");
  assert.equal(signal.outcome(), "boundary");
  assert.equal(model.turns(), 1, "the next step's request never went out");
  assert.equal(state.runs, 1);
  assert.ok(!events.includes("error"), `no error row: ${events.join(",")}`);
  assert.ok(events.includes("paused"));
  if (parked.state !== "paused") return;
  const snapshot = JSON.parse(JSON.stringify(parked.checkpoint)) as unknown;
  assert.deepEqual(restartCheckpointVerdict(snapshot, RUN), { clean: true }, "the step's results are all recorded");
  const messages = (snapshot as { messages: Array<{ role: string; content: Array<{ type: string; content?: string }> }> }).messages;
  const last = messages[messages.length - 1]!;
  assert.equal(last.role, "user");
  const results = last.content.filter((part) => part.type === "tool_result").map((part) => part.content);
  assert.equal(results.length, 2, "both calls of the step are answered");
  assert.equal(results[1], "sent", "with the tool's own result");

  // The next runner: restored from the checkpoint, no shutdown this time.
  const next = new RunRestartSignal();
  let restored: InstanceType<Runtime["WorkAgentSession"]> | null = null;
  const resumedEvents: string[] = [];
  const resumedProvider = pauseAtStepBoundary(model.provider, {
    runId: RUN,
    signal: next,
    pause: () => restored!.pause(RESTART_PAUSED_COPY),
    park: () => new runtime.WorkRunParked(RESTART_PARK_MESSAGE),
  });
  restored = runtime.WorkAgentSession.restore(snapshot as never, sessionOptions(runtime, resumedProvider, tool, resumedEvents));
  const finished = await restored.run();
  assert.equal(finished.state, "finished");
  assert.equal(resumedEvents[0], "resumed");
  assert.equal(state.runs, 1, "the side-effecting call is not repeated");
  assert.equal(model.turns(), 3, "it carried on from the next step");
  if (finished.state === "finished") assert.equal(finished.terminalReason, "completed", finished.detail);
});

test("a run stopped while a tool is in flight is a mid-step stop, and its checkpoint is not clean", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)" }, async () => {
  // The runner decides on the outcome, not on the checkpoint's shape: a run
  // stopped mid-step ends `interrupted` there and is never parked for the next
  // runner (scripts/work-runner.ts, `drive`), because a tool that gave up
  // part-way may record its own error text, which no shape can tell from a
  // finished call. The checkpoint check is the second line, for the calls the
  // loop itself answers: here the second call of the step, never started.
  const runtime = await loadRuntime();
  const { tool, state } = heldTool(runtime);
  const model = scriptedModel({ twoSends: true });
  const signal = new RunRestartSignal();
  const events: string[] = [];
  const provider = pauseAtStepBoundary(model.provider, {
    runId: RUN,
    signal,
    pause: () => session.pause(RESTART_PAUSED_COPY),
    park: () => new runtime.WorkRunParked(RESTART_PARK_MESSAGE),
  });
  const session = new runtime.WorkAgentSession({
    ...sessionOptions(runtime, provider, tool, events, signal),
    plan: new runtime.WorkPlan([{ id: "send", title: "Send the note" }]),
  });
  signal.onHardStop(() => {
    session.pause("Stopped in the middle of a step for a server restart.");
    return true;
  });

  const started = new Promise<void>((resolve) => {
    state.started = resolve;
  });
  const running = session.run();
  await started;
  // The wait ran out with the tool still running: stopped where it is, and
  // the tool, told to stop, gives up part-way.
  signal.request();
  signal.stopNow();
  state.hold!.fail(new Error("aborted"));
  const stopped = await running;

  assert.equal(stopped.state, "paused");
  assert.equal(signal.outcome(), "mid_step");
  if (stopped.state !== "paused") return;
  const verdict = restartCheckpointVerdict(JSON.parse(JSON.stringify(stopped.checkpoint)), RUN);
  assert.deepEqual(verdict, { clean: false, why: "tool_in_flight" });
  assert.equal(state.runs, 1, "the second call never started");
  assert.equal(model.turns(), 1);
});

test("a command the restart's signal reached is not taken for a finished step, though its checkpoint looks clean", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)" }, async () => {
  // What PM2's default treekill did to juno-work (the review of 2026-10-30): the
  // stop signal reached a computer command's `docker exec` client too, the
  // client exited 130 while the runner was still letting the step finish, the
  // tool reported that exit as an ordinary result, and the run reached its
  // step boundary with a checkpoint no shape check can fault. A real child
  // process here, interrupted the way TreeKill interrupts it.
  const runtime = await loadRuntime();
  const state = { runs: 0, started: null as null | ((pid: number) => void) };
  const tool = {
    spec: { name: "computer_shell", description: "Run a command.", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    kind: "read" as const,
    tier: "connector" as const,
    intents: ["computer_shell"],
    intentFor: () => "computer_shell",
    actionFor: () => "computer_shell",
    riskFor: () => "low" as const,
    provenanceFor: () => ({ source: "test", sourceKind: "user" as const, action: "computer_shell", untrusted: false }),
    summarize: () => "Run a command",
    async execute() {
      state.runs += 1;
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      state.started?.(child.pid!);
      const code = await new Promise<number>((resolve) =>
        child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal === "SIGINT" ? 130 : 1)))
      );
      // As the computer tools report a command: its exit code, not an error.
      return { output: `exit ${code}` };
    },
  };
  const provider = {
    ...scriptedModel().provider,
    async *stream() {
      // One step: start the command. Any later step must not be reached.
      yield { type: "tool_call" as const, id: "tc_shell", name: "computer_shell", input: { command: "make deploy" } };
      yield { type: "done" as const, stopReason: "tool_use" as const, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const signal = new RunRestartSignal();
  const events: string[] = [];
  let session: InstanceType<Runtime["WorkAgentSession"]> | null = null;
  const wrapped = pauseAtStepBoundary(provider, {
    runId: RUN,
    signal,
    pause: () => session!.pause(RESTART_PAUSED_COPY),
    park: () => new runtime.WorkRunParked(RESTART_PARK_MESSAGE),
  });
  session = new runtime.WorkAgentSession({
    ...sessionOptions(runtime, wrapped, tool, events, signal),
    plan: new runtime.WorkPlan([{ id: "run", title: "Run the command" }]),
  });
  const started = new Promise<number>((resolve) => {
    state.started = resolve;
  });
  const running = session.run();
  const pid = await started;
  signal.request();
  process.kill(pid, "SIGINT");
  const parked = await running;

  assert.equal(parked.state, "paused");
  assert.equal(signal.pausedAtBoundary, true, "it did reach its step boundary");
  assert.equal(signal.outcome(), "cut_short", "but it is not a clean stop");
  assert.deepEqual(signal.cutShort, { callId: "tc_shell", tool: "computer_shell" });
  assert.equal(state.runs, 1);
  if (parked.state !== "paused") return;
  // The checkpoint alone would have let it be continued: which is why the
  // runner decides on the outcome (scripts/work-runner.ts, `drive`).
  assert.deepEqual(restartCheckpointVerdict(JSON.parse(JSON.stringify(parked.checkpoint)), RUN), { clean: true });
});
