/**
 * Orbit truth and controls (package O2), the parts that need no database:
 * the plan gate and its page, the note review and secret rules, the goal
 * completion rule (met only on a checked pass), the profile's notify and
 * model controls and pending notes, the goal row's unverified state, and the
 * wiring in the Work runner. The database halves are in
 * tests/orbit-truth.integration.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ClientAgent, ClientAgentDetail, ClientAgentGoal } from "@/lib/agents/types";

// tsx compiles the components' JSX with the classic runtime, which reads a global React.
(globalThis as { React?: typeof React }).React = React;

const ROOT = path.resolve(__dirname, "..");
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// ---------------------------------------------------------------------------
// Hiring needs a plan with agents
// ---------------------------------------------------------------------------

test("only plans with agents may hire; the refusal names both plans and keeps existing agents", async () => {
  const { agentHiringGate } = await import("@/lib/agents/plan-gate");
  const { PLANS } = await import("@/lib/plans");
  for (const plan of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
    const gate = agentHiringGate(plan);
    assert.equal(gate.allowed, PLANS[plan].agents, plan);
    assert.equal(gate.neededPlan, "PRO");
    if (gate.allowed) assert.equal(gate.message, null);
  }
  const free = agentHiringGate("FREE");
  assert.equal(free.allowed, false);
  assert.match(String(free.message), /included from Pro, and this account is on Free, so no agent was created/);
  assert.match(String(free.message), /Agents you already have are kept/);
  assert.equal(agentHiringGate("LITE").allowed, false);
});

test("the server refuses before it creates anything, for a hire and for a copy", () => {
  const store = source("src/lib/agents/store.ts");
  const create = store.slice(store.indexOf("export async function createAgentForUser("));
  const firstLines = create.slice(0, create.indexOf("createAgentTransaction"));
  assert.ok(firstLines.indexOf("hiringRefusal(user.id)") >= 0, "createAgentForUser asks the plan first");
  assert.ok(firstLines.indexOf("hiringRefusal(user.id)") < firstLines.indexOf("ownedProjectId"), "before any other read or write");
  const duplicate = store.slice(store.indexOf("export async function duplicateAgentForUser("));
  assert.ok(duplicate.indexOf("hiringRefusal(user.id)") < duplicate.indexOf("prisma.agent.create"), "a copy is a hire");
  // 402 with the plan to upgrade to, never a 500.
  assert.match(store, /status: 402, body: \{ error: "plan_locked", message: gate\.message, upgradePlan: gate\.neededPlan \}/);
});

const AGENT = {
  id: "agent_mira",
  name: "Mira",
  role: "Research",
  avatar: { shape: "orb", tone: "sky", eyes: "soft", mark: "ring" },
  style: "warm",
  instructions: "",
  model: null,
  reasoningEffort: null,
  approvalMode: "balanced",
  connectorIds: [],
  projectId: null,
  conversationId: "conv_1",
  status: "active",
  proactive: false,
  notify: "results",
  pinnedAt: null,
  template: null,
  lastReflectedAt: null,
  sortOrder: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: "idle",
  stateSentence: "Ready",
  task: null,
  needsYou: 0,
  nextRoutine: null,
  newIdeas: 0,
  computer: null,
  executionTarget: "cloud",
  computerPolicy: "ask",
} as unknown as ClientAgent;

test("Agents home on a plan without agents: one upgrade card, never the hire field; kept agents still listed", async () => {
  const { AgentsHome } = await import("@/components/agents/agents-home");
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} };
  const withRouter = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never }, el));
  const empty = withRouter(React.createElement(AgentsHome, { initialAgents: [], plan: "FREE" }));
  assert.match(empty, /Agents are included from Pro/);
  assert.match(empty, /You’re on Free/);
  assert.match(empty, /href="\/upgrade"/);
  assert.doesNotMatch(empty, /<textarea/, "no field whose agent would have every task refused");

  const kept = withRouter(React.createElement(AgentsHome, { initialAgents: [AGENT], plan: "LITE" }));
  assert.match(kept, /Mira/, "an agent kept from before the downgrade is still there");
  assert.match(kept, /New agents are included from Pro/);
  assert.match(kept, /Your agents are kept with everything they did/);
  assert.doesNotMatch(kept, /<textarea/);
});

test("the hire form behind ?form=1 is offered only on a plan with agents", () => {
  const page = source("src/app/(app)/agents/new/page.tsx");
  assert.match(page, /\(form === "1" \|\| form === "true"\) && agentHiringGate\(plan\)\.allowed/);
  assert.match(source("src/app/(app)/agents/page.tsx"), /<AgentsHome plan=\{plan\} \/>/);
});

// ---------------------------------------------------------------------------
// What an agent may keep from its tasks
// ---------------------------------------------------------------------------

test("a task's note waits for the person unless the agent may read everything; a sensitive one always waits", async () => {
  const { runNoteReview, agentNoteStatusOf } = await import("@/lib/agents/note-review");
  assert.deepEqual(runNoteReview({ memoryAccess: "full", content: "Ships from Lyon on weekdays." }), { status: "kept", reason: "full_access" });
  assert.deepEqual(runNoteReview({ memoryAccess: "profile", content: "Ships from Lyon on weekdays." }), { status: "pending", reason: "needs_review" });
  assert.deepEqual(runNoteReview({ memoryAccess: "none", content: "Ships from Lyon on weekdays." }), { status: "pending", reason: "needs_review" });
  assert.deepEqual(runNoteReview({ memoryAccess: "nonsense", content: "x" }).status, "pending", "unknown reads as the default");
  assert.deepEqual(runNoteReview({ memoryAccess: "full", content: "Has a therapy appointment for depression on Tuesdays." }), {
    status: "pending",
    reason: "sensitive",
  });
  assert.equal(agentNoteStatusOf("kept"), "kept");
  assert.equal(agentNoteStatusOf("pending"), "pending");
  assert.equal(agentNoteStatusOf(undefined), "pending", "never quietly kept");
});

test("notes never keep a secret: a labelled value is refused, a key is masked, a label alone is fine", async () => {
  const { screenAgentNote, namesASecretValue, MAX_RUN_NOTE_CHARS } = await import("@/lib/agents/note-review");
  for (const secret of ["password: hunter2", "The PIN for the door is 4821", "OTP 552019", "Her password was Tr0ub4dor&3", "api key = abc123def"]) {
    assert.equal(namesASecretValue(secret), true, secret);
    const screened = screenAgentNote(secret);
    assert.equal(screened.ok, false, secret);
    assert.equal(!screened.ok && screened.reason, "secret");
  }
  for (const fine of ["Asks for a password at login.", "The API key is in 1Password.", "The password is required on Fridays.", "Invoices go to billing@acme.test."]) {
    assert.equal(namesASecretValue(fine), false, fine);
    assert.equal(screenAgentNote(fine).ok, true, fine);
  }
  const masked = screenAgentNote("The deploy bot uses sk-ant-abcdefghijklmnopqrstuvwxyz0123 from the vault.");
  assert.equal(masked.ok, true);
  assert.equal(masked.ok && masked.redacted, 1);
  assert.doesNotMatch(masked.ok ? masked.content : "", /sk-ant-/);
  const onlyAKey = screenAgentNote("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
  assert.equal(onlyAKey.ok, false, "a note that is only a key is a note about nothing");
  assert.equal(screenAgentNote("   ").ok, false);
  assert.equal(screenAgentNote("x".repeat(MAX_RUN_NOTE_CHARS + 1)).ok, false);
  assert.equal(screenAgentNote("x".repeat(800), { maxChars: 1_000 }).ok, true, "the person's own notes keep their longer bound");
});

test("every reader of an agent's notes reads only kept ones; the profile lists pending ones apart", () => {
  assert.match(source("src/lib/agents/run-context.ts"), /agentNote\.findMany\(\{\s*where: \{[^}]*status: "kept"/);
  assert.match(source("src/lib/agents/reflect.ts"), /agentNote\.findMany\(\{\s*where: \{[^}]*status: "kept"/);
  const store = source("src/lib/agents/store.ts");
  const chat = store.slice(store.indexOf("export async function agentChatContext("), store.indexOf("// Goals, notes and ideas"));
  assert.match(chat, /deletedAt: null, status: "kept"/);
  const list = store.slice(store.indexOf("export async function listAgentNotes("), store.indexOf("export async function createAgentNote("));
  assert.match(list, /status: "kept"/);
  const detail = store.slice(store.indexOf("export async function loadAgentDetail("), store.indexOf("export async function recordAgentEvent("));
  assert.match(detail, /pendingNotes: notes\.filter\(\(note\) => agentNoteStatusOf\(note\.status\) === "pending"\)/);
});

test("the Work runner offers `remember` only to a run that works as an agent", () => {
  const runner = source("scripts/work-runner.ts");
  assert.match(runner, /\.\.\.\(input\.agentNote \? \[runtime\.agentNoteTool\(input\.agentNote\)\] : \[\]\)/);
  assert.match(runner, /agentNote: run\.session\.agentId\s*\? await runAgentNoteDeps\(/);
});

// ---------------------------------------------------------------------------
// A goal is met only after its criteria are checked
// ---------------------------------------------------------------------------

test("met only on a checked pass; a NOT MET or no check is unverified, never a silent pass", async () => {
  const { planGoalCompletion, GOAL_UNVERIFIED, GOAL_UNVERIFIED_LINE } = await import("@/lib/agents/goals");
  const met = planGoalCompletion({ title: "October post", check: { verdict: "met", why: "Live and linked." } });
  assert.equal(met.status, "achieved");
  assert.equal(met.event.kind, "goal_achieved");
  assert.match(met.nextAction, /criteria were checked/);

  const gap = planGoalCompletion({ title: "October post", check: { verdict: "not_met", why: "Nothing shows it is live." } });
  assert.equal(gap.status, GOAL_UNVERIFIED);
  assert.equal(gap.event.kind, "goal_unverified");
  assert.ok(gap.nextAction.startsWith(GOAL_UNVERIFIED_LINE));
  assert.match(gap.nextAction, /Nothing shows it is live/);

  for (const check of [null, { verdict: "unchecked" as const, why: null }]) {
    const none = planGoalCompletion({ title: "October post", check });
    assert.equal(none.status, GOAL_UNVERIFIED);
    assert.match(none.nextAction, /could not be checked/);
  }
});

test("a stored verdict is read strictly: junk is no verdict at all", async () => {
  const { readGoalCriteriaCheck } = await import("@/lib/agents/goals");
  assert.deepEqual(readGoalCriteriaCheck({ verdict: "met", why: "ok" }), { verdict: "met", why: "ok" });
  assert.deepEqual(readGoalCriteriaCheck({ verdict: "not_met" }), { verdict: "not_met", why: null });
  assert.equal(readGoalCriteriaCheck({ verdict: "yes" }), null);
  assert.equal(readGoalCriteriaCheck("met"), null);
  assert.equal(readGoalCriteriaCheck(null), null);
});

test("the final step is the one milestone left; its run reads every step's result, bounded", async () => {
  const { isFinalGoalStep, lastFinishedMilestone, composeGoalDeliverables, GOAL_CHECK_TOTAL_CHARS } = await import("@/lib/agents/goals");
  const ms = [
    { id: "a", title: "Draft", done: true, sessionId: "s1", doneAt: "2026-10-01T00:00:00.000Z" },
    { id: "b", title: "Publish", done: false, sessionId: null, doneAt: null },
  ];
  assert.equal(isFinalGoalStep(ms, "b"), true);
  assert.equal(isFinalGoalStep(ms, "a"), false);
  assert.equal(isFinalGoalStep([...ms, { id: "c", title: "Share", done: false }], "b"), false);
  assert.equal(isFinalGoalStep(ms, "next"), false, "a goal without milestones has no final step");
  assert.equal(isFinalGoalStep([], "b"), false);
  assert.equal(
    lastFinishedMilestone([...ms.slice(0, 1), { id: "b", title: "Publish", done: true, sessionId: "s2", doneAt: "2026-10-02T00:00:00.000Z" }])?.sessionId,
    "s2"
  );
  const text = composeGoalDeliverables([
    { title: "Draft", answer: "Drafted 1,200 words.", artifacts: ["draft.docx"] },
    { title: "Publish", answer: null, artifacts: [] },
  ]);
  assert.match(text, /## Draft\nDrafted 1,200 words\.\nFiles: draft\.docx/);
  assert.match(text, /## Publish\n\(no written answer\)/);
  assert.ok(composeGoalDeliverables(Array.from({ length: 20 }, (_, i) => ({ title: `S${i}`, answer: "x".repeat(2_000), artifacts: [] }))).length <= GOAL_CHECK_TOTAL_CHARS);
});

test("Keep working on an unverified goal adds one milestone aimed at the gap, within the bound", async () => {
  const { reopenUnverifiedGoal, MAX_GOAL_MILESTONES } = await import("@/lib/agents/goals");
  const ms = [{ id: "a", title: "Draft", done: true, sessionId: "s1", doneAt: null }];
  const aimed = reopenUnverifiedGoal(ms, "Nothing shows the post is live.");
  assert.equal(aimed.ok, true);
  assert.equal(aimed.ok && aimed.milestones.length, 2);
  assert.match(aimed.ok ? aimed.milestones[1]!.title : "", /^Close the gap the check found: Nothing shows/);
  assert.equal(aimed.ok && aimed.milestones[1]!.done, false);
  const general = reopenUnverifiedGoal(ms, null);
  assert.equal(general.ok && general.milestones[1]!.title, "Show that every success criterion is met");
  const full = reopenUnverifiedGoal(Array.from({ length: MAX_GOAL_MILESTONES }, (_, i) => ({ id: `m${i}`, title: `M${i}`, done: true })), null);
  assert.equal(full.ok, false);
});

test("the runner checks the criteria through the run's own judge seam and records, never fails, the step", () => {
  const runner = source("scripts/work-runner.ts");
  assert.match(
    runner,
    /validate: goalCriteriaCheckFor\(runtime\.goalValidator\(\{ provider, model: choice\.providerModel \}\), \{[\s\S]*?check: \(criteria\) => runtime\.checkGoalCriteria\(\{ provider, model: choice\.providerModel, \.\.\.criteria \}\),/
  );
  const criteria = source("src/lib/agents/goal-criteria.ts");
  assert.match(criteria, /if \(!result\.satisfied\) return result;/);
  assert.match(criteria, /return result;\n  \};/);
});

test("the goal status vocabulary: unverified is read everywhere and set only by the driver", async () => {
  const { AGENT_GOAL_STATUSES, AGENT_GOAL_ALL_STATUSES, patchGoalSchema } = await import("@/lib/agents/domain");
  assert.ok(!(AGENT_GOAL_STATUSES as readonly string[]).includes("unverified"), "a person or a chat cannot set it");
  assert.ok((AGENT_GOAL_ALL_STATUSES as readonly string[]).includes("unverified"));
  assert.equal(patchGoalSchema.safeParse({ status: "unverified" }).success, false);
  assert.equal(patchGoalSchema.safeParse({ status: "achieved" }).success, true, "the person may mark it met");
  // The native decoder knows it, so it is not read as Active.
  const swift = source("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentModels.swift");
  assert.match(swift, /case active, paused, achieved, dropped, unverified/);
  assert.match(swift, /case \.unverified: "Check the result"/);
  assert.match(source("native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentProfile.swift"), /\$0\.status == \.unverified/);
  const openapi = source("contracts/openapi/juno-native-v1.yaml");
  assert.match(openapi, /status: \{ type: string, enum: \[active, paused, achieved, dropped, unverified\] \}/);
  // The notification type exists for the person to be told.
  assert.match(source("src/lib/notifications.ts"), /\| "agent_goal";/);
});

// ---------------------------------------------------------------------------
// The profile: notify, model, pending notes, an unverified goal
// ---------------------------------------------------------------------------

function detail(extra: Partial<ClientAgentDetail>): ClientAgentDetail {
  return { agent: AGENT, goals: [], ideas: [], notes: [], routines: [], tasks: [], ...extra } as ClientAgentDetail;
}

async function renderProfile(d: ClientAgentDetail) {
  const { AgentProfile } = await import("@/components/agents/agent-panel");
  return renderToStaticMarkup(React.createElement(AgentProfile, { detail: d, onChanged: () => {} }));
}

test("the profile sets how it notifies, with the level in words, from the same patch the thread uses", async () => {
  const html = await renderProfile(detail({}));
  assert.match(html, /When it tells you/);
  assert.match(html, /When a task finishes or needs you/);
  for (const label of ["Needs you", "Results", "Everything"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /aria-label="When Mira notifies you"/);
  const panel = source("src/components/agents/agent-panel.tsx");
  assert.match(panel, /updateAgent\(agent\.id, \{ notify: next \}\)/);
});

test("the profile names its model; the picker saves through the agent patch and its plan check", async () => {
  const html = await renderProfile(detail({ agent: { ...AGENT, model: "claude-opus-4-8" } as ClientAgent }));
  assert.match(html, /What it thinks with/);
  assert.match(html, /claude-opus-4-8/, "without the app (a gallery) the model is named, never a broken picker");
  assert.match(html, /Its tasks use this model/);
  const panel = source("src/components/agents/agent-panel.tsx");
  assert.match(panel, /<ModelPicker[\s\S]*?updateAgent\(agent\.id, next\)/);
  // The same server validation as the chat's setup change: the schema, then the plan.
  const route = source("src/app/api/agents/[id]/route.ts");
  assert.match(route, /patchAgentSchema\.safeParse/);
  assert.match(source("src/lib/agents/store.ts"), /if \(modelChanged && !\(await modelInPlan\(user\.id, patch\.model\)\)\) return refusal\(403, "plan_locked"/);
});

test("notes a task saved wait apart with Keep and Forget; kept notes stay as they were", async () => {
  const note = (id: string, content: string) => ({ id, agentId: AGENT.id, content, source: "agent", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  const html = await renderProfile(detail({ notes: [note("n1", "Prefers PDFs.")] as never, pendingNotes: [note("n2", "Invoices go out on the 3rd.")] as never }));
  assert.match(html, /What it knows/);
  assert.match(html, /Learned in its tasks\. Mira uses this only once you keep it\./);
  assert.match(html, /data-pending-note="n2"/);
  assert.match(html, />Keep</);
  assert.match(html, />Forget</);
  assert.match(html, /Prefers PDFs\./);
  const transport = source("src/components/agents/agents-transport.ts");
  assert.match(transport, /body: \{ action: "keep" \}/);
});

test("an unverified goal says every step ran, links what each step produced, and offers Mark it met or Keep working", async () => {
  const goal = {
    id: "g1",
    agentId: AGENT.id,
    title: "October post",
    detail: "",
    status: "unverified",
    cadence: "weekly",
    lastCheckInAt: null,
    lastCheckInNote: null,
    dueAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    milestones: [
      { id: "a", title: "Draft the post", done: true, sessionId: "sess_a", doneAt: null },
      { id: "b", title: "Publish it", done: true, sessionId: "sess_b", doneAt: null },
    ],
    successCriteria: ["The post is live"],
    blockers: [],
    nextAction: "Every step ran. Check the result. A check against its criteria found a gap: Nothing shows it is live.",
    maxRuns: 4,
    runsUsed: 2,
  } as unknown as ClientAgentGoal;
  const html = await renderProfile(detail({ goals: [goal] }));
  assert.match(html, /Working toward/, "an unverified goal stays in view");
  assert.match(html, /data-goal-unverified/);
  assert.match(html, /Every step ran\. Check the result\./);
  assert.match(html, /href="\/work\/sess_a"/);
  assert.match(html, /href="\/work\/sess_b"/);
  assert.match(html, />Mark it met</);
  assert.match(html, />Keep working</);
});
