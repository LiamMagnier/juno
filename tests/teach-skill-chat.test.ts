import test from "node:test";
import assert from "node:assert/strict";
import { DRAFT_SKILL_TOOL_ID, SKILL_DRAFT_REFUSALS, TEACHABLE_TOOL_IDS, admitSkillDraft } from "@/lib/skills/teach";
import {
  DRAFT_SKILL_TOOL,
  TEACH_INTENT_LOOKBACK,
  chatSkillDraftToolEnabled,
  createDraftSkillTool,
  describeSkillDraftOutcome,
  detectTeachIntent,
  observedFromActivity,
  skillDraftActivity,
  turnTaintReader,
  type SkillDraftToolGate,
} from "@/lib/chat/skill-draft-tool";
import {
  DRAFT_SKILL_DESCRIPTION,
  DRAFT_SKILL_PARAMETERS,
  TEACH_SECTION,
  TEACH_UNAVAILABLE_LINE,
} from "@/lib/tools/specs/draft-skill.prompt";
import { TurnTaint } from "@/lib/web/taint";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { INVOICES, NOW, ctx } from "./teach-skill-fixtures";

/*
 * Teach Juno in a chat: when the model is offered `draft_skill` (only after
 * the person asked to teach something), what it is told, what the card rides
 * on, the conversation's own evidence of the tools it used, and the per-reply
 * cap. The tool creates nothing; the Teach page's Save is the write.
 */

// ---------------------------------------------------------------------------
// The chat tool
// ---------------------------------------------------------------------------

test("teaching intent is read from the person's latest messages, in English and French", () => {
  for (const message of [
    "I want to teach you how I file my invoices",
    "Let me show you how I prepare the weekly report",
    "Can you turn what we just did into a skill?",
    "save this as a workflow please",
    "Remember how I like these summaries done",
    "/teach my morning routine",
    "Je vais t'apprendre à classer mes factures",
    "Crée une compétence à partir de ce qu'on vient de faire",
  ]) {
    assert.equal(detectTeachIntent([message]), true, message);
  }
  for (const message of [
    "What's the weather in Paris?",
    "Can you teach me French?",
    "Save this as a PDF",
    "Summarise this article",
    null,
  ]) {
    assert.equal(detectTeachIntent([message]), false, String(message));
  }
  const old = ["Let me teach you how I sort mail", ...Array.from({ length: TEACH_INTENT_LOOKBACK }, () => "ok")];
  assert.equal(detectTeachIntent(old), false, "only the last few messages count");
  assert.equal(detectTeachIntent(old.slice(0, TEACH_INTENT_LOOKBACK)), true);
});

test("the tool is offered only when the person asked to teach, in a saved web chat, with tools", () => {
  const open: SkillDraftToolGate = {
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
    teachIntent: true,
  };
  assert.equal(chatSkillDraftToolEnabled(open), true);
  const closers: Partial<SkillDraftToolGate>[] = [
    { teachIntent: false },
    { clientDrawsProposal: false },
    { privateMode: true },
    { voiceMode: true },
    { regenerate: true },
    { userMessageId: null },
    { userMessageId: "" },
    { researchActive: true },
    { artifactEdit: true },
    { conversationKind: "code" },
    { agentThread: true },
    { agenticTools: false },
    { functionToolsReachModel: false },
    { skillPermits: false },
    { lockdown: true },
  ];
  for (const closer of closers) assert.equal(chatSkillDraftToolEnabled({ ...open, ...closer }), false, JSON.stringify(closer));
});

test("the declaration and its prompt text agree, and the section rides only with the tool", () => {
  assert.equal(DRAFT_SKILL_TOOL.function.name, DRAFT_SKILL_TOOL_ID);
  assert.equal(DRAFT_SKILL_TOOL.function.description, DRAFT_SKILL_DESCRIPTION);
  const params = DRAFT_SKILL_TOOL.function.parameters as { properties: Record<string, { description?: string }>; required: string[] };
  assert.deepEqual(params.required, ["name", "whenToUse", "steps"]);
  for (const [key, text] of Object.entries(DRAFT_SKILL_PARAMETERS)) {
    assert.equal(params.properties[key]?.description, text, key);
  }
  for (const id of TEACHABLE_TOOL_IDS) assert.match(DRAFT_SKILL_PARAMETERS.tools, new RegExp(`\\b${id}\\b`));
  assert.match(DRAFT_SKILL_DESCRIPTION, /creates nothing and switches nothing on/);

  const base = { memoryEnabled: true, canvas: true, voiceMode: false } as const;
  assert.ok(buildSystemPromptSections({ ...base, skillDrafts: true }).stable.includes(TEACH_SECTION));
  assert.ok(!buildSystemPromptSections({ ...base, skillDrafts: false }).stable.includes(TEACH_SECTION));
  assert.ok(!buildSystemPromptSections({ ...base }).stable.includes(TEACH_SECTION));
  assert.ok(!buildSystemPromptSections({ ...base, voiceMode: true, skillDrafts: true }).stable.includes(TEACH_SECTION));
  assert.match(TEACH_SECTION, /draft_skill/);
  assert.match(TEACH_SECTION, /Nothing is saved until the user reviews the draft/);
});

test("outcomes tell the model what the person sees, and the card rides on an activity row", () => {
  const admission = admitSkillDraft(INVOICES, ctx());
  assert.ok(admission.ok);
  if (!admission.ok) return;
  const proposed = describeSkillDraftOutcome(admission);
  assert.equal(proposed.ok, true);
  const body = JSON.parse(proposed.text);
  assert.equal(body.status, "proposed");
  assert.equal(body.steps, 3);
  assert.deepEqual(body.notConnected, ["Notion"]);
  assert.deepEqual(body.notAvailableToSkills, ["Bash(git add *)", "telepathy"]);
  assert.match(body.instruction, /Nothing is saved until they review it/);

  const refused = describeSkillDraftOutcome({ ok: false, reason: "unsafe", message: SKILL_DRAFT_REFUSALS.unsafe });
  assert.equal(refused.ok, false);
  assert.equal(JSON.parse(refused.text).reason, "unsafe");

  const row = skillDraftActivity(admission.draft);
  assert.equal(row.kind, "tool");
  assert.equal(row.title, "Drafted a skill");
  assert.equal(row.skillDraft, admission.draft);
});

test("what a conversation used is read off its activity rows; a failed call is not evidence", () => {
  const apps = [{ id: "composio:linear", label: "Linear" }];
  const observed = observedFromActivity(
    [
      { kind: "search", title: "Searched" },
      { kind: "visit", title: "Opened" },
      { kind: "artifact", title: "Canvas" },
      { kind: "tool", title: "run_code", tool: { server: "Alevr", name: "run_code", status: "ok" } },
      { kind: "tool", title: "calc", tool: { server: "Alevr", name: "calculate", status: "failed" } },
      { kind: "tool", title: "Linear", tool: { server: "Linear", name: "linear__create_issue", status: "ok" } },
      { kind: "tool", title: "Notion", tool: { server: "Notion", name: "notion__search", status: "ok" } },
      null,
      "nonsense",
    ],
    apps
  );
  assert.deepEqual(observed.tools.sort(), ["canvas", "run_code", "web_fetch", "web_search"]);
  assert.deepEqual(observed.apps, ["composio:linear"]);
});

test("the tool drafts at most twice per reply, numbers its keys, and reports each draft once", async () => {
  const drafts: string[] = [];
  const tool = createDraftSkillTool({
    user: { id: "u1" },
    userMessageId: "msg-7",
    conversationId: "conv-7",
    activeConnectors: [],
    untrustedContent: false,
    onDraft: (draft) => drafts.push(draft.key),
    now: () => NOW,
    connectedApps: async () => [{ id: "composio:gmail", label: "Gmail" }],
    observed: async () => ({ tools: ["web_search"], apps: [] }),
  });
  assert.equal(tool.access, "read", "drafting creates nothing");
  const refused = await tool.execute({ name: "Nothing", steps: [] });
  assert.equal(refused.ok, false);
  assert.equal(drafts.length, 0, "a refusal does not use up a draft");
  assert.equal((await tool.execute(INVOICES)).ok, true);
  assert.equal((await tool.execute({ ...INVOICES, name: "Second" })).ok, true);
  const third = await tool.execute({ ...INVOICES, name: "Third" });
  assert.equal(third.ok, false);
  assert.equal(JSON.parse(third.text).reason, "too_many");
  assert.deepEqual(drafts, ["skill-draft:msg-7:0", "skill-draft:msg-7:1"]);
});

test("a hostile turn drafts nothing even when the model asks", async () => {
  let drafted = 0;
  const tool = createDraftSkillTool({
    user: { id: "u1" },
    userMessageId: "msg-8",
    conversationId: "conv-8",
    activeConnectors: [],
    untrustedContent: true,
    untrustedNow: () => ({ untrusted: true, hostile: true }),
    onDraft: () => drafted++,
    connectedApps: async () => [],
    observed: async () => ({ tools: [], apps: [] }),
  });
  const result = await tool.execute(INVOICES);
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.text).reason, "outside_content");
  assert.equal(drafted, 0);
});

test("the live taint reader: a hostile page read mid-turn refuses the draft; a clean one marks it", async () => {
  assert.equal(turnTaintReader(null), undefined, "no taint kept: only the static flag is read");
  assert.equal(turnTaintReader(undefined), undefined);

  const make = (taint: TurnTaint, drafts: { fromOutsideContent: boolean }[]) =>
    createDraftSkillTool({
      user: { id: "u1" },
      userMessageId: "msg-9",
      conversationId: "conv-9",
      activeConnectors: [],
      // A turn that started clean: no web search, no app, no attachment.
      untrustedContent: false,
      untrustedNow: turnTaintReader(taint),
      onDraft: (draft) => drafts.push(draft),
      connectedApps: async () => [],
      observed: async () => ({ tools: [], apps: [] }),
    });

  // Before anything is read, the draft is clean.
  const quiet = new TurnTaint({ staticContent: false });
  const quietDrafts: { fromOutsideContent: boolean }[] = [];
  assert.equal((await make(quiet, quietDrafts).execute(INVOICES)).ok, true);
  assert.equal(quietDrafts[0]?.fromOutsideContent, false);

  // A page read during the turn marks the draft, read at call time.
  const read = new TurnTaint({ staticContent: false });
  const readDrafts: { fromOutsideContent: boolean }[] = [];
  const readTool = make(read, readDrafts);
  read.mark("web_fetch");
  assert.equal((await readTool.execute(INVOICES)).ok, true);
  assert.equal(readDrafts[0]?.fromOutsideContent, true);

  // A page judged hostile refuses it.
  const hostile = new TurnTaint({ staticContent: false });
  const hostileDrafts: { fromOutsideContent: boolean }[] = [];
  const hostileTool = make(hostile, hostileDrafts);
  hostile.mark("web_fetch", "hostile");
  const refused = await hostileTool.execute(INVOICES);
  assert.equal(refused.ok, false);
  assert.equal(JSON.parse(refused.text).reason, "outside_content");
  assert.equal(hostileDrafts.length, 0);
});

test("the saved chat passes the turn's live taint to draft_skill", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url).pathname;
  const runTurn = readFileSync(`${root}src/lib/chat/turn/run-turn.ts`, "utf8");
  const tools = readFileSync(`${root}src/lib/chat/turn/tools.ts`, "utf8");
  assert.match(runTurn, /liveTaint: turnTaintReader\(alevrSearchTurn\?\.taint\)/);
  const draftTool = tools.slice(tools.indexOf("createDraftSkillTool({"));
  assert.match(draftTool.slice(0, 800), /untrustedNow: liveTaint/);
});

test("asked to teach without draft_skill, the model is told to write a SKILL.md instead of claiming a card", () => {
  const base = { memoryEnabled: true, canvas: true, voiceMode: false } as const;
  const off = buildSystemPromptSections({ ...base, skillDraftsUnavailable: true }).stable;
  assert.ok(off.includes(TEACH_UNAVAILABLE_LINE));
  assert.ok(!off.includes(TEACH_SECTION));
  assert.match(TEACH_UNAVAILABLE_LINE, /no skill card will appear/);
  assert.match(TEACH_UNAVAILABLE_LINE, /SKILL\.md/);
  assert.match(TEACH_UNAVAILABLE_LINE, /Never say a skill was drafted, saved or switched on/);
  // With the tool on, its own section wins; on voice neither is said.
  const on = buildSystemPromptSections({ ...base, skillDrafts: true, skillDraftsUnavailable: true }).stable;
  assert.ok(on.includes(TEACH_SECTION) && !on.includes(TEACH_UNAVAILABLE_LINE));
  assert.ok(!buildSystemPromptSections({ ...base, voiceMode: true, skillDraftsUnavailable: true }).stable.includes(TEACH_UNAVAILABLE_LINE));
  assert.ok(!buildSystemPromptSections({ ...base }).stable.includes(TEACH_UNAVAILABLE_LINE), "nobody asked: nothing said");
});

test("the turn says teaching is unavailable exactly when the person asked and draft_skill is off", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url).pathname;
  const approvals = readFileSync(`${root}src/lib/chat/turn/approvals.ts`, "utf8");
  const prompt = readFileSync(`${root}src/lib/chat/turn/prompt.ts`, "utf8");
  const privateTurn = readFileSync(`${root}src/lib/chat/turn/private-turn.ts`, "utf8");
  const route = readFileSync(`${root}src/app/api/chat/route.ts`, "utf8");
  assert.match(approvals, /skillDraftUnavailable: teachIntent && !skillDraftToolOn/);
  assert.match(prompt, /skillDraftsUnavailable: skillDraftUnavailable && !skillDraftToolOn/);
  assert.match(route, /skillDraftUnavailable: approvals\.skillDraftUnavailable/);
  // Incognito never carries the tool, so its prompt reads the intent directly.
  assert.match(privateTurn, /skillDraftsUnavailable: detectTeachIntent\(/);
});
