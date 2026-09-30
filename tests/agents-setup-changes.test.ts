import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appsAtApply,
  planSetupChange,
  routineActsWithoutAsking,
  scalarUndoIsCurrent,
  setupChangeCallKey,
  setupChangeDigest,
  setupChangeNextStep,
  setupDirectionSentence,
  undoAppsDelta,
  type SetupSnapshot,
} from "@/lib/agents/setup-changes";
import { classifyExternalAction, decideActionPolicy, ACTION_PERMISSION_POLICIES } from "@/lib/action-approval";
import { SETUP_CHANGE_TOOL, createSetupChangeTool, setupApprovalOutcome } from "@/lib/chat/setup-change-tool";
import { UNTRUSTED_CONFIG_REFUSAL_MESSAGE } from "@/lib/chat/agent-config-tools";

/*
 * Setup by conversation. The direction of every change is decided from the
 * member's current setup, never by the model; narrowing applies at once,
 * widening waits for a deterministic approval, and everything can be undone.
 */

const MIRA: SetupSnapshot = {
  name: "Mira",
  approvalMode: "balanced",
  notify: "results",
  connectorIds: ["gmail"],
  budgetMicroUsd: 5_000_000,
  model: null,
  reasoningEffort: null,
  routines: [
    { id: "sch_digest", name: "Weekly digest", enabled: true },
    { id: "sch_old", name: "Old sweep", enabled: false },
  ],
};

const plan = (kind: string, args: Record<string, unknown>, snapshot = MIRA, options = {}) => {
  const result = planSetupChange(kind, args, snapshot, options);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.plan;
};

test("\"Stop notifying me unless you need a decision\" narrows and applies at once", () => {
  const p = plan("notify", { level: "needs_you" });
  assert.equal(p.direction, "narrowing");
  assert.deepEqual(p.before, { notify: "results" });
  assert.deepEqual(p.after, { notify: "needs_you" });
  assert.equal(plan("notify", { level: "all" }).direction, "neutral", "more notifications is not more reach");
  const same = planSetupChange("notify", { level: "results" }, MIRA);
  assert.equal(same.ok, false);
});

test("approval: stricter narrows, looser widens", () => {
  assert.equal(plan("approval_mode", { mode: "conservative" }).direction, "narrowing");
  const looser = plan("approval_mode", { mode: "permissive" });
  assert.equal(looser.direction, "widening");
  assert.match(looser.affects, /always ask/);
});

test("\"Connect Linear\" widens, and an app the account never linked is refused with where to connect it", () => {
  const add = plan("apps_add", { apps: ["Linear"] }, MIRA, { linkedApps: ["linear", "gmail"] });
  assert.equal(add.direction, "widening");
  assert.deepEqual(add.after, { connectorIds: ["gmail", "linear"], added: ["linear"] });
  const missing = planSetupChange("apps_add", { apps: ["linear"] }, MIRA, { linkedApps: ["gmail"] });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "not_connected");
    assert.match(missing.message, /linear is not connected to your account yet\. Connect it in Apps first/);
  }
  const remove = plan("apps_remove", { apps: ["gmail"] });
  assert.equal(remove.direction, "narrowing");
  assert.deepEqual(remove.after, { connectorIds: [], removed: ["gmail"] });
});

test("\"Every weekday at 8, summarise escalations\" asks under every approval mode: each run spends", () => {
  const args = { name: "Escalations", instructions: "Summarise today's escalations.", cadence: "weekdays", hour: 8, minute: 0, timezone: "Europe/London" };
  const asking = plan("routine_add", args);
  // Spending is reach (PRODUCT_REFOUNDATION §7), and agent_routine always asked.
  assert.equal(asking.direction, "widening");
  assert.match(asking.summary, /Every weekday at 08:00 \(Europe\/London\)/);
  assert.match(asking.affects, /asks before it changes anything\. Each run spends/);
  const unattended = plan("routine_add", args, { ...MIRA, approvalMode: "permissive" });
  assert.equal(unattended.direction, "widening");
  assert.match(unattended.affects, /can change things without asking/);
  assert.equal(routineActsWithoutAsking("permissive"), true);
  assert.equal(routineActsWithoutAsking("balanced"), false);
  assert.equal(planSetupChange("routine_add", { ...args, name: "Weekly digest" }, MIRA).ok, false, "no duplicate names");
  assert.equal(planSetupChange("routine_add", { name: "x" }, MIRA).ok, false);
});

test("pausing a routine narrows; resuming one starts the spending again, so it asks", () => {
  assert.equal(plan("routine_pause", { routine: "weekly digest" }).direction, "narrowing");
  assert.equal(plan("routine_resume", { routine: "Old sweep" }).direction, "widening");
  assert.equal(plan("routine_resume", { routine: "Old sweep" }, { ...MIRA, approvalMode: "permissive" }).direction, "widening");
  assert.equal(planSetupChange("routine_pause", { routine: "Old sweep" }, MIRA).ok, false, "already paused");
  assert.equal(planSetupChange("routine_pause", { routine: "Nope" }, MIRA).ok, false);
});

test("budget: a lower cap narrows, a higher or removed cap widens", () => {
  assert.equal(plan("budget", { budgetUsd: 2 }).direction, "narrowing");
  assert.equal(plan("budget", { budgetUsd: 20 }).direction, "widening");
  assert.equal(plan("budget", { noBudget: true }).direction, "widening");
  assert.equal(plan("budget", { budgetUsd: 3 }, { ...MIRA, budgetMicroUsd: null }).direction, "narrowing");
  assert.deepEqual(plan("budget", { budgetUsd: 2.5 }).after, { budgetMicroUsd: 2_500_000 });
  // Above what the column holds: refused with a sentence, never quietly lowered.
  const tooMuch = planSetupChange("budget", { budgetUsd: 5_000 }, MIRA);
  assert.equal(tooMuch.ok, false);
  if (!tooMuch.ok) assert.match(tooMuch.message, /^The largest weekly budget a crew member can have is \$2000\.00\./);
  assert.deepEqual(plan("budget", { budgetUsd: 2_000 }).after, { budgetMicroUsd: 2_000_000_000 });
});

test("a model change always asks; \"learn how I triage\" is a draft skill that stays off", () => {
  const draft = plan("skill_draft", { skillName: "Triage issues", skillDescription: "How I triage.", skillInstructions: "1. Read the title.\n2. Label it." });
  assert.equal(draft.direction, "neutral");
  assert.match(draft.affects, /stays off until you read it and turn it on/);
  assert.equal(planSetupChange("skill_draft", { skillName: "x" }, MIRA).ok, false);
  const store = readFileSync("src/lib/agents/setup-changes-store.ts", "utf8");
  const draftFn = store.slice(store.indexOf("async function createDraftSkill("));
  assert.match(draftFn, /data: \{ enabled: false, autoSelect: false \}/);
  assert.equal(planSetupChange("model", { model: "not-a-model" }, MIRA).ok, false);
});

test("the model cannot choose the direction: unknown kinds and self-described directions are ignored", () => {
  const sneaky = planSetupChange("apps_add", { apps: ["linear"], direction: "narrowing" }, MIRA, { linkedApps: ["linear"] });
  assert.ok(sneaky.ok);
  if (sneaky.ok) assert.equal(sneaky.plan.direction, "widening");
  assert.equal(planSetupChange("grant_everything", {}, MIRA).ok, false);
});

test("Apply is bound to the exact change the card showed", () => {
  const change = { id: "chg_1", agentId: "ag_1", kind: "apps_add", after: { connectorIds: ["gmail", "linear"], added: ["linear"] } };
  const digest = setupChangeDigest(change);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(setupChangeDigest({ ...change, after: { added: ["linear"], connectorIds: ["gmail", "linear"] } }), digest, "key order does not matter");
  assert.notEqual(setupChangeDigest({ ...change, after: { connectorIds: ["gmail", "slack"], added: ["slack"] } }), digest);
  assert.notEqual(setupChangeDigest({ ...change, id: "chg_2" }), digest);
});

test("Undo restores the inverse and never overwrites a later decision", () => {
  assert.deepEqual(undoAppsDelta({ kind: "apps_add", current: ["gmail", "linear", "slack"], added: ["linear"] }), ["gmail", "slack"]);
  assert.deepEqual(undoAppsDelta({ kind: "apps_remove", current: ["slack"], removed: ["gmail"] }), ["slack", "gmail"]);
  assert.equal(scalarUndoIsCurrent({ notify: "needs_you" }, { notify: "needs_you" }), true);
  assert.equal(scalarUndoIsCurrent({ notify: "all" }, { notify: "needs_you" }), false);
  assert.match(setupDirectionSentence("widening", "Mira"), /waits for your approval/);
});

test("a retried turn never inherits another request's row, and a decided change is only reported", () => {
  const widen = plan("approval_mode", { mode: "permissive" });
  const narrow = plan("approval_mode", { mode: "conservative" });
  const key = (p: typeof widen, seq = 1) => setupChangeCallKey({ userMessageId: "msg_1", seq, plan: p });
  assert.equal(key(widen), key(plan("approval_mode", { mode: "permissive" })), "the same request meets its row again");
  assert.notEqual(key(widen), key(narrow), "a different request in the same place gets its own row");
  assert.notEqual(key(widen, 1), key(widen, 2));

  // Only an undecided change moves; widening on either side asks.
  assert.equal(setupChangeNextStep({ rowStatus: "proposed", rowDirection: "narrowing", planDirection: "narrowing" }), "apply");
  assert.equal(setupChangeNextStep({ rowStatus: "awaiting_approval", rowDirection: "widening", planDirection: "widening" }), "ask");
  assert.equal(
    setupChangeNextStep({ rowStatus: "awaiting_approval", rowDirection: "widening", planDirection: "narrowing" }),
    "ask",
    "a stored widening row is never applied because today's plan reads narrower"
  );
  assert.equal(setupChangeNextStep({ rowStatus: "proposed", rowDirection: "neutral", planDirection: "widening" }), "ask");
  for (const rowStatus of ["declined", "undone", "applied", "failed"]) {
    assert.equal(setupChangeNextStep({ rowStatus, rowDirection: "widening", planDirection: "narrowing" }), "report", rowStatus);
    assert.equal(setupChangeNextStep({ rowStatus, rowDirection: "narrowing", planDirection: "narrowing" }), "report", rowStatus);
  }
});

test("apps apply against what the member has now, and remember only what they changed", () => {
  // Planned when Mira had gmail and slack; the person removed slack since.
  assert.deepEqual(appsAtApply({ kind: "apps_add", current: ["gmail"], apps: ["linear"] }), {
    connectorIds: ["gmail", "linear"],
    added: ["linear"],
    removed: [],
  });
  // Already there by hand: nothing for this change to add, or for its Undo to take.
  assert.deepEqual(appsAtApply({ kind: "apps_add", current: ["gmail", "linear"], apps: ["linear"] }).added, []);
  assert.deepEqual(appsAtApply({ kind: "apps_remove", current: ["gmail", "notion"], apps: ["gmail", "slack"] }), {
    connectorIds: ["notion"],
    added: [],
    removed: ["gmail"],
  });
  const store = readFileSync("src/lib/agents/setup-changes-store.ts", "utf8");
  const apply = store.slice(store.indexOf("export async function applySetupChange("), store.indexOf("function patchFor("));
  assert.match(apply, /appsAtApply\(\{ kind, current: agent\.connectorIds, apps \}\)/);
  assert.doesNotMatch(apply, /connectorIds: after\.connectorIds/, "the planned list is never written back");
});

test("a widening change asks under every chat policy short of block, and is never a standing approval", () => {
  const classification = classifyExternalAction({ connectorId: "juno_agents", toolName: "widen_setup", args: {} });
  assert.equal(classification.riskClass, "external_write");
  for (const policy of ACTION_PERMISSION_POLICIES) {
    const outcome = decideActionPolicy({ policy, riskClass: classification.riskClass, hasStandingApproval: true });
    assert.equal(outcome, policy === "block" ? "block" : "ask", policy);
  }
});

test("the tool refuses while outside content is in the turn, before touching anything", async () => {
  const tool = createSetupChangeTool({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    agent: { id: "ag_1", name: "Mira" },
    userMessageId: "m1",
    untrustedContent: true,
    generationId: "g1",
  });
  const result = await tool.execute({ kind: "apps_add", apps: ["linear"] });
  assert.equal(result.ok, false);
  const body = JSON.parse(result.text);
  assert.equal(body.reason, "untrusted_content_in_turn");
  assert.equal(body.message, UNTRUSTED_CONFIG_REFUSAL_MESSAGE);
  const props = (SETUP_CHANGE_TOOL.function.parameters as { properties: Record<string, unknown> }).properties;
  assert.ok(!("direction" in props), "the model is never asked for a direction");
});

test("a widening change only applies after the broker's yes, and the stale check guards it", () => {
  const source = readFileSync("src/lib/chat/setup-change-tool.ts", "utf8");
  const flow = source.slice(source.indexOf("const run = async"));
  assert.ok(flow.indexOf("requestActionApproval(") < flow.indexOf("applySetupChange(ctx.user, row, { approvalReceiptId"));
  assert.match(flow, /toolName: WIDEN_SETUP_APPROVAL_TOOL/);
  assert.match(flow, /allowAlways: false/);
  // The step comes from the stored row (and today's plan), never the plan alone.
  assert.match(flow, /setupChangeNextStep\(\{ rowStatus: row\.status, rowDirection: row\.direction, planDirection: plan\.direction \}\)/);
  assert.match(flow, /setupChangeCallKey\(/);
  assert.match(flow, /latest\.updatedAt\.getTime\(\) !== agent\.updatedAt\.getTime\(\)/);
  const route = readFileSync("src/app/api/agents/[id]/setup-changes/[changeId]/route.ts", "utf8");
  assert.match(route, /parsed\.data\.digest !== current\.digest/);
});

test("a No on the approval card is recorded as declined, not as a timeout", () => {
  // The broker's reason is a sentence ("Denied by user."); the outcome is read
  // from the receipt's status instead.
  assert.deepEqual(setupApprovalOutcome("denied"), { status: "declined", detail: "You declined this change." });
  assert.equal(setupApprovalOutcome("blocked").status, "proposed");
  assert.match(setupApprovalOutcome("blocked").detail, /approval settings block/);
  for (const status of ["expired", "superseded", null]) {
    assert.deepEqual(setupApprovalOutcome(status), {
      status: "proposed",
      detail: "Not approved in time. Apply it from this card if you still want it.",
    });
  }
  const flow = readFileSync("src/lib/chat/setup-change-tool.ts", "utf8");
  assert.doesNotMatch(flow, /approval\.reason === "denied"/);
});
