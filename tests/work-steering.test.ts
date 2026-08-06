import { test } from "node:test";
import assert from "node:assert/strict";
import { WORK_CONTRACT, summaryFor } from "@/lib/work/contract";
import {
  WORK_COMMAND_KINDS,
  WORK_EVENT_KINDS,
  WORK_STEERING_EVENT_KIND,
  defaultVisibilityFor,
  isWorkEventKind,
  steeringInstruction,
  workSteeringPayload,
} from "@/lib/work/domain";
import {
  COMMAND_KIND_PROTOCOL,
  RELAY_PROTOCOL_VERSION,
  hostUnderstands,
  planRunCommand,
  runCommandKey,
  supportedCommandKinds,
} from "@/lib/work/relay";
import { serializeCommandForHost, serializeCommandForRemote } from "@/lib/work/serializers";
import {
  evaluateConnector,
  summarizeConnectors,
  type WorkConnectorAllowlist,
  type WorkConnectorCandidate,
  type WorkConnectorDescriptor,
  type WorkConnectorState,
} from "@/lib/work/connectors";

/*
 * Two things that were built one layer short, and the layer.
 *
 * Steering: the user types an instruction mid-run, the route records it, and
 * until now nothing on the executing side ever read it back — the response said
 * `delivered: false` and meant it. What is under test here is the vocabulary and
 * the reader, which is where the delivery either survives a mixed fleet or does
 * not: the instruction now travels as `user_message`, but the log already holds
 * rows written as `question_answered` with a `steering` marker, and a Mac or a
 * phone on an older build still writes them. A reader that knew only the new
 * kind would silently stop delivering the instructions those clients send.
 *
 * The second half of that delivery is the `steer` command, which is what
 * reaches a run executing on somebody's Mac — the cloud runner polls the log and
 * a Mac reads nothing, so for local runs the log was where the instruction
 * stopped. The command's own hazards are the ones checked below: a Mac too old
 * to parse it has to be refused where the person pressing the button is still
 * listening, and the sentence has to reach the host while the phone that sent it
 * gets no more than it already had.
 *
 * Connectors: a per-task selection is only a permission if something refuses on
 * the strength of it. The narrowing is checked here against the layers it sits
 * inside, because the property that matters is not that it narrows but that it
 * can only ever narrow.
 */

// ---------------------------------------------------------------------------
// The event kind
// ---------------------------------------------------------------------------

test("the steering kind is a member of the vocabulary rather than a string a route invented", () => {
  assert.equal(WORK_STEERING_EVENT_KIND, "user_message");
  assert.ok(WORK_EVENT_KINDS.includes(WORK_STEERING_EVENT_KIND));
  assert.ok(isWorkEventKind("user_message"));
  // The default is `internal`, so a kind missing from the visibility table is
  // written to the log and never shown to the person who typed it.
  assert.equal(defaultVisibilityFor(WORK_STEERING_EVENT_KIND), "user");
});

test("the clients are told about the steering kind, in the same words and with the same visibility", () => {
  const entry = WORK_CONTRACT.vocabularies.eventKinds.values.find(
    (value) => value.value === WORK_STEERING_EVENT_KIND
  );
  assert.ok(entry, "the contract has no user_message; the Mac and the phone would drop the row");
  assert.equal(entry.visibility, defaultVisibilityFor(WORK_STEERING_EVENT_KIND));
  assert.ok((summaryFor("eventKinds", "user_message") ?? "").length > 0);
});

// ---------------------------------------------------------------------------
// Reading an instruction back
// ---------------------------------------------------------------------------

test("what the route writes is what the executor reads", () => {
  const payload = workSteeringPayload("  Use the March figures, not February.  ", "web");
  assert.equal(
    steeringInstruction({ kind: WORK_STEERING_EVENT_KIND, payload }),
    "Use the March figures, not February."
  );
  // The old fields are still on the payload. A client that renders a steer by
  // looking for `steering` and `text` — every build shipped before this kind
  // existed — keeps working against the new one.
  assert.equal(payload.steering, true);
  assert.equal(payload.answeredVia, "web");
});

test("an instruction written under the old kind is still an instruction", () => {
  assert.equal(
    steeringInstruction({
      kind: "question_answered",
      payload: { text: "Skip the appendix.", answeredVia: "macos", steering: true },
    }),
    "Skip the appendix."
  );
});

test("an answer is never read as an instruction, whichever kind it arrives under", () => {
  // `pollAnswer` in scripts/work-runner.ts matches on the question id. Anything
  // carrying one belongs to that path alone; delivering it here as well would
  // put the answer to a question in front of the model a second time, as though
  // the user had volunteered it.
  assert.equal(
    steeringInstruction({
      kind: "question_answered",
      payload: { questionId: "call_1", text: "Yes, the second one.", answeredVia: "web" },
    }),
    null
  );
  assert.equal(
    steeringInstruction({
      kind: WORK_STEERING_EVENT_KIND,
      payload: { questionId: "call_1", text: "Yes, the second one.", steering: true },
    }),
    null
  );
  // Neither an id nor a marker: a malformed answer rather than an instruction,
  // and feeding it to the model would be putting words in the user's mouth.
  assert.equal(
    steeringInstruction({ kind: "question_answered", payload: { text: "Yes." } }),
    null
  );
});

test("nothing else in the stream is mistaken for something the user said", () => {
  for (const kind of WORK_EVENT_KINDS) {
    if (kind === WORK_STEERING_EVENT_KIND || kind === "question_answered") continue;
    assert.equal(
      steeringInstruction({ kind, payload: { text: "Not a user turn.", steering: true } }),
      null,
      `${kind} was read as an instruction`
    );
  }
  assert.equal(steeringInstruction({ kind: WORK_STEERING_EVENT_KIND, payload: null }), null);
  assert.equal(steeringInstruction({ kind: WORK_STEERING_EVENT_KIND, payload: {} }), null);
  // Whitespace is not an instruction. An empty user turn in the transcript is a
  // turn the model has to interpret, and there is nothing there to interpret.
  assert.equal(
    steeringInstruction({ kind: WORK_STEERING_EVENT_KIND, payload: workSteeringPayload("   ", "web") }),
    null
  );
});

// ---------------------------------------------------------------------------
// Reaching a run that is executing on a Mac
// ---------------------------------------------------------------------------

test("steering is a command kind the whole vocabulary agrees on", () => {
  assert.ok(WORK_COMMAND_KINDS.includes("steer"));
  // A kind the contract does not carry is a kind the Mac and the phone cannot
  // name, which is the failure the generated Swift enum exists to prevent.
  const entry = WORK_CONTRACT.vocabularies.commandKinds.values.find(
    (value) => value.value === "steer"
  );
  assert.ok(entry, "the contract has no steer; the Mac's enum would not have the case");
  assert.ok((summaryFor("commandKinds", "steer") ?? "").length > 0);
});

test("a Mac that predates steering is refused rather than sent one", () => {
  // The generation the grant and undo instructions shipped in. A build of that
  // vintage holds a live model loop that was handed its goal at start and
  // re-reads nothing, so handing it a `steer` is handing it something it can
  // only refuse — once per re-lease, until the TTL runs out.
  assert.equal(hostUnderstands("steer", 2), false);
  assert.equal(hostUnderstands("steer", RELAY_PROTOCOL_VERSION), true);
  assert.ok(COMMAND_KIND_PROTOCOL.steer <= RELAY_PROTOCOL_VERSION);
  assert.ok(!supportedCommandKinds(2).includes("steer"));
  assert.ok(supportedCommandKinds(RELAY_PROTOCOL_VERSION).includes("steer"));

  const host = { id: "host_1", enabled: true, revokedAt: null, protocolVersion: 2 };
  const refused = planRunCommand({ effectiveTarget: "local", host, kind: "steer" });
  assert.equal(refused.plan, "refuse");
  // Refused at enqueue, so the route can answer `delivered: false` with a
  // sentence naming the reason instead of promising a delivery to a Mac that
  // will never make one.
  assert.equal(refused.plan === "refuse" && refused.refusal.code, "work_host_unknown_command");
  assert.equal(refused.plan === "refuse" && refused.refusal.retryable, false);

  assert.deepEqual(
    planRunCommand({
      effectiveTarget: "local",
      host: { ...host, protocolVersion: RELAY_PROTOCOL_VERSION },
      kind: "steer",
    }),
    { plan: "enqueue", hostId: "host_1" }
  );
});

test("a cloud run is still nobody's Mac to tell", () => {
  // The cloud path must be untouched by any of this: the runner drains the log
  // it is already reading, and a command queued for a host that is not executing
  // the run would sit unclaimed until it expired.
  assert.deepEqual(
    planRunCommand({ effectiveTarget: "cloud", host: null, kind: "steer" }),
    { plan: "skip", why: "not_local" }
  );
  assert.deepEqual(
    planRunCommand({ effectiveTarget: null, host: null, kind: "steer" }),
    { plan: "skip", why: "not_local" }
  );
});

test("two instructions are two commands, and one retried is one", () => {
  // The route derives the discriminator from whatever deduplicated the event:
  // the caller's key when it sent one, and the seq of the row it wrote when it
  // did not. Two identical sentences typed a minute apart are two deliberate
  // instructions and must not collapse into one command.
  assert.notEqual(runCommandKey("run_1", "steer", 41), runCommandKey("run_1", "steer", 42));
  assert.equal(
    runCommandKey("run_1", "steer", "client-key-1"),
    runCommandKey("run_1", "steer", "client-key-1")
  );
  // And an answer to a question is never the same instruction as a steer, even
  // on the same run.
  assert.notEqual(runCommandKey("run_1", "steer", 7), runCommandKey("run_1", "answer", 7));
});

const STEER_COMMAND = {
  id: "cmd_1",
  userId: "user_1",
  hostId: "host_1",
  sessionId: "sess_1",
  runId: "run_1",
  kind: "steer",
  payload: { text: "Use the March figures, not February." },
  payloadVersion: 1,
  status: "succeeded",
  result: { delivered: true, runId: "run_1" },
  error: null,
  idempotencyKey: "work:run:run_1:steer:42",
  expiresAt: new Date("2026-08-05T12:05:00.000Z"),
  leaseExpiresAt: null,
  attempts: 1,
  createdAt: new Date("2026-08-05T12:00:00.000Z"),
  claimedAt: new Date("2026-08-05T12:00:01.000Z"),
  completedAt: new Date("2026-08-05T12:00:02.000Z"),
} as unknown as Parameters<typeof serializeCommandForHost>[0];

test("the instruction reaches the Mac, which is the only shape that has to carry it", () => {
  // The one thing this command is for. A payload filtered on the way to the host
  // is a command the Mac claims, finds empty, and refuses — and the person is
  // told their sentence could not be acted on for no stated reason.
  assert.deepEqual(serializeCommandForHost(STEER_COMMAND).payload, {
    text: "Use the March figures, not February.",
  });
});

test("a phone reading the command back learns nothing the Mac invented", () => {
  const remote = serializeCommandForRemote(STEER_COMMAND);
  // The text came from a client in the first place, so echoing it discloses
  // nothing — and withholding it would leave the sender rendering its owner's
  // own instruction as an empty row.
  assert.deepEqual(remote.payload, { text: "Use the March figures, not February." });
  // Whether the Mac took it is the command's status. A second field saying so
  // would be a second place for it to disagree with the first.
  assert.deepEqual(remote.result, {});
  assert.deepEqual(remote.redacted, ["delivered", "runId"]);
});

// ---------------------------------------------------------------------------
// Per-task connectors
// ---------------------------------------------------------------------------

const github: WorkConnectorDescriptor = {
  id: "github",
  label: "GitHub",
  locality: "cloud",
  configured: true,
  intents: ["repo.read"],
  scope: {
    reads: ["repositories"],
    writes: ["issues"],
    sensitivity: "confidential",
    egress: "third_party",
  },
};

const mail: WorkConnectorDescriptor = {
  id: "apple-mail",
  label: "Apple Mail",
  locality: "cloud",
  configured: true,
  intents: ["email.search"],
  scope: {
    reads: ["mail"],
    writes: ["drafts"],
    sensitivity: "restricted",
    egress: "juno_cloud",
  },
};

const linked: WorkConnectorState = { linked: true, credentialUsable: true };

const candidates: readonly WorkConnectorCandidate[] = [
  { descriptor: github, state: linked },
  { descriptor: mail, state: linked },
];

function admitted(allowlist?: WorkConnectorAllowlist): string[] {
  return summarizeConnectors(candidates, allowlist)
    .filter((entry) => entry.available)
    .map((entry) => entry.connectorId);
}

test("a task that was never asked keeps whatever the account allows", () => {
  // Null, not empty. Every session created before the control existed, every
  // schedule and every native client lands here, and narrowing them to nothing
  // would take connectors away from tasks that have been using them.
  assert.deepEqual(admitted({ taskAllowed: null }), ["github", "apple-mail"]);
  assert.deepEqual(admitted(undefined), ["github", "apple-mail"]);
});

test("a task reaches the apps it was given and no others", () => {
  assert.deepEqual(admitted({ taskAllowed: ["github"] }), ["github"]);
  // The composer's default: shown the list, turned nothing on. An empty
  // selection is an answer, and the answer is none.
  assert.deepEqual(admitted({ taskAllowed: [] }), []);
});

test("the refusal says which one it is, and is worth a security row", () => {
  const verdict = evaluateConnector(mail, linked, { taskAllowed: ["github"] });
  assert.equal(verdict.available, false);
  assert.equal(verdict.reason, "not_selected_for_task");
  assert.match(verdict.explanation, /not switched on for this task/);
  // A verdict with no sentence is a drop, and a run that cannot say why it did
  // not read the mailbox reports a job half done as a job done.
  assert.equal(verdict.degradation?.subject, "apple-mail");
  assert.equal(verdict.audit?.kind, "policy_narrowed");
  assert.equal(verdict.audit?.detail.reason, "not_selected_for_task");
});

test("a task selection only ever narrows: it cannot reopen what a wider layer closed", () => {
  const blocked = evaluateConnector(github, linked, {
    adminBlocked: ["github"],
    taskAllowed: ["github"],
  });
  assert.equal(blocked.available, false);
  // The sentence names the thing the reader can act on. "Not switched on for
  // this task" over an administrator's block would send them to tick a box that
  // changes nothing.
  assert.equal(blocked.reason, "blocked_by_admin");

  const outsideUserList = evaluateConnector(mail, linked, {
    userAllowed: ["github"],
    taskAllowed: ["github", "apple-mail"],
  });
  assert.equal(outsideUserList.reason, "not_on_user_allowlist");
});

test("being selected is permission, not availability", () => {
  // The one failure this must not paper over: a connector the reader switched on
  // whose credential has expired is unavailable and has to say so. Selection
  // decides what a task MAY reach; the state decides what it can.
  const verdict = evaluateConnector(
    github,
    { linked: true, credentialUsable: false },
    { taskAllowed: ["github"] }
  );
  assert.equal(verdict.available, false);
  assert.equal(verdict.reason, "credential_unusable");
});
