import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  approvalCommandKey,
  hostTerminalReport,
  planHostOutbox,
  planRunCommand,
  runCommandKey,
  startCommandPayload,
  type CommandHostView,
} from "@/lib/work/relay";

/*
 * The two seams that decide whether "Work on the Mac" exists at all.
 *
 * Outward: a run dispatched to a local host has to become a `start` command in
 * that Mac's queue. It did not, for the whole life of the feature — the
 * enqueue route was the only writer of the queue and no dispatch path called
 * it, so the Mac long-polled correctly and forever for an instruction nobody
 * had written, and the user watched a task sit at `queued` until the lease
 * sweep called it interrupted.
 *
 * Inward: a `run_finished` the Mac drains out of its outbox has to end the run.
 * `appendEvents` writes the transcript and never touches `WorkRun.status`, so
 * the transcript said the task was over and the run stayed live behind it.
 *
 * Both failures are invisible from either side. The Mac's logs show a clean
 * poll loop; the web shows a spinner; nothing is refused, nothing errors, and
 * every row involved is individually correct. So the decisions are pinned here
 * as functions of their arguments, and the writes they turn into are pinned in
 * the database section at the bottom.
 */

const host = (over: Partial<CommandHostView> = {}): CommandHostView => ({
  id: "host_1",
  enabled: true,
  revokedAt: null,
  protocolVersion: 2,
  ...over,
});

// ---------------------------------------------------------------------------
// What the Mac is handed
// ---------------------------------------------------------------------------

test("a start payload carries the goal under the key the Mac actually reads", () => {
  const payload = startCommandPayload({ goal: "Sort every PDF in Downloads by year.", model: "anthropic:claude-sonnet-5" });

  // `DesktopWorkRunHost.startRun` reads `payload["goal"]` (falling back to
  // `payload["prompt"]`) and throws `noGoal` when neither is there. A start
  // without it is a command the Mac claims, refuses and acknowledges as failed,
  // which reaches the user as a task that broke on arrival for no stated reason.
  assert.equal(payload.goal, "Sort every PDF in Downloads by year.");
  assert.equal(payload.model, "anthropic:claude-sonnet-5");
  assert.equal(
    "prompt" in payload,
    false,
    "the fallback key exists for older hosts; writing both would be two places for one sentence to differ"
  );
});

test("a start payload omits the model rather than sending a null one", () => {
  const payload = startCommandPayload({ goal: "Tidy the Q3 folder.", model: null });
  // The Mac's `request.payload["model"]?.stringValue ?? defaultModelID` only
  // falls back on a MISSING key. A null decodes as a value and leaves it
  // driving a model called nothing.
  assert.equal("model" in payload, false);
  assert.equal(startCommandPayload({ goal: "g", model: "" }).model, undefined);
  assert.equal(startCommandPayload({ goal: "g" }).model, undefined);
});

test("a long goal reaches the Mac whole", () => {
  const goal = "Reconcile the ledger. ".repeat(1_000);
  assert.equal(
    startCommandPayload({ goal }).goal,
    goal,
    "truncating to fit a notional wire bound would silently change what the run was asked to do"
  );
});

// ---------------------------------------------------------------------------
// Whether an intent becomes an instruction
// ---------------------------------------------------------------------------

test("a run dispatched to a Mac plans exactly one command, at that Mac", () => {
  const plan = planRunCommand({ effectiveTarget: "local", host: host(), kind: "start" });
  assert.deepEqual(plan, { plan: "enqueue", hostId: "host_1" });
});

test("a cloud run plans no command at all", () => {
  // Not an error and not a refusal. The cloud executor finds its work by
  // polling for queued runs; a caller that read "no command" as a failure would
  // refuse a dispatch that is going perfectly well.
  assert.deepEqual(planRunCommand({ effectiveTarget: "cloud", host: null, kind: "start" }), {
    plan: "skip",
    why: "not_local",
  });
  // A host row is present and the run is still cloud — a session with a
  // preferred Mac whose work needed nothing local. Still nothing to send.
  assert.deepEqual(planRunCommand({ effectiveTarget: "cloud", host: host(), kind: "start" }), {
    plan: "skip",
    why: "not_local",
  });
  // Never dispatched, so there is no target yet and nothing to instruct.
  assert.deepEqual(planRunCommand({ effectiveTarget: null, host: host(), kind: "stop" }), {
    plan: "skip",
    why: "not_local",
  });
});

test("a local run whose Mac has gone is skipped rather than refused", () => {
  // The host row was deleted between dispatch and this instruction. There is
  // nothing to instruct and nobody to refuse; the run's lease sweep ends it.
  assert.deepEqual(planRunCommand({ effectiveTarget: "local", host: null, kind: "pause" }), {
    plan: "skip",
    why: "no_host",
  });
});

test("a kind the host's build cannot parse is refused, never queued", () => {
  // `undo` is generation 2. A Mac that registered at generation 1 has no parser
  // for it, and a command it cannot read is one it refuses on every re-lease
  // until the TTL expires — so the answer has to be no here, at enqueue, where
  // the person who pressed the button is still listening.
  const refused = planRunCommand({
    effectiveTarget: "local",
    host: host({ protocolVersion: 1 }),
    kind: "undo",
  });
  assert.equal(refused.plan, "refuse");
  assert.equal(refused.plan === "refuse" && refused.refusal.code, "work_host_unknown_command");
  assert.equal(refused.plan === "refuse" && refused.refusal.status, 409);
  assert.equal(
    refused.plan === "refuse" && refused.refusal.retryable,
    false,
    "the answer changes when the Mac is updated, not when the request is repeated"
  );

  // The same Mac one generation later parses it.
  assert.deepEqual(planRunCommand({ effectiveTarget: "local", host: host(), kind: "undo" }), {
    plan: "enqueue",
    hostId: "host_1",
  });
});

test("every kind the control surface sends is parseable by the oldest host", () => {
  // start, pause, resume, stop, answer, approve and deny are all generation 1.
  // If any of them were not, an account that has never updated its Mac would
  // find the buttons on its own run silently doing nothing.
  for (const kind of ["start", "pause", "resume", "stop", "answer", "approve", "deny"] as const) {
    assert.deepEqual(
      planRunCommand({ effectiveTarget: "local", host: host({ protocolVersion: 1 }), kind }),
      { plan: "enqueue", hostId: "host_1" },
      `${kind} must reach a host that has never been updated`
    );
  }
});

test("a revoked or switched-off Mac is told nothing", () => {
  const revoked = planRunCommand({
    effectiveTarget: "local",
    host: host({ revokedAt: new Date("2026-08-05T12:00:00.000Z") }),
    kind: "stop",
  });
  assert.equal(revoked.plan === "refuse" && revoked.refusal.code, "work_host_revoked");

  const off = planRunCommand({
    effectiveTarget: "local",
    host: host({ enabled: false }),
    kind: "start",
  });
  assert.equal(off.plan === "refuse" && off.refusal.code, "work_host_not_enabled");
});

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

test("start and stop take one key per run, for all time", () => {
  // A run is started once and finished once — `finishRun` sees to the second —
  // so the run id alone names the instruction. A random key would make every
  // retry a second start, and two loops sharing one approval coordinator each
  // act on the other's answers.
  assert.equal(runCommandKey("run_a", "start"), runCommandKey("run_a", "start"));
  assert.notEqual(runCommandKey("run_a", "start"), runCommandKey("run_b", "start"));
  assert.notEqual(runCommandKey("run_a", "start"), runCommandKey("run_a", "stop"));
});

test("pause and resume take a key per transition, not per run", () => {
  // Discriminated by the sequence of the transcript event that recorded the
  // transition. Without it the third pause folds into the first, and the upsert
  // answers with a command the Mac carried out an hour ago.
  assert.notEqual(runCommandKey("run_a", "pause", 12), runCommandKey("run_a", "pause", 44));
  assert.equal(runCommandKey("run_a", "pause", 12), runCommandKey("run_a", "pause", 12));
  assert.notEqual(runCommandKey("run_a", "pause", 12), runCommandKey("run_a", "resume", 12));
});

test("an approval key names the answer as well as the question", () => {
  assert.notEqual(approvalCommandKey("ap_1", "allowed"), approvalCommandKey("ap_1", "denied"));
  assert.equal(approvalCommandKey("ap_1", "allowed"), approvalCommandKey("ap_1", "allowed"));
  assert.notEqual(approvalCommandKey("ap_1", "allowed"), approvalCommandKey("ap_2", "allowed"));
});

test("every derived key clears the floor a client key has to clear", () => {
  // Eight characters, the bound `enqueueCommandSchema` puts on a client-minted
  // key. These do not go through that schema, but a key shorter than the ones
  // it refuses would be a key nobody could defend.
  for (const key of [
    runCommandKey("r", "start"),
    runCommandKey("r", "pause", 1),
    approvalCommandKey("a", "denied"),
  ]) {
    assert.ok(key.length >= 8 && key.length <= 200, key);
  }
});

// ---------------------------------------------------------------------------
// The ending, as the Mac reports it
// ---------------------------------------------------------------------------

test("a batch with no ending in it ends nothing", () => {
  assert.equal(hostTerminalReport([]), null);
  assert.equal(
    hostTerminalReport([
      { kind: "run_started", payload: {} },
      { kind: "assistant_message", payload: { text: "Working on it." } },
    ]),
    null
  );
});

test("an error mid-run is not an ending", () => {
  // Both the Mac and the cloud runtime emit one and carry on. A relay that
  // ended a run on the first error would stop a task over a tool call that
  // recovered on the next turn.
  assert.equal(hostTerminalReport([{ kind: "error", payload: { message: "connection reset" } }]), null);
});

test("the Mac's four outcomes each land on a reason somebody can act on", () => {
  const of = (payload: Record<string, unknown>) => hostTerminalReport([{ kind: "run_finished", payload }]);

  assert.deepEqual(of({ outcome: "succeeded", reason: "Finished." }), {
    reason: "completed",
    detail: "Finished.",
  });
  assert.deepEqual(of({ outcome: "failed", reason: "The folder is no longer shared." }), {
    reason: "failed",
    detail: "The folder is no longer shared.",
  });
  // `stopped` is only ever reached by carrying out a `stop`, which a person
  // asked for.
  assert.deepEqual(of({ outcome: "stopped", reason: "You stopped this task." }), {
    reason: "cancelled",
    detail: "You stopped this task.",
  });
  assert.deepEqual(
    of({ outcome: "truncated", reason: "This task reached the limit of 64 steps and stopped." }),
    {
      reason: "failed",
      detail: "This task reached the limit of 64 steps and stopped.",
    }
  );
});

test("hitting the Mac's step ceiling is not a budget the user can raise", () => {
  const report = hostTerminalReport([
    { kind: "run_finished", payload: { outcome: "truncated", reason: "Reached 64 steps." } },
  ]);
  assert.notEqual(
    report?.reason,
    "budget_exceeded",
    "nothing was over an account ceiling, and saying so sends the reader to raise a limit that was never the problem"
  );
  assert.notEqual(
    report?.reason,
    "completed",
    "a run that stopped at step sixty-four has not answered the goal, and a green tick over it is the one outcome nobody can act on"
  );
});

test("the reason field is read as a verdict only when it is one", () => {
  // `scripts/work-runner.ts` sends `{ reason: <terminal reason> }`; the Mac
  // sends `{ outcome, reason: <a sentence> }`. Guessing the other way files
  // every local run under a terminal reason called "Finished.".
  assert.deepEqual(hostTerminalReport([{ kind: "run_finished", payload: { reason: "timed_out" } }]), {
    reason: "timed_out",
    detail: null,
  });
  assert.deepEqual(
    hostTerminalReport([{ kind: "run_finished", payload: { outcome: "succeeded", reason: "Finished." } }]),
    { reason: "completed", detail: "Finished." }
  );
});

test("an explicit terminalReason outranks everything else in the payload", () => {
  // `agent-core` emits this shape. It is already in the vocabulary, so nothing
  // else in the payload gets a say.
  assert.deepEqual(
    hostTerminalReport([
      {
        kind: "run_finished",
        payload: {
          terminalReason: "budget_exceeded",
          outcome: "succeeded",
          detail: "The run passed its cost ceiling mid-turn.",
        },
      },
    ]),
    { reason: "budget_exceeded", detail: "The run passed its cost ceiling mid-turn." }
  );
});

test("an ending this build cannot name is failed, never completed", () => {
  // A newer Mac reporting an outcome this relay has no case for. The run is
  // over either way — that is what the event says — and of the two mislabels,
  // "we cannot say this worked" is the one a reader can act on.
  assert.deepEqual(hostTerminalReport([{ kind: "run_finished", payload: { outcome: "vaporised" } }]), {
    reason: "failed",
    detail: null,
  });
  assert.deepEqual(hostTerminalReport([{ kind: "run_finished", payload: {} }]), {
    reason: "failed",
    detail: null,
  });
  assert.deepEqual(hostTerminalReport([{ kind: "run_finished" }]), { reason: "failed", detail: null });
});

test("the first ending in a batch wins, matching finishRun", () => {
  // `finishRun`'s WHERE excludes every terminal status, so the first writer to
  // commit decides why the run ended. Reading the last one here and the first
  // one there would be two rules for one question.
  assert.deepEqual(
    hostTerminalReport([
      { kind: "run_finished", payload: { outcome: "failed", reason: "Disk full." } },
      { kind: "assistant_message", payload: { text: "…" } },
      { kind: "run_finished", payload: { outcome: "succeeded", reason: "Finished." } },
    ]),
    { reason: "failed", detail: "Disk full." }
  );
});

test("terminal detail is bounded, because it is operator prose and not a transcript", () => {
  const report = hostTerminalReport([
    { kind: "run_finished", payload: { outcome: "failed", reason: "x".repeat(50_000) } },
  ]);
  assert.equal(report?.detail?.length, 4_000);
});

/*
 * Everything above is a decision over its arguments. What follows is the claim
 * that those decisions become the right rows, and it can only be settled by a
 * database: that a local dispatch writes exactly one command in the same
 * transaction as the run, that a cloud dispatch writes none, and that a second
 * terminal event cannot re-finish a run.
 *
 * Skipped unless WORK_TEST_DATABASE_URL names a throwaway database, for the
 * reason tests/work-store-db.test.ts gives: a suite that silently connects to
 * whatever DATABASE_URL happens to be set is a suite that one day truncates
 * something real. Run it with:
 *
 *   createdb worktest && DATABASE_URL=… npx prisma migrate deploy
 *   WORK_TEST_DATABASE_URL=postgresql://…/worktest \
 *     NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --test tests/work-relay-dispatch.test.ts
 */

const DB_URL = process.env.WORK_TEST_DATABASE_URL;

if (!DB_URL) {
  test("the dispatch database suite is skipped without WORK_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  // Imported inside the first test rather than at module scope: tsx compiles
  // this file to CJS, where a top-level await is a syntax error.
  type Store = typeof import("@/lib/work/store");
  let store!: Store;

  const EMAIL = "work-dispatch-test@example.invalid";
  const GOAL = "Sort every PDF in Downloads into folders by year.";

  let userId = "";
  let sessionId = "";
  let hostId = "";
  let oldHostId = "";

  test("set up a throwaway account, session and two Macs", async () => {
    store = await import("@/lib/work/store");
    await prisma.user.deleteMany({ where: { email: EMAIL } });

    const user = await prisma.user.create({ data: { email: EMAIL, name: "Work dispatch test" } });
    userId = user.id;

    const session = await store.createWorkSession({
      userId,
      title: "Organise Downloads",
      goal: GOAL,
      requestedTarget: "local",
    });
    sessionId = session.id;

    // A Work host hangs off a paired `CodeDevice`, one host per device, so the
    // pairing has to exist before the Mac can be registered against it.
    const pair = async (name: string) =>
      (await prisma.codeDevice.create({ data: { userId, name } })).id;

    const current = await prisma.workHost.create({
      data: {
        userId,
        deviceId: await pair("Studio"),
        displayName: "Studio",
        protocolVersion: 2,
        enabled: true,
        allowsFileWork: true,
      },
    });
    hostId = current.id;

    const old = await prisma.workHost.create({
      data: {
        userId,
        deviceId: await pair("The one nobody updates"),
        displayName: "The one nobody updates",
        // Generation 1: every control instruction reaches it, `undo` does not.
        protocolVersion: 1,
        enabled: true,
        allowsFileWork: true,
      },
    });
    oldHostId = old.id;
  });

  test("a dispatch to a Mac writes exactly one start command, carrying the goal", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "local",
      effectiveTarget: "local",
      hostId,
      effectiveModel: "anthropic:claude-sonnet-5",
      command: {
        hostId,
        kind: "start",
        payload: startCommandPayload({ goal: GOAL, model: "anthropic:claude-sonnet-5" }),
      },
    });

    const commands = await prisma.workCommand.findMany({ where: { runId: run.id } });
    assert.equal(commands.length, 1, "one run, one instruction that drives it");

    const [command] = commands;
    assert.equal(command.kind, "start");
    assert.equal(command.hostId, hostId);
    assert.equal(command.sessionId, sessionId);
    assert.equal(command.status, "pending", "written unclaimed, for the Mac's next poll to take");
    assert.deepEqual(command.payload, { goal: GOAL, model: "anthropic:claude-sonnet-5" });
    assert.ok(
      command.expiresAt > new Date(),
      "a command that is born expired is one the polling Mac filters out on arrival"
    );
    assert.equal(
      command.idempotencyKey,
      runCommandKey(run.id, "start"),
      "derived from the run, so a retry can only ever resolve to this row"
    );
  });

  test("a dispatch to cloud writes no command", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "automatic",
      effectiveTarget: "cloud",
    });
    assert.equal(
      await prisma.workCommand.count({ where: { runId: run.id } }),
      0,
      "there is no Mac to instruct, and a command with no host is one nothing can claim"
    );
  });

  test("a control instruction reaches the Mac executing the run", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "local",
      effectiveTarget: "local",
      hostId,
    });

    const first = await store.dispatchRunCommand({
      userId,
      sessionId,
      runId: run.id,
      hostId,
      effectiveTarget: "local",
      kind: "pause",
      idempotencyKey: runCommandKey(run.id, "pause", 7),
    });
    assert.equal(first.status, "queued");

    // The same transition twice — a phone whose response was lost, retrying.
    const again = await store.dispatchRunCommand({
      userId,
      sessionId,
      runId: run.id,
      hostId,
      effectiveTarget: "local",
      kind: "pause",
      idempotencyKey: runCommandKey(run.id, "pause", 7),
    });
    assert.equal(
      again.status === "queued" && again.command.id,
      first.status === "queued" && first.command.id,
      "the key names one logical instruction; a second row would pause the run twice"
    );
    assert.equal(await prisma.workCommand.count({ where: { runId: run.id, kind: "pause" } }), 1);
  });

  test("a kind the Mac cannot parse is refused rather than queued", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "local",
      effectiveTarget: "local",
      hostId: oldHostId,
    });

    const result = await store.dispatchRunCommand({
      userId,
      sessionId,
      runId: run.id,
      hostId: oldHostId,
      effectiveTarget: "local",
      kind: "undo",
      idempotencyKey: runCommandKey(run.id, "undo", 1),
    });

    assert.equal(result.status, "refused");
    assert.equal(result.status === "refused" && result.refusal.code, "work_host_unknown_command");
    assert.equal(
      await prisma.workCommand.count({ where: { runId: run.id } }),
      0,
      "a queued command this host can never parse is one it refuses on every re-lease until the TTL expires"
    );
  });

  test("a terminal event from the Mac ends the run, and a re-delivery does not re-end it", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "local",
      effectiveTarget: "local",
      hostId,
    });
    await prisma.workRun.updateMany({ where: { id: run.id }, data: { status: "running" } });

    const batch = [
      { seq: 1, kind: "assistant_message" as const, payload: { text: "Done." }, eventKey: "e:1" },
      {
        seq: 2,
        kind: "run_finished" as const,
        payload: { outcome: "succeeded", reason: "Finished." },
        eventKey: "e:2",
      },
    ];

    // The route's own sequence: plan the batch, append what it accepted, then
    // read the ending out of everything ahead of the gap.
    const drain = async (afterSeq: number) => {
      const keys = batch.map((event) => event.eventKey);
      const stored = await prisma.workEvent.findMany({
        where: { runId: run.id, userId, eventKey: { in: keys } },
        select: { eventKey: true },
      });
      const plan = planHostOutbox({
        acknowledgedSeq: afterSeq,
        events: batch,
        seenKeys: new Set(stored.map((row) => row.eventKey).filter((key): key is string => key !== null)),
      });
      if (plan.accepted.length) {
        await store.appendEvents({
          runId: run.id,
          userId,
          events: plan.accepted.map((event) => ({
            kind: event.kind,
            payload: event.payload,
            key: event.eventKey,
          })),
        });
      }
      const report = hostTerminalReport([...plan.accepted, ...plan.duplicates]);
      assert.ok(report, "the ending has to be visible on a re-delivery too, or a lost finish is permanent");
      return store.finishRun({ runId: run.id, userId, reason: report.reason, detail: report.detail });
    };

    const first = await drain(0);
    assert.equal(first.finished, true);
    assert.equal(first.finished && first.status, "completed");

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(stored.status, "completed");
    assert.equal(stored.terminalReason, "completed");
    assert.equal(stored.terminalDetail, "Finished.");
    assert.equal(
      stored.leaseExpiresAt,
      null,
      "released, so the stalled-run sweep does not go looking for an executor that has gone home"
    );

    // The same batch again: the drain committed and the acknowledgement was
    // lost. Every event is recognised as a re-delivery and none is appended a
    // second time, and the finish is attempted anyway — which is what repairs a
    // process torn down between the append and the finish — and refused,
    // because `finishRun` is write-once.
    const second = await drain(0);
    assert.equal(second.finished, false);
    assert.equal(
      await prisma.workEvent.count({ where: { runId: run.id } }),
      2,
      "a re-delivered batch must not append the transcript twice"
    );

    const after = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(after.status, "completed", "a late writer must not rewrite why a run ended");
    assert.equal(after.terminalReason, "completed");
  });

  test("a run that another writer already cancelled is not re-ended by its Mac", async () => {
    const { run } = await store.createRun({
      sessionId,
      userId,
      requestedTarget: "local",
      effectiveTarget: "local",
      hostId,
    });
    await prisma.workRun.updateMany({ where: { id: run.id }, data: { status: "running" } });

    // The phone's cancel wins the race, and the Mac's `run_finished` arrives a
    // moment later reporting that it stopped.
    const cancelled = await store.finishRun({ runId: run.id, userId, reason: "cancelled" });
    assert.equal(cancelled.finished, true);

    const report = hostTerminalReport([
      { kind: "run_finished", payload: { outcome: "stopped", reason: "You stopped this task." } },
    ]);
    assert.ok(report);
    const late = await store.finishRun({
      runId: run.id,
      userId,
      reason: report.reason,
      detail: report.detail,
    });
    assert.equal(late.finished, false, "the run had already ended, and the first writer decided why");

    const after = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(after.status, "cancelled");
    assert.equal(after.terminalDetail, null, "the cancel carried no detail, and the late writer added none");
  });

  test("tear down", async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });
}
