import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIVE_TASK_STATUSES,
  MAX_TASK_GOAL_CHARS,
  START_TASK_TOOL,
  START_TASK_TOOL_ID,
  TASK_APPROVAL_CONNECTOR_ID,
  TASK_REFUSALS,
  approvalRefusalReason,
  chatTaskToolEnabled,
  composeTaskGoal,
  describeTaskOutcome,
  formatTaskEstimate,
  isTaskApproval,
  parseStartTaskArgs,
  taskActivityTitle,
  taskAlreadyRunning,
  taskApprovalArgs,
  taskIdempotencyKeys,
  taskRefusalFromResponse,
  taskTitleFromArgs,
  type TaskToolGate,
} from "@/lib/chat/task-tool";
import { createSessionSchema, startRunSchema } from "@/app/api/work/protocol";
import { parseSkillInvocation } from "@/lib/work/skills";
import {
  ACTION_PERMISSION_POLICIES,
  ACTION_PREVIEW_STRING_CHARS,
  actionPreview,
  actionPreviewDetail,
  classifyExternalAction,
  decideActionPolicy,
  mayCreateStandingApproval,
} from "@/lib/action-approval";

/*
 * `start_task`: the chat model deciding that a request is a job, not an answer.
 *
 * Nothing here can be seen from outside until it goes wrong in the expensive
 * direction. A gate that lets one condition through puts a tool on a voice turn
 * or a private chat; a key derived from the wrong thing starts two tasks for
 * one message; a refusal read from the wrong field tells the user something the
 * Work page never said. So each of those is pinned on the pure half, and the
 * wiring the route and the adapters depend on is pinned on the source.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test("the tool declares a title and a goal, and nothing a provider would reject", () => {
  assert.equal(START_TASK_TOOL.type, "function");
  assert.equal(START_TASK_TOOL.function.name, START_TASK_TOOL_ID);
  assert.equal(START_TASK_TOOL_ID, "start_task");
  const parameters = START_TASK_TOOL.function.parameters as {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  assert.equal(parameters.type, "object");
  assert.deepEqual(Object.keys(parameters.properties).sort(), ["deliverable", "goal", "title"]);
  assert.deepEqual(parameters.required, ["title", "goal"]);
  for (const [name, property] of Object.entries(parameters.properties)) {
    assert.equal(property.type, "string", name);
    assert.ok(property.description.length > 20, `${name} has no real description`);
  }
  // Gemini refuses the whole request over `additionalProperties`, and length
  // keywords are enforced by `parseStartTaskArgs` rather than trusted to every
  // provider's schema support.
  const wire = JSON.stringify(START_TASK_TOOL.function.parameters);
  assert.doesNotMatch(wire, /additionalProperties|maxLength|minLength/);
  // The goal's description is the one that keeps the task from being briefed
  // with "do what they said above".
  assert.match(parameters.properties.goal.description, /cannot read this conversation/);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const OPEN: TaskToolGate = {
  workHandoff: true,
  privateMode: false,
  voiceMode: false,
  regenerate: false,
  userMessageId: "cm0message000000000000001",
  researchActive: false,
  artifactEdit: false,
  conversationKind: "chat",
  agenticTools: true,
  functionToolsReachModel: true,
  skillPermits: true,
  lockdown: false,
  planHasWorkModel: true,
};

test("a saved chat turn from a client that can draw the task carries the tool", () => {
  assert.equal(chatTaskToolEnabled(OPEN), true);
});

test("every condition on its own is enough to withhold it", () => {
  const closing: Array<[string, Partial<TaskToolGate>]> = [
    ["a client that never opted in", { workHandoff: undefined }],
    ["a client that opted out", { workHandoff: false }],
    ["private mode", { privateMode: true }],
    ["voice", { voiceMode: true }],
    ["a regenerate", { regenerate: true }],
    ["no persisted user message", { userMessageId: null }],
    ["an empty user message id", { userMessageId: "" }],
    ["a deep research turn", { researchActive: true }],
    ["a canvas edit", { artifactEdit: true }],
    ["a workspaceless Code conversation", { conversationKind: "code" }],
    ["an unknown conversation kind", { conversationKind: undefined }],
    ["a model that cannot call tools", { agenticTools: false }],
    ["a turn whose function tools never reach the model", { functionToolsReachModel: false }],
    ["a skill that narrowed its tools past it", { skillPermits: false }],
    ["lockdown", { lockdown: true }],
    ["a plan with no Work model", { planHasWorkModel: false }],
  ];
  for (const [name, change] of closing) {
    assert.equal(chatTaskToolEnabled({ ...OPEN, ...change }), false, name);
  }
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test("one message maps to one session, one run and one approval, whatever retries", () => {
  const a = taskIdempotencyKeys("cm0message000000000000001");
  const again = taskIdempotencyKeys("cm0message000000000000001");
  const b = taskIdempotencyKeys("cm0message000000000000002");
  assert.deepEqual(a, again);
  assert.notEqual(a.session, b.session);
  assert.notEqual(a.run, b.run);
  // Three different keys, so the session's and the run's unique indexes never
  // collide with each other or with the approval receipt's.
  assert.equal(new Set([a.session, a.run, a.approval]).size, 3);
  // And each is a key the Work schemas accept, so the tool never trips the
  // route's own validation.
  assert.equal(startRunSchema.safeParse({ idempotencyKey: a.run }).success, true);
  assert.equal(
    createSessionSchema.safeParse({ goal: "x", requestedTarget: "automatic", idempotencyKey: a.session }).success,
    true
  );
});

// ---------------------------------------------------------------------------
// Arguments and the goal
// ---------------------------------------------------------------------------

test("arguments are trimmed and bounded, and both required fields are required", () => {
  assert.equal(parseStartTaskArgs({ title: "Pricing sheet" }), null);
  assert.equal(parseStartTaskArgs({ goal: "Build it" }), null);
  assert.equal(parseStartTaskArgs({ title: "   ", goal: "Build it" }), null);
  assert.equal(parseStartTaskArgs({ title: 7, goal: "Build it" }), null);

  const parsed = parseStartTaskArgs({ title: "  Pricing\n sheet ", goal: "  Build it  ", deliverable: " " });
  assert.deepEqual(parsed, { title: "Pricing sheet", goal: "Build it", deliverable: null });

  // A title that runs long is cut at a word, never mid-word, and never over 80.
  const long = parseStartTaskArgs({
    title: "A comprehensive comparison of every project management tool on the market for mid-sized teams",
    goal: "g",
  });
  assert.equal(long?.title, "A comprehensive comparison of every project management tool on the market for");
  assert.ok(long!.title.length <= 80);
});

test("the goal leads with the user's words and stays inside the Work bound", () => {
  const goal = composeTaskGoal({
    request: "Compare PM tool pricing for 40 people.",
    brief: "Research 15 tools and record per-seat pricing with sources.",
    deliverable: "a spreadsheet",
  });
  assert.ok(goal.startsWith("Request: Compare PM tool pricing for 40 people."));
  assert.match(goal, /\n\nBrief: Research 15 tools/);
  assert.match(goal, /\n\nDeliverable: a spreadsheet$/);

  // A brief that only repeats the message is not written twice.
  const echoed = composeTaskGoal({ request: "Plan my trip", brief: " Plan   my trip ", deliverable: null });
  assert.equal(echoed, "Request: Plan my trip");

  // Enormous inputs are cut to what `createSessionSchema` accepts.
  const huge = composeTaskGoal({ request: "r".repeat(50_000), brief: "b".repeat(50_000), deliverable: "d" });
  assert.ok(huge.length <= MAX_TASK_GOAL_CHARS);
  assert.equal(createSessionSchema.safeParse({ goal: huge, requestedTarget: "automatic" }).success, true);
});

test("the whole goal fits on the approval card, so nothing the task is told goes unseen", () => {
  // The card shows `actionPreviewDetail(args).goal`, which cuts any string past
  // its bound. A goal longer than that would carry a tail nobody approved, and
  // a brief written from a hostile page would put its instruction exactly there.
  assert.equal(MAX_TASK_GOAL_CHARS, ACTION_PREVIEW_STRING_CHARS);
  const cases = [
    { request: "r".repeat(50_000), brief: "b".repeat(50_000), deliverable: "d".repeat(300), skillSlug: "deck-style" },
    { request: "Short ask.", brief: "b".repeat(50_000), deliverable: null },
    { request: "", brief: "b".repeat(50_000), deliverable: "a sheet" },
  ];
  for (const input of cases) {
    const goal = composeTaskGoal(input);
    assert.ok(goal.length <= ACTION_PREVIEW_STRING_CHARS, `${goal.length} chars`);
    const shown = actionPreviewDetail(taskApprovalArgs({ title: "t", goal, estimatedCostMicroUsd: 1 }));
    assert.equal(shown.goal, goal);
  }
});

test("a long message never pushes the brief out of the goal", () => {
  // The request is bounded first and the brief takes the room that is left,
  // because the brief is what carries the conversation the task cannot read.
  const goal = composeTaskGoal({
    request: "r".repeat(50_000),
    brief: "Use the vendor list from earlier: Acme, Globex, Initech.",
    deliverable: "a spreadsheet",
    skillSlug: "deck-style",
  });
  assert.match(goal, /\n\nBrief: Use the vendor list from earlier: Acme, Globex, Initech\.\n\n/);
  assert.match(goal, /\n\nDeliverable: a spreadsheet$/);
  assert.equal(parseSkillInvocation(goal)?.slug, "deck-style");

  // A brief too long for what is left is clipped to fill it exactly, not dropped.
  const full = composeTaskGoal({ request: "r".repeat(50_000), brief: "b".repeat(50_000), deliverable: null });
  assert.equal(full.length, MAX_TASK_GOAL_CHARS);
  assert.match(full, /\n\nBrief: b+…$/);
});

test("a skill the message was sent under is invoked the way the Work runner reads it", () => {
  const goal = composeTaskGoal({
    request: "Tidy the Q3 board deck",
    brief: "Apply the house deck style.",
    deliverable: null,
    skillSlug: "deck-style",
  });
  const invocation = parseSkillInvocation(goal);
  assert.equal(invocation?.slug, "deck-style");
  assert.ok(invocation?.remainder.startsWith("Request: Tidy the Q3 board deck"));
  assert.equal(parseSkillInvocation(composeTaskGoal({ request: "x", brief: "y", deliverable: null })), null);
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

test("a dispatch refusal reaches the model in the route's own words", () => {
  // `{ error: code, message }`, the common shape.
  assert.deepEqual(
    taskRefusalFromResponse(429, {
      error: "usage_window_exceeded",
      message: "You've used up your 5-hour usage limit. Nothing was started.",
      window: "session",
    }),
    {
      status: "not_started",
      reason: "usage_window_exceeded",
      message: "You've used up your 5-hour usage limit. Nothing was started.",
    }
  );
  // A Mac relay refusal nests its code and sentence.
  assert.deepEqual(
    taskRefusalFromResponse(403, {
      error: { code: "work_host_revoked", message: "This Mac's access to Juno Work has been revoked.", retryable: false },
    }),
    { status: "not_started", reason: "work_host_revoked", message: "This Mac's access to Juno Work has been revoked." }
  );
  // The rate limit's `error` is a sentence, not a code: it becomes the message.
  assert.deepEqual(taskRefusalFromResponse(429, { error: "Too many runs started. Try again shortly." }), {
    status: "not_started",
    reason: "rate_limited",
    message: "Too many runs started. Try again shortly.",
  });
  // Nothing readable at all still says nothing started, and never invents why.
  assert.deepEqual(taskRefusalFromResponse(500, {}), {
    status: "not_started",
    reason: "refused",
    message: TASK_REFUSALS.internal_error,
  });
});

test("every sentence the tool writes itself says nothing started, and uses no dash as a separator", () => {
  for (const [reason, message] of Object.entries(TASK_REFUSALS)) {
    assert.match(message, /[Nn]othing (new )?was started\.$/, reason);
    assert.doesNotMatch(message, /[—–]/, reason);
  }
  const running = taskAlreadyRunning("Weekly digest");
  assert.equal(running.reason, "task_already_running");
  assert.match(running.message, /"Weekly digest"/);
});

test("an outcome is JSON for the model and a sentence for the panel", () => {
  const started = describeTaskOutcome({ status: "started", title: "Pricing sheet", where: "Runs in the cloud.", replay: false });
  assert.equal(started.ok, true);
  const model = JSON.parse(started.text) as Record<string, string>;
  assert.equal(model.status, "started");
  assert.equal(model.title, "Pricing sheet");
  assert.equal(model.runs, "Runs in the cloud.");
  assert.match(model.instruction, /one short sentence/);
  assert.match(model.instruction, /Do not do the work yourself/);
  assert.equal(started.body, 'Started "Pricing sheet".');

  const replayed = describeTaskOutcome({ status: "started", title: "Pricing sheet", where: null, replay: true });
  assert.match(JSON.parse(replayed.text).note, /already started/);
  assert.equal(replayed.body, 'Already started "Pricing sheet".');

  const refused = describeTaskOutcome({ status: "not_started", reason: "declined", message: TASK_REFUSALS.declined });
  assert.equal(refused.ok, false);
  assert.equal(refused.body, TASK_REFUSALS.declined);
  const refusedModel = JSON.parse(refused.text) as Record<string, string>;
  assert.equal(refusedModel.reason, "declined");
  assert.match(refusedModel.instruction, /why the task did not start/);
});

test("a broker refusal is read for what the person actually did", () => {
  assert.equal(approvalRefusalReason("Action denied."), "declined");
  assert.equal(approvalRefusalReason("Action expired."), "approval_expired");
  assert.equal(approvalRefusalReason("Action blocked."), "approval_blocked");
  // A mechanical failure is never reported as the user's choice.
  assert.equal(approvalRefusalReason("Arguments or permissions changed after approval."), "approval_failed");
});

test("the activity row says what happened and names the task", () => {
  assert.equal(taskActivityTitle("call"), "Starting a task");
  assert.equal(taskActivityTitle("result", true), "Started a task");
  assert.equal(taskActivityTitle("result", false), "Task not started");
  assert.equal(taskTitleFromArgs('{"title":"Pricing sheet","goal":"g"}'), "Pricing sheet");
  assert.equal(taskTitleFromArgs("{not json"), null);
  assert.equal(taskTitleFromArgs(undefined), null);
});

test("a live task means one that is going, not a draft", () => {
  assert.ok(!LIVE_TASK_STATUSES.includes("draft"));
  for (const status of ["queued", "preparing", "running", "waiting_input", "waiting_approval", "paused"]) {
    assert.ok(LIVE_TASK_STATUSES.includes(status), status);
  }
  assert.ok(!LIVE_TASK_STATUSES.includes("completed"));
});

// ---------------------------------------------------------------------------
// The approval
// ---------------------------------------------------------------------------

test("starting a task always asks when it reaches the broker, and is never a standing grant", () => {
  const classified = classifyExternalAction({
    connectorId: TASK_APPROVAL_CONNECTOR_ID,
    toolName: START_TASK_TOOL_ID,
    args: taskApprovalArgs({ title: "Read and summarise", goal: "list files", estimatedCostMicroUsd: 1 }),
  });
  // Juno's exact rule, not the token heuristics: "start" and "task" are not
  // read verbs, and a goal mentioning "delete" must not change the class.
  assert.equal(classified.riskClass, "external_write");
  assert.deepEqual(classified.reasons, ["juno_exact_rule"]);
  assert.equal(mayCreateStandingApproval(classified.riskClass), false);
  for (const policy of ACTION_PERMISSION_POLICIES) {
    const outcome = decideActionPolicy({ policy, riskClass: classified.riskClass, hasStandingApproval: true });
    assert.equal(outcome, policy === "block" ? "block" : "ask", policy);
  }
});

test("the receipt binds the title, the estimate and the whole goal", () => {
  assert.equal(formatTaskEstimate(640_000), "$0.64");
  assert.equal(formatTaskEstimate(5_000_000), "$5.00");
  assert.equal(formatTaskEstimate(-3), "$0.00");
  assert.deepEqual(taskApprovalArgs({ title: "Sheet", goal: "Request: x", estimatedCostMicroUsd: 640_000 }), {
    title: "Sheet",
    estimate: "about $0.64",
    goal: "Request: x",
  });
});

test("the preview describes a task only for Juno's own connector id", () => {
  const args = { title: "Pricing sheet", estimate: "about $0.64", goal: "g" };
  assert.equal(
    actionPreview({ connectorId: "juno_work", connectorLabel: "Juno", toolName: "start_task", riskClass: "external_write", args }),
    "Start a background task: Pricing sheet. Estimated cost about $0.64."
  );
  // A linked account can carry any label, so the label alone never earns the
  // task sentence.
  assert.equal(
    actionPreview({ connectorId: "composio_x", connectorLabel: "Juno", toolName: "start_task", riskClass: "external_write", args }),
    "Juno wants to start task."
  );
  assert.equal(isTaskApproval({ connectorId: "juno_work", toolName: "start_task" }), true);
  assert.equal(isTaskApproval({ connectorId: "linear", toolName: "start_task" }), false);
});

test("the stored preview is built with the connector id", () => {
  // The receipt's preview is what push notifications and the approvals list
  // print. Built from the label alone, a task approval read "Juno wants to
  // start task." everywhere except the card in the thread.
  const store = read("../src/lib/action-approval-store.ts");
  const call = store.slice(store.indexOf("const preview = actionPreview({"));
  assert.match(call.slice(0, call.indexOf("});")), /connectorId: request\.connectorId,/);
});

test("the approval card recognises a task by the same two literals", () => {
  // The card cannot import task-tool.ts (its server half would follow it into
  // the client bundle), so it repeats the test. This keeps the copies equal.
  const card = read("../src/components/chat/approval-card.tsx");
  assert.match(
    card,
    new RegExp(
      `approval\\.connectorId === "${TASK_APPROVAL_CONNECTOR_ID}" && approval\\.toolName === "${START_TASK_TOOL_ID}"`
    )
  );
  assert.doesNotMatch(card, /from "@\/lib\/chat\/task-tool"/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the task tool keeps server-only modules out of its static graph", () => {
  const source = read("../src/lib/chat/task-tool.ts");
  assert.doesNotMatch(source, /^import "server-only";/m);
  const staticImports = source
    .split("\n")
    .filter((line) => /^import (?!type )/.test(line))
    .join("\n");
  assert.doesNotMatch(staticImports, /@\/lib\/(prisma|db|work\/dispatch|action-approval-store|llm)"/);
  assert.match(source, /await import\("@\/lib\/work\/dispatch"\)|import\("@\/lib\/work\/dispatch"\)/);
});

test("streamChat offers native tools beside the toolset, never through the registry", () => {
  const llm = read("../src/lib/llm.ts");
  assert.match(llm, /toolset = withNativeTools\(toolset, opts\.nativeTools \?\? \[\]\);/);
  // After the toolset is opened, so a failed open still leaves them usable.
  assert.ok(llm.indexOf("withNativeTools(toolset") > llm.indexOf("openUnifiedAgentToolset(active"));
  const runtime = read("../src/lib/agent/runtime.ts");
  assert.doesNotMatch(runtime, /start_task/);
});

test("the chat route gates the tool and its prompt section on one flag", () => {
  const route = read("../src/app/api/chat/route.ts");
  assert.match(route, /const taskToolOn = chatTaskToolEnabled\(\{/);
  assert.match(route, /workHandoff: input\.workHandoff,/);
  assert.match(route, /taskHandoff: taskToolOn,/);
  assert.match(route, /nativeTools: taskTool \? \[taskTool\] : undefined,/);
  assert.match(route, /send\(\{ type: "work", session \}\);/);
  // The private branch builds no task tool: it sits above the saved path's
  // stream and must never reach the declaration.
  const privateBranch = route.slice(route.indexOf("if (input.privateMode) {"), route.indexOf("const durableFirstSubmission"));
  assert.doesNotMatch(privateBranch, /createStartTaskTool|nativeTools|taskHandoff/);
});

test("a task started from a turn with any file in it asks first", () => {
  // The memory rule's flag misses pictures: an image reaches a vision model as
  // pixels with no envelope, and a screenshot of an email is as much outside
  // content as the email's text would be.
  const route = read("../src/app/api/chat/route.ts");
  const call = route.slice(route.indexOf("createStartTaskTool({"));
  assert.match(
    call.slice(0, call.indexOf("})")),
    /untrustedContent: untrustedContentInTurn \|\| allAttachments\.length > 0,/
  );
});

test("a spent approval never starts a task, and every consumed one is settled", () => {
  const source = read("../src/lib/chat/task-tool.ts");
  // A replayed receipt reaching the dispatch means an earlier start of this
  // message was approved and then refused; dispatching on it would reuse a
  // one-time approval.
  assert.match(source, /if \(authorization\.kind === "replay"\) return notStarted\(taskRefusal\("already_tried"\)\);/);
  // Stopped after the approval, refused by the dispatch, or thrown: each moves
  // the receipt off `executing`.
  assert.match(source, /if \(signal\?\.aborted\) \{\s*await settleReceipt\(false, TASK_REFUSALS\.stopped\);/);
  assert.match(source, /await settleReceipt\(refusal === null,/);
  assert.match(source, /await settleReceipt\(false, TASK_REFUSALS\.internal_error\);\s*await discardDraft\(\);\s*throw err;/);
  // A throw after the run was written is read back from the database rather
  // than reported to the model as "nothing was started".
  assert.match(source, /idempotencyKey: keys\.run \}, select: \{ id: true \} \}\)/);
});

test("the tool's preflight includes the concurrency cap, so nobody approves a run the cap refuses", () => {
  const dispatch = read("../src/lib/work/dispatch.ts");
  const branch = dispatch.slice(dispatch.indexOf("if (options.preflightOnly) {"));
  const body = branch.slice(0, branch.indexOf("return { status: 200, body: { preflight }"));
  assert.match(body, /prisma\.workRun\.count\(\{\s*where: \{ userId: user\.id, status: \{ in: \[\.\.\.WORK_LIVE_STATUSES\] \} \},/);
  assert.match(body, /live >= WORK_RUN_CONCURRENCY_CAP/);
  assert.match(body, /error: "run_cap_exceeded"/);
});

test("the Work routes stay thin wrappers over the shared dispatch", () => {
  const sessions = read("../src/app/api/work/sessions/route.ts");
  assert.match(sessions, /createWorkSessionForUser\(user, parsed\.data\)/);
  assert.match(sessions, /NextResponse\.json\(result\.body, \{ status: result\.status \}\)/);
  const runs = read("../src/app/api/work/sessions/[id]/runs/route.ts");
  // The missing session still answers before a malformed body does.
  assert.ok(runs.indexOf('{ error: "Not found" }') < runs.indexOf('{ error: "Invalid input" }'));
  assert.match(runs, /startWorkRunForUser\(user, session, parsed\.data\)/);
  // The preflight-only door is the tool's alone.
  assert.doesNotMatch(runs, /preflightOnly/);
});
