import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HANDOFF_REFUSALS,
  HAND_OFF_TOOL,
  HAND_OFF_TOOL_ID,
  composeHandoffGoal,
  describeHandoffOutcome,
  handoffActivityTitle,
  handoffApprovalArgs,
  handoffDetailFromArgs,
  handoffIdempotencyKeys,
  handoffRefusalFromResponse,
  isHandoffApproval,
  parseHandoffArgs,
  resolveTeammate,
  teammateBusy,
  type HandoffCandidate,
} from "@/lib/chat/handoff-tool";
import { MAX_TASK_GOAL_CHARS, TASK_APPROVAL_CONNECTOR_ID, taskIdempotencyKeys } from "@/lib/chat/task-tool";
import {
  ACTION_PERMISSION_POLICIES,
  actionPreview,
  actionPreviewDetail,
  classifyExternalAction,
  decideActionPolicy,
  mayCreateStandingApproval,
} from "@/lib/action-approval";

/*
 * `hand_off_to_teammate`: one agent giving work to another (the narrow handoff
 * of docs/design/AGENTS.md §8).
 *
 * The expensive mistakes here are quiet ones. A name matched loosely gives the
 * work to the wrong agent; a name two agents share picks one at random; a
 * handoff that skips the card starts work in a thread nobody is reading; a
 * route that announces the task pulls another agent's run into this thread's
 * panel. So the pure half is pinned directly and the wiring on the source, as
 * tests/chat-task-tool.test.ts does for `start_task`.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The declaration and the arguments
// ---------------------------------------------------------------------------

test("the tool declares a teammate, a title and a goal, and nothing a provider would reject", () => {
  assert.equal(HAND_OFF_TOOL_ID, "hand_off_to_teammate");
  assert.equal(HAND_OFF_TOOL.function.name, HAND_OFF_TOOL_ID);
  const parameters = HAND_OFF_TOOL.function.parameters as {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  assert.deepEqual(Object.keys(parameters.properties).sort(), ["deliverable", "goal", "teammate", "title"]);
  assert.deepEqual(parameters.required, ["teammate", "title", "goal"]);
  for (const [name, property] of Object.entries(parameters.properties)) {
    assert.equal(property.type, "string", name);
    assert.ok(property.description.length > 20, `${name} has no real description`);
  }
  assert.doesNotMatch(JSON.stringify(parameters), /additionalProperties|maxLength|minLength/);
  assert.match(parameters.properties.goal.description, /cannot read this conversation/);
  // The model is told the person approves every handoff, so it never promises one happened.
  assert.match(HAND_OFF_TOOL.function.description ?? "", /approves every handoff/);
});

test("arguments are trimmed like a task's, and a teammate is required", () => {
  assert.deepEqual(
    parseHandoffArgs({ teammate: "  @Atlas ", title: "  Draft   the replies ", goal: " Reply to the three suppliers. " }),
    { teammate: "Atlas", title: "Draft the replies", goal: "Reply to the three suppliers.", deliverable: null }
  );
  assert.equal(parseHandoffArgs({ title: "t", goal: "g" }), null);
  assert.equal(parseHandoffArgs({ teammate: "  ", title: "t", goal: "g" }), null);
  assert.equal(parseHandoffArgs({ teammate: "Atlas", title: "t" }), null);
  assert.equal(parseHandoffArgs({ teammate: 7, title: "t", goal: "g" }), null);
});

test("one message is one handoff, keyed apart from a task the same message could start", () => {
  const keys = handoffIdempotencyKeys("m1");
  assert.deepEqual(keys, { task: "handoff:m1", approval: "agent-handoff-approval:m1" });
  assert.deepEqual(handoffIdempotencyKeys("m1"), keys);
  assert.notEqual(keys.approval, taskIdempotencyKeys("m1").approval);
});

// ---------------------------------------------------------------------------
// Who the teammate is
// ---------------------------------------------------------------------------

const SELF: HandoffCandidate = { id: "self", name: "Scout", status: "active" };
const ROSTER: HandoffCandidate[] = [
  SELF,
  { id: "a1", name: "Atlas", status: "active" },
  { id: "b1", name: "Bolt", status: "active" },
  { id: "p1", name: "Pip", status: "paused" },
];

test("a teammate is found by its whole name, ignoring case and spacing", () => {
  const found = resolveTeammate("  atlas ", ROSTER, SELF.id);
  assert.equal(found.kind, "found");
  assert.equal(found.kind === "found" ? found.teammate.id : null, "a1");
  // Never a prefix: "Al" is somebody else, or nobody.
  assert.equal(resolveTeammate("Atl", ROSTER, SELF.id).kind, "refused");
});

test("a name two active teammates share is refused, never guessed", () => {
  const roster = [...ROSTER, { id: "a2", name: "ATLAS", status: "active" }];
  const outcome = resolveTeammate("Atlas", roster, SELF.id);
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  assert.equal(outcome.outcome.reason, "ambiguous_teammate");
  assert.match(outcome.outcome.message, /rename one of them/);
});

test("a paused teammate cannot take work, but an active one of the same name can", () => {
  const paused = resolveTeammate("pip", ROSTER, SELF.id);
  assert.equal(paused.kind === "refused" ? paused.outcome.reason : null, "teammate_paused");
  assert.match(paused.kind === "refused" ? paused.outcome.message : "", /^Pip is paused/);
  const both = resolveTeammate("Pip", [...ROSTER, { id: "p2", name: "Pip", status: "active" }], SELF.id);
  assert.equal(both.kind === "found" ? both.teammate.id : null, "p2");
});

test("an agent cannot hand work to itself, unless a teammate shares its name", () => {
  const self = resolveTeammate("Scout", ROSTER, SELF.id);
  assert.equal(self.kind === "refused" ? self.outcome.reason : null, "self");
  const namesake = resolveTeammate("Scout", [...ROSTER, { id: "s2", name: "Scout", status: "active" }], SELF.id);
  assert.equal(namesake.kind === "found" ? namesake.teammate.id : null, "s2");
});

test("an unknown name is answered with the names that would work", () => {
  const unknown = resolveTeammate("Zed", ROSTER, SELF.id);
  assert.equal(unknown.kind, "refused");
  if (unknown.kind !== "refused") return;
  assert.equal(unknown.outcome.reason, "unknown_teammate");
  // Active teammates only, quoted so the model can pass one back exactly.
  assert.match(unknown.outcome.message, /Your teammates are "Atlas" and "Bolt"\./);
  assert.doesNotMatch(unknown.outcome.message, /Pip|Scout/);
  const alone = resolveTeammate("Zed", [SELF, ROSTER[3]], SELF.id);
  assert.match(alone.kind === "refused" ? alone.outcome.message : "", /no active teammates/);
});

// ---------------------------------------------------------------------------
// The goal
// ---------------------------------------------------------------------------

test("the goal says where the work came from, then carries the request and the brief", () => {
  const goal = composeHandoffGoal({
    from: "Scout",
    to: "Atlas",
    request: "Can Atlas draft replies to these?",
    brief: "Reply to the three supplier emails from Monday, politely declining the price rise.",
    deliverable: "three draft replies in Gmail",
  });
  assert.ok(goal.startsWith("Scout handed this to Atlas.\n\nRequest: Can Atlas draft replies to these?"));
  assert.match(goal, /Brief: Reply to the three supplier emails/);
  assert.match(goal, /Deliverable: three draft replies in Gmail$/);
});

test("the whole goal fits on the approval card, however long the brief", () => {
  for (const size of [10, 3_000, 3_990, 4_000, 20_000]) {
    const goal = composeHandoffGoal({
      from: "Scout",
      to: "Atlas",
      request: "r".repeat(2_500),
      brief: "b".repeat(size),
      deliverable: "d".repeat(400),
    });
    assert.ok(goal.length <= MAX_TASK_GOAL_CHARS, `${size}: ${goal.length}`);
    assert.ok(goal.startsWith("Scout handed this to Atlas."), `${size}`);
    // The card shows `actionPreviewDetail(args).goal`, which cuts past the same bound.
    const shown = actionPreviewDetail(
      handoffApprovalArgs({ teammate: "Atlas", title: "t", goal, estimatedCostMicroUsd: 1 })
    );
    assert.equal(shown.goal, goal, `${size}`);
  }
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

test("every sentence the tool writes itself says nothing was handed off, and uses no dash as a separator", () => {
  const sentences = [
    ...Object.entries(HANDOFF_REFUSALS),
    ["teammate_busy", teammateBusy("Atlas", ["Weekly digest", "Inbox", "Q3", "Digest"]).message],
    ...["Zed", "Pip", "Scout"].map((name) => {
      const outcome = resolveTeammate(name, ROSTER, SELF.id);
      return [name, outcome.kind === "refused" ? outcome.outcome.message : ""];
    }),
  ];
  for (const [reason, message] of sentences) {
    assert.match(message, /[Nn]othing (new )?was handed off\.$/, reason);
    assert.doesNotMatch(message, /[—–]/, reason);
  }
  assert.match(
    teammateBusy("Atlas", ["Weekly digest", "Inbox", "Q3", "Digest"]).message,
    /^Atlas already has 4 tasks going: "Weekly digest", "Inbox", "Q3" and "Digest"\. Let one finish/
  );
});

test("a handoff tells the model who has it and where it reports back", () => {
  const done = describeHandoffOutcome({ status: "handed_off", teammate: "Atlas", title: "Draft replies", replay: false });
  assert.equal(done.ok, true);
  const model = JSON.parse(done.text) as Record<string, string>;
  assert.equal(model.status, "handed_off");
  assert.equal(model.teammate, "Atlas");
  assert.match(model.instruction, /one short sentence/);
  assert.match(model.instruction, /Atlas's own thread/);
  assert.equal(done.body, 'Handed "Draft replies" to Atlas.');
  const replay = describeHandoffOutcome({ status: "handed_off", teammate: "Atlas", title: "Draft replies", replay: true });
  assert.match((JSON.parse(replay.text) as Record<string, string>).note, /already started/);

  const refused = describeHandoffOutcome({ status: "not_handed_off", reason: "declined", message: HANDOFF_REFUSALS.declined });
  assert.equal(refused.ok, false);
  assert.equal(refused.body, HANDOFF_REFUSALS.declined);
});

test("a refusal from Work reaches the model in the route's own words", () => {
  assert.deepEqual(handoffRefusalFromResponse(409, { error: "agent_paused", message: "Atlas is paused." }), {
    status: "not_handed_off",
    reason: "agent_paused",
    message: "Atlas is paused.",
  });
  // With no sentence of its own, the handoff's own, not a task's.
  assert.equal(handoffRefusalFromResponse(500, {}).message, HANDOFF_REFUSALS.internal_error);
});

test("the activity row says what happened and to whom", () => {
  assert.equal(handoffActivityTitle("call"), "Handing off to a teammate");
  assert.equal(handoffActivityTitle("result", true), "Handed off");
  assert.equal(handoffActivityTitle("result", false), "Not handed off");
  assert.equal(
    handoffDetailFromArgs(JSON.stringify({ teammate: "Atlas", title: "Draft replies", goal: "g" })),
    "To Atlas: Draft replies"
  );
  assert.equal(handoffDetailFromArgs("{not json"), null);
  assert.equal(handoffDetailFromArgs(undefined), null);
});

// ---------------------------------------------------------------------------
// The approval
// ---------------------------------------------------------------------------

test("a handoff always asks, and is never a standing grant", () => {
  const classified = classifyExternalAction({
    connectorId: TASK_APPROVAL_CONNECTOR_ID,
    toolName: HAND_OFF_TOOL_ID,
    args: handoffApprovalArgs({ teammate: "Atlas", title: "Delete old drafts", goal: "delete", estimatedCostMicroUsd: 1 }),
  });
  assert.equal(classified.riskClass, "external_write");
  assert.deepEqual(classified.reasons, ["juno_exact_rule"]);
  assert.equal(mayCreateStandingApproval(classified.riskClass), false);
  for (const policy of ACTION_PERMISSION_POLICIES) {
    const outcome = decideActionPolicy({ policy, riskClass: classified.riskClass, hasStandingApproval: true });
    assert.equal(outcome, policy === "block" ? "block" : "ask", policy);
  }
});

test("the receipt binds the teammate, the title, the estimate and the whole goal", () => {
  assert.deepEqual(
    handoffApprovalArgs({ teammate: "Atlas", title: "Draft replies", goal: "Scout handed this to Atlas.", estimatedCostMicroUsd: 640_000 }),
    { teammate: "Atlas", title: "Draft replies", estimate: "about $0.64", goal: "Scout handed this to Atlas." }
  );
  const args = { teammate: "Atlas", title: "Draft replies.", estimate: "about $0.64", goal: "g" };
  assert.equal(
    actionPreview({ connectorId: "juno_work", connectorLabel: "Juno", toolName: HAND_OFF_TOOL_ID, riskClass: "external_write", args }),
    "Hand off to Atlas: Draft replies. Estimated cost about $0.64."
  );
  // Only Juno's own connector id earns the sentence.
  assert.equal(
    actionPreview({ connectorId: "composio_x", connectorLabel: "Juno", toolName: HAND_OFF_TOOL_ID, riskClass: "external_write", args }),
    "Juno wants to hand off to teammate."
  );
  assert.equal(isHandoffApproval({ connectorId: "juno_work", toolName: HAND_OFF_TOOL_ID }), true);
  assert.equal(isHandoffApproval({ connectorId: "juno_work", toolName: "start_task" }), false);
  assert.equal(isHandoffApproval({ connectorId: "linear", toolName: HAND_OFF_TOOL_ID }), false);
});

test("the approval card recognises a handoff by the same two literals", () => {
  const card = read("../src/components/chat/approval-card.tsx");
  assert.match(
    card,
    new RegExp(`approval\\.connectorId === "${TASK_APPROVAL_CONNECTOR_ID}" && approval\\.toolName === "${HAND_OFF_TOOL_ID}"`)
  );
  assert.doesNotMatch(card, /from "@\/lib\/chat\/handoff-tool"/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the handoff tool keeps server-only modules out of its static graph", () => {
  const source = read("../src/lib/chat/handoff-tool.ts");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const staticImports = source
    .split("\n")
    .filter((line) => /^import (?!type )/.test(line))
    .join("\n");
  assert.doesNotMatch(staticImports, /@\/lib\/(prisma|db|work\/dispatch|action-approval-store|agents\/store|rate-limit|llm)"/);
  assert.match(source, /import\("@\/lib\/agents\/store"\)/);
});

test("every handoff is put in front of a person before it starts, and a no puts its draft away", () => {
  const source = read("../src/lib/chat/handoff-tool.ts");
  const flow = source.slice(source.indexOf("async function handOff("));
  // Asked first whatever the estimate; confirmed only after the broker said yes.
  assert.match(flow, /startAgentTask\(user, target, \{ \.\.\.input, askFirst: true \}\)/);
  assert.ok(flow.indexOf("askFirst: true") < flow.indexOf("authorizeExternalAction("));
  assert.ok(flow.indexOf("authorizeExternalAction(") < flow.indexOf("confirmExpensive: true"));
  assert.match(flow, /toolName: HAND_OFF_TOOL_ID,/);
  assert.match(flow, /callId: keys\.approval,/);
  assert.match(flow, /await agents\.discardAgentTaskDraft\(user\.id, draftId\);/);
  assert.match(flow, /if \(authorization\.kind === "replay"\) return notHandedOff\(handoffRefusal\("already_tried"\)\);/);
  // The rate limit and the teammate's own thread are asked before anything is made.
  assert.ok(flow.indexOf("rateLimit(") < flow.indexOf("askFirst: true"));
  assert.ok(flow.indexOf("teammateBusy(") < flow.indexOf("askFirst: true"));
  // Both logs record it.
  assert.match(flow, /kind: "handed_off",/);
  assert.match(flow, /kind: "handoff_received",/);
});

test("startAgentTask can be asked to stop at the estimate, and hands back the draft it kept", () => {
  const store = read("../src/lib/agents/store.ts");
  assert.match(store, /if \(\(preflight\.preflight\.requiresConfirmation \|\| input\.askFirst\) && !input\.confirmExpensive\) \{/);
  assert.match(store, /return \{ kind: "confirm", sessionId: session\.id, estimatedCostMicroUsd:/);
  assert.match(store, /export async function discardAgentTaskDraft\(userId: string, sessionId: string\)/);
});

test("the chat route offers the handoff only in an agent's thread, on the task gate, and never announces its task", () => {
  const route = read("../src/app/api/chat/route.ts");
  assert.match(route, /const handoffGateOpen = chatTaskToolEnabled\(\{\s*\.\.\.taskGate,\s*skillPermits: narrowRuntimeToolsForSkill\(\[HAND_OFF_TOOL_ID\], appliedSkill\)/);
  // The agent answering is the thread's own, or in a room the member picked
  // for this turn; a private turn never has one.
  assert.match(route, /const turnAgentId = roomSetup \? roomSetup\.speaker\.agentId : conversation\.agentId;/);
  assert.match(route, /turnAgentId && !input\.privateMode\s*\? await agentChatContext\(user, turnAgentId, \{\s*taskHandoff: taskToolOn,\s*handoff: handoffGateOpen,\s*\}\)/);
  const call = route.slice(route.indexOf("createHandoffTool({"));
  const args = call.slice(0, call.indexOf("})"));
  assert.match(route, /agentContext\?\.handoff && userMessageId\s*\? createHandoffTool\(\{/);
  assert.match(args, /untrustedContent: untrustedContentInTurn \|\| allAttachments\.length > 0,/);
  assert.match(args, /onApprovalRequest: requestApproval,/);
  // Its task lives in the teammate's thread; announcing it would draw it here.
  assert.doesNotMatch(args, /onStarted/);
  // The approval and the activity row read as a handoff, not as a connector call.
  assert.match(route, /const handoff = isHandoffApproval\(approval\);/);
  assert.match(route, /const handoff = effect\.name === HAND_OFF_TOOL_ID;/);
});

test("the prompt and the tool are decided by the same answer", () => {
  const store = read("../src/lib/agents/store.ts");
  // The prompt describes the tool when, and only when, the context says the turn carries it.
  assert.match(store, /const handoff = options\.handoff === true && teammates\.length > 0;/);
  assert.match(store, /taskHandoff: options\.taskHandoff,\s*handoff,/);
  // Only active teammates are listed, and so only they are ever named to the model.
  assert.match(store, /where: \{ userId: user\.id, deletedAt: null, status: "active", id: \{ not: agentId \} \}/);
});
