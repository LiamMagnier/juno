import test from "node:test";
import assert from "node:assert/strict";
import {
  admitSkillDraft,
  formFromSave,
  taughtPermissionFingerprint,
  taughtSkillSaveSchema,
  teachEnableDecision,
} from "@/lib/skills/teach";
import { detectTeachIntent } from "@/lib/chat/skill-draft-tool";
import { emptySkillContract } from "@/lib/work/skills";
import {
  acknowledgementFingerprint,
  answeredNote,
  applyListAction,
  formFromState,
  permissionRows,
  stateFromDraft,
  stateFromForm,
  teachProblems,
  teachSavePayload,
  teachSummary,
  type TeachItem,
} from "@/components/skills/teach/teach-model";
import { FULL_FORM, INVOICES, ctx } from "./teach-skill-fixtures";

/*
 * The Teach page's editor as data: a draft opening for review, list edits,
 * what stops a save, the one-line read-back, and the invariant consent rests
 * on: the fingerprint the review box acknowledges is the one the server
 * recomputes from the save.
 */

// ---------------------------------------------------------------------------
// The Teach page's editor
// ---------------------------------------------------------------------------

test("a draft opens in the editor; answered questions become notes, unanswered ones are asked at run time", () => {
  const admission = admitSkillDraft({ ...INVOICES, questions: ["Which folder?", "Skip paid ones?"] }, ctx());
  assert.ok(admission.ok);
  if (!admission.ok) return;
  const state = stateFromDraft(admission.draft);
  assert.equal(state.steps.length, 3);
  assert.deepEqual(state.connectors, ["composio:gmail", "google-drive"]);
  const answered = {
    ...state,
    steps: [...state.steps, { id: "blank", text: "   " }],
    questions: [
      { ...state.questions[0], answer: " Finance/2026 " },
      { ...state.questions[1], answer: "" },
    ],
  };
  const form = formFromState(answered);
  assert.equal(form.steps.length, 3, "an empty step is never saved");
  assert.deepEqual(form.notes, ["Which folder? Finance/2026"]);
  assert.deepEqual(form.questions, ["Skip paid ones?"]);
  assert.equal(answeredNote("Which folder", "A"), "Which folder? A");
});

test("list edits: insert, update, remove, move and reorder, within the limit", () => {
  const rows: TeachItem[] = [
    { id: "a", text: "one" },
    { id: "b", text: "two" },
    { id: "c", text: "three" },
  ];
  assert.deepEqual(applyListAction(rows, { type: "insert", after: 0, id: "n", text: "" }).map((r) => r.id), ["a", "n", "b", "c"]);
  assert.deepEqual(applyListAction(rows, { type: "insert", after: -1, id: "n" }).map((r) => r.id), ["n", "a", "b", "c"]);
  assert.equal(applyListAction(rows, { type: "insert", after: 2, id: "n" }, 3).length, 3, "the limit holds");
  assert.equal(applyListAction(rows, { type: "update", id: "b", text: "TWO" })[1].text, "TWO");
  assert.deepEqual(applyListAction(rows, { type: "remove", id: "b" }).map((r) => r.id), ["a", "c"]);
  assert.deepEqual(applyListAction(rows, { type: "move", id: "c", by: -1 }).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(applyListAction(rows, { type: "move", id: "a", by: -1 }).map((r) => r.id), ["a", "b", "c"], "past the top is a no-op");
  assert.deepEqual(applyListAction(rows, { type: "reorder", ids: ["c", "a", "b"] }).map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(applyListAction(rows, { type: "reorder", ids: ["c", "a"] }).map((r) => r.id), ["a", "b", "c"], "a stale drag loses nothing");
  assert.deepEqual(applyListAction(rows, { type: "reorder", ids: ["c", "c", "a"] }).map((r) => r.id), ["a", "b", "c"]);
});

test("the editor says what stops a save and reads the skill back in one line", () => {
  const empty = stateFromForm({ ...FULL_FORM, name: "", steps: [""] });
  assert.deepEqual(teachProblems(empty).map((p) => p.field), ["name", "steps"]);
  const ready = stateFromForm(FULL_FORM, "p1");
  assert.deepEqual(teachProblems(ready), []);
  const summary = teachSummary(ready, { apps: [{ id: "composio:gmail", label: "Gmail" }], projects: [{ id: "p1", name: "Finance" }] });
  assert.equal(summary, "/file-the-monthly-invoices · 3 steps · uses Search the web and Gmail · only in Finance");
  const bare = teachSummary(stateFromForm({ ...FULL_FORM, tools: [], connectors: [] }), { apps: [], projects: [] });
  assert.match(bare, /no specific tools · everywhere$/);
});

test("the fingerprint the review box acknowledges is the one the server recomputes from the save", () => {
  const state = stateFromForm(FULL_FORM, null);
  const acknowledged = acknowledgementFingerprint(state);
  const payload = teachSavePayload(state, {
    key: "skill-draft:m:0",
    source: { via: "conversation", conversationId: "c1" },
    enable: true,
    acknowledged,
  });
  const parsed = taughtSkillSaveSchema.parse(JSON.parse(JSON.stringify(payload)));
  const server = taughtPermissionFingerprint(formFromSave(parsed), {
    ...emptySkillContract(),
    requestedConnectors: parsed.connectors,
  });
  assert.equal(parsed.acknowledged, server, "client and server fingerprint the same surface");
  assert.equal(
    teachEnableDecision({ wantsEnable: parsed.enable, acknowledged: parsed.acknowledged, fingerprint: server, scanStatus: "clear" }).enabled,
    true
  );
  // Removing a tool after ticking changes the surface, so the old tick no longer matches.
  const narrowed = { ...state, tools: [] };
  assert.notEqual(acknowledgementFingerprint(narrowed), acknowledged);
  const keptOff = teachSavePayload(state, { source: { via: "walkthrough", conversationId: null }, enable: false, acknowledged });
  assert.equal(keptOff.acknowledged, null, "a kept-off save carries no acknowledgement");
  assert.equal("key" in keptOff, false);
});

test("permission rows mark evidence and connection, and keep a re-taught skill's unknown names visible", () => {
  const rows = permissionRows(
    { tools: ["web_search", "Bash"], connectors: ["composio:gmail", "slack"], domains: ["example.com"] },
    { apps: [{ id: "composio:gmail", label: "Gmail" }], observed: { tools: ["web_search"], apps: ["composio:gmail"] } }
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.label, r.observed, r.connected]),
    [
      ["tool", "Search the web", true, true],
      ["tool", "Bash", false, true],
      ["app", "Gmail", true, true],
      ["app", "slack", false, false],
      ["domain", "example.com", false, true],
    ]
  );
});

test("the Create-with chat prompt is a teaching prompt, so the chat offers draft_skill", async () => {
  const { CREATE_SKILL_PROMPT } = await import("@/components/skills/add-skill-menu");
  assert.equal(detectTeachIntent([`${CREATE_SKILL_PROMPT}sorting my receipts`]), true);
});

test("answered questions count against the notes a save may carry, so the editor stops a save the server would refuse", () => {
  const withNotes = (notes: number, answered: number) => {
    const state = stateFromForm({
      ...FULL_FORM,
      notes: Array.from({ length: notes }, (_, i) => `Note ${i}`),
      questions: Array.from({ length: Math.max(answered, 1) }, (_, i) => `Question ${i}?`),
    });
    return { ...state, questions: state.questions.map((q, i) => (i < answered ? { ...q, answer: `Answer ${i}` } : q)) };
  };
  // The verifier's case: 6 notes and 3 answers save (the schema now takes 8 + 5).
  const nine = withNotes(6, 3);
  assert.deepEqual(teachProblems(nine), []);
  assert.equal(taughtSkillSaveSchema.safeParse(teachSavePayload(nine, { source: { via: "walkthrough", conversationId: null }, enable: false, acknowledged: null })).success, true);
  // A re-taught skill that came back with 12 notes, plus 2 answers, is over.
  const over = withNotes(12, 2);
  const problems = teachProblems(over);
  assert.deepEqual(problems.map((p) => p.field), ["notes"]);
  assert.match(problems[0].message, /at most 13 notes, and each answered question becomes one/);
  // And the server would have refused it: the editor's check is the schema's.
  assert.equal(taughtSkillSaveSchema.safeParse(teachSavePayload(over, { source: { via: "walkthrough", conversationId: null }, enable: false, acknowledged: null })).success, false);
});

test("a website kept from an earlier version says it is a record, not a limit", () => {
  const rows = permissionRows({ tools: [], connectors: [], domains: ["example.com"] }, { apps: [] });
  assert.match(rows[0].description, /Kept as a record; a chat can’t limit search to it\./);
});
