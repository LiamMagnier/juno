import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROPOSAL_RUN_BUDGET_MICRO_USD,
  MAX_PROPOSALS_PER_TURN,
  PROPOSE_ROUTINE_TOOL_ID,
  admitRoutineProposal,
  defaultRunBudget,
  proposalFromTask,
  readRoutineProposal,
  routineInstructionsFromGoal,
  routineProposalKey,
  routineScheduleBody,
  runBudgetFromUsd,
  type RoutineProposalContext,
} from "@/lib/work/routine-proposal";
import { createScheduleSchema, parseScheduleListQuery } from "@/lib/work/schedule";
import { normalizeTriggerDrafts } from "@/lib/work/triggers";
import { composeTaskGoal } from "@/lib/chat/task-tool";
import {
  PROPOSE_ROUTINE_TOOL,
  chatRoutineToolEnabled,
  createProposeRoutineTool,
  describeRoutineOutcome,
  routineProposalActivity,
  type RoutineToolGate,
} from "@/lib/chat/routine-tool";
import { PROPOSE_ROUTINE_DESCRIPTION } from "@/lib/tools/specs/propose-routine.prompt";

/*
 * Routines drafted in chat (G07): what the model may put in front of the
 * person, what the card sends when they press Schedule, and when the tool is
 * offered at all. Nothing here creates anything; the route does, on a press.
 */

const NOW = new Date("2026-10-15T19:00:00Z");

function ctx(overrides: Partial<RoutineProposalContext> = {}): RoutineProposalContext {
  return {
    key: routineProposalKey("msg-1", 0),
    now: NOW,
    defaultTimezone: "Europe/Paris",
    connectors: [
      { id: "composio:gmail", label: "Gmail" },
      { id: "apple-mail", label: "Apple Mail" },
    ],
    untrusted: false,
    estimateCostMicroUsd: () => 210_000,
    ...overrides,
  };
}

const ARGS = {
  name: "Morning inbox summary",
  instructions: "Summarise the new mail in my inbox since yesterday: who wrote, what they need, and anything urgent first.",
  schedule: "every weekday at 8am",
};

test("a well-formed draft becomes a card with its schedule, next runs, cost and safe defaults", () => {
  const admitted = admitRoutineProposal({ ...ARGS, apps: ["gmail"] }, ctx());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const p = admitted.proposal;
  assert.equal(p.key, "routine-proposal:msg-1:0");
  assert.equal(p.schedule.kind, "weekdays");
  assert.deepEqual(p.schedule.config, { hour: 8, minute: 0 });
  assert.equal(p.schedule.summary, "Every weekday at 08:00");
  assert.equal(p.timezone, "Europe/Paris");
  assert.deepEqual(p.nextRuns, ["2026-10-16T06:00:00.000Z", "2026-10-19T06:00:00.000Z", "2026-10-20T06:00:00.000Z"]);
  assert.deepEqual(p.apps, [{ id: "composio:gmail", label: "Gmail" }]);
  assert.deepEqual(p.missingApps, []);
  assert.equal(p.estimatedCostMicroUsd, 210_000);
  // Three times the estimate, rounded up to a quarter, never below a dollar.
  assert.equal(p.maxCostMicroUsd, 1_000_000);
  assert.equal(p.notifyPolicy, "on_finish");
  assert.equal(p.fromOutsideContent, false);
});

test("the schedule, the name and the instructions are all required, and the refusal says why", () => {
  for (const missing of ["name", "instructions", "schedule"] as const) {
    const args: Record<string, unknown> = { ...ARGS };
    delete args[missing];
    const admitted = admitRoutineProposal(args, ctx());
    assert.equal(admitted.ok, false, missing);
    assert.equal(!admitted.ok && admitted.reason, "invalid_arguments");
  }
  const once = admitRoutineProposal({ ...ARGS, schedule: "tomorrow at 9am" }, ctx());
  assert.equal(!once.ok && once.reason, "schedule_not_recurring");
  const busy = admitRoutineProposal({ ...ARGS, schedule: "every 10 minutes" }, ctx());
  assert.equal(!busy.ok && busy.reason, "schedule_too_frequent");
  assert.match(!busy.ok ? busy.message : "", /at most once an hour/);
  const long = admitRoutineProposal({ ...ARGS, instructions: "x".repeat(8_001) }, ctx());
  assert.equal(!long.ok && long.reason, "instructions_too_long");
});

test("hostile outside content gets no card; ordinary outside content gets a marked one", () => {
  const hostile = admitRoutineProposal(ARGS, ctx({ untrusted: true, hostile: true }));
  assert.equal(!hostile.ok && hostile.reason, "outside_content");
  const read = admitRoutineProposal(ARGS, ctx({ untrusted: true }));
  assert.equal(read.ok && read.proposal.fromOutsideContent, true);
});

test("apps match by id or label, and the ones that are not connected are named", () => {
  const admitted = admitRoutineProposal({ ...ARGS, apps: ["Apple Mail", "Slack", "GMAIL"] }, ctx());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.deepEqual(admitted.proposal.apps.map((app) => app.id).sort(), ["apple-mail", "composio:gmail"]);
  assert.deepEqual(admitted.proposal.missingApps, ["Slack"]);
});

test("a budget the person named is kept within the cap; a zone that is not one falls back", () => {
  const asked = admitRoutineProposal({ ...ARGS, maxCostUsd: 2.5 }, ctx());
  assert.equal(asked.ok && asked.proposal.maxCostMicroUsd, 2_500_000);
  const huge = admitRoutineProposal({ ...ARGS, maxCostUsd: 900 }, ctx());
  assert.equal(huge.ok && huge.proposal.maxCostMicroUsd, MAX_PROPOSAL_RUN_BUDGET_MICRO_USD);
  assert.equal(runBudgetFromUsd(-1), null);
  assert.equal(runBudgetFromUsd("abc"), null);
  assert.equal(defaultRunBudget(null), 1_000_000);
  assert.equal(defaultRunBudget(900_000), 2_750_000);
  const zone = admitRoutineProposal({ ...ARGS, timezone: "Mars/Olympus" }, ctx({ defaultTimezone: "America/New_York" }));
  assert.equal(zone.ok && zone.proposal.timezone, "America/New_York");
  const none = admitRoutineProposal(ARGS, ctx({ defaultTimezone: undefined }));
  assert.equal(none.ok && none.proposal.timezone, "UTC");
  const notify = admitRoutineProposal({ ...ARGS, notify: "on_attention" }, ctx());
  assert.equal(notify.ok && notify.proposal.notifyPolicy, "on_attention");
});

test("Schedule sends what the card shows: cloud, stop-and-wait, the key and the apps", () => {
  const admitted = admitRoutineProposal({ ...ARGS, apps: ["gmail"] }, ctx());
  if (!admitted.ok) throw new Error("unreachable");
  const body = routineScheduleBody(admitted.proposal);
  assert.equal(body.target, "cloud");
  assert.equal(body.unattendedPolicy, "pause_for_approval");
  assert.equal(body.proposalKey, "routine-proposal:msg-1:0");
  assert.deepEqual(body.connectorIds, ["composio:gmail"]);
  assert.deepEqual(body.triggers, [{ kind: "weekdays", config: { hour: 8, minute: 0 }, enabled: true }]);
  // The route's own schema and trigger validation accept it unchanged.
  const parsed = createScheduleSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.equal(normalizeTriggerDrafts(body.triggers as never, "Europe/Paris").ok, true);

  // Edits replace exactly what was edited.
  const edited = routineScheduleBody(admitted.proposal, {
    name: "  Inbox digest ",
    schedule: { kind: "weekly", config: { weekday: 1, hour: 9, minute: 0 } },
    maxCostMicroUsd: 500_000,
    notifyPolicy: "on_attention",
  });
  assert.equal(edited.name, "Inbox digest");
  assert.deepEqual(edited.triggers, [{ kind: "weekly", config: { weekday: 1, hour: 9, minute: 0 }, enabled: true }]);
  assert.deepEqual(edited.budget, { maxCostMicroUsd: 500_000, maxTokens: 0, maxRuntimeMs: 0 });
  assert.equal(edited.notifyPolicy, "on_attention");
});

test("the create route accepts the editor's null host, a proposal key and apps, and lists by key", () => {
  const base = { name: "a", instructions: "b", timezone: "UTC", target: "cloud", triggers: [{ kind: "daily", config: { hour: 8, minute: 0 } }] };
  // The web editor sends `hostId: null` for a routine pinned to no Mac; this
  // used to answer "Invalid input" for every create from the editor.
  assert.equal(createScheduleSchema.safeParse({ ...base, hostId: null }).success, true);
  assert.equal(createScheduleSchema.safeParse({ ...base, proposalKey: "short" }).success, false);
  assert.equal(createScheduleSchema.safeParse({ ...base, proposalKey: "routine-proposal:m:0", connectorIds: ["github"] }).success, true);
  const listed = parseScheduleListQuery(new URLSearchParams("proposalKey=routine-proposal:m:0&limit=1"));
  assert.deepEqual(listed, { ok: true, query: { proposalKey: "routine-proposal:m:0", limit: 1 } });
  assert.deepEqual(parseScheduleListQuery(new URLSearchParams("proposalKey=x")), { ok: false, parameter: "proposalKey" });
});

test("a persisted proposal reads back field by field, and anything malformed is dropped", () => {
  const admitted = admitRoutineProposal({ ...ARGS, apps: ["gmail", "Slack"] }, ctx());
  if (!admitted.ok) throw new Error("unreachable");
  const roundTrip = readRoutineProposal(JSON.parse(JSON.stringify(admitted.proposal)));
  assert.deepEqual(roundTrip, admitted.proposal);
  assert.equal(readRoutineProposal(null), undefined);
  assert.equal(readRoutineProposal({ ...admitted.proposal, schedule: { kind: "once", config: {} } }), undefined);
  assert.equal(readRoutineProposal({ ...admitted.proposal, key: 3 }), undefined);
  // A tampered ceiling is clamped rather than trusted.
  const clamped = readRoutineProposal({ ...admitted.proposal, maxCostMicroUsd: 10_000_000_000 });
  assert.equal(clamped?.maxCostMicroUsd, MAX_PROPOSAL_RUN_BUDGET_MICRO_USD);
});

test("a finished task becomes a routine from the person's own request, not the one-off brief", () => {
  const goal = composeTaskGoal({
    request: "Summarise my unread mail",
    brief: "Use the Gmail connector; the user prefers bullet points; today's thread from Ana matters most.",
    deliverable: "a short digest",
    skillSlug: "inbox-digest",
  });
  assert.equal(routineInstructionsFromGoal(goal), "Summarise my unread mail");
  assert.equal(routineInstructionsFromGoal("Plain goal with no labels"), "Plain goal with no labels");
  const proposal = proposalFromTask({ sessionId: "ses-9", title: "Inbox digest", goal, timezone: "Europe/Paris", now: NOW });
  assert.equal(proposal.key, "routine-from-task:ses-9");
  assert.equal(proposal.instructions, "Summarise my unread mail");
  assert.equal(proposal.schedule.phrase, "", "the card opens on Edit asking when");
  assert.equal(proposal.timezone, "Europe/Paris");
});

test("the tool is offered on the start_task gate, plus a client that draws the card, outside agent threads", () => {
  const open: RoutineToolGate = {
    clientDrawsProposal: true,
    privateMode: false,
    voiceMode: false,
    regenerate: false,
    userMessageId: "m1",
    researchActive: false,
    artifactEdit: false,
    conversationKind: "chat",
    agentThread: false,
    agenticTools: true,
    functionToolsReachModel: true,
    skillPermits: true,
    lockdown: false,
    planHasWorkModel: true,
    plan: "PRO",
  };
  assert.equal(chatRoutineToolEnabled(open), true);
  const closers: Partial<RoutineToolGate>[] = [
    { clientDrawsProposal: false },
    { privateMode: true },
    { voiceMode: true },
    { regenerate: true },
    { userMessageId: null },
    { researchActive: true },
    { artifactEdit: true },
    { conversationKind: "code" },
    { agentThread: true },
    { agenticTools: false },
    { functionToolsReachModel: false },
    { skillPermits: false },
    { lockdown: true },
    { planHasWorkModel: false },
    { plan: "FREE" },
  ];
  for (const closer of closers) assert.equal(chatRoutineToolEnabled({ ...open, ...closer }), false, JSON.stringify(closer));
});

test("the declaration matches its prompt text and never asks for more than the card shows", () => {
  assert.equal(PROPOSE_ROUTINE_TOOL.function.name, PROPOSE_ROUTINE_TOOL_ID);
  assert.equal(PROPOSE_ROUTINE_TOOL.function.description, PROPOSE_ROUTINE_DESCRIPTION);
  assert.deepEqual(PROPOSE_ROUTINE_TOOL.function.parameters.required, ["name", "instructions", "schedule"]);
  assert.match(PROPOSE_ROUTINE_DESCRIPTION, /does not create anything/);
});

test("the tool proposes, never creates, and stops after three cards in one reply", async () => {
  const shown: string[] = [];
  const tool = createProposeRoutineTool({
    user: { id: "user-1" },
    userMessageId: "msg-7",
    timeZone: "Europe/Paris",
    activeConnectors: [{ id: "composio:gmail", label: "Gmail" }],
    model: "unknown-model",
    untrustedContent: false,
    onProposal: (proposal) => shown.push(proposal.key),
    now: () => NOW,
  });
  assert.equal(tool.access, "read");
  for (let i = 0; i < MAX_PROPOSALS_PER_TURN; i++) {
    const result = await tool.execute({ ...ARGS, name: `Routine ${i}` });
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.text) as { status: string; instruction: string };
    assert.equal(payload.status, "proposed");
    assert.match(payload.instruction, /Nothing is scheduled until they press Schedule/);
  }
  assert.deepEqual(shown, ["routine-proposal:msg-7:0", "routine-proposal:msg-7:1", "routine-proposal:msg-7:2"]);
  const fourth = await tool.execute(ARGS);
  assert.equal(fourth.ok, false);
  assert.equal((JSON.parse(fourth.text) as { reason: string }).reason, "too_many");
  const refused = await createProposeRoutineTool({
    user: { id: "user-1" },
    userMessageId: "msg-8",
    activeConnectors: [],
    model: "x",
    untrustedContent: false,
    onProposal: () => assert.fail("a refused draft draws no card"),
  }).execute({ ...ARGS, schedule: "tomorrow at 9" });
  assert.equal(refused.ok, false);
});

test("the outcome tells the model what the person sees, and the activity row carries the card", () => {
  const admitted = admitRoutineProposal({ ...ARGS, schedule: "every Monday" }, ctx());
  if (!admitted.ok) throw new Error("unreachable");
  const said = describeRoutineOutcome(admitted);
  assert.equal(said.ok, true);
  assert.match(said.text, /defaults to 09:00/);
  assert.equal(said.body, 'Drafted "Morning inbox summary": Every Monday at 09:00.');
  const row = routineProposalActivity(admitted.proposal);
  assert.equal(row.kind, "tool");
  assert.equal(row.routineProposal, admitted.proposal);
});
