import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EYES,
  AGENT_MARKS,
  AGENT_SHAPES,
  AGENT_TONES,
  defaultAgentAvatar,
  normalizeAgentAvatar,
} from "@/lib/agents/avatar";
import {
  AGENT_DONE_WINDOW_MS,
  AGENT_EVENT_KINDS,
  AGENT_REFLECT_INTERVAL_MS,
  agentModelChoice,
  agentStateSentence,
  agentTaskKeys,
  agentTurnModel,
  createAgentSchema,
  createRoutineSchema,
  deriveAgentState,
  patchAgentSchema,
  reflectionDue,
  routineTrigger,
  type AgentTaskGlance,
} from "@/lib/agents/domain";
import { buildAgentPromptBlock, appendAgentBlock } from "@/lib/agents/prompt";
import { parseReflection, reflectionUserMessage, REFLECTION_MAX_IDEAS } from "@/lib/agents/reflection";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { parseTimeTrigger } from "@/lib/work/schedule";

/*
 * Agents (docs/design/AGENTS.md): the decisions a screen would otherwise make
 * for itself. What state the face shows, what the sentence beside it says, what
 * the model is told in an agent's thread, what a reflection may keep, and the
 * clock a routine is written with — each one a case where the wrong answer is
 * quiet: a face that says Working over a run that stopped to ask, a routine
 * accepted here and refused by the scheduler at 07:00, an idea to "Buy" that
 * reads as Juno offering to spend someone's money.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const task = (status: string, extra: Partial<AgentTaskGlance> = {}): AgentTaskGlance => ({
  sessionId: "s1",
  title: "Competitor pricing",
  status,
  needsAttention: false,
  lastActivityAt: ago(60_000),
  ...extra,
});

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

test("a default face is deterministic, and different seeds spread over the vocabulary", () => {
  assert.deepEqual(defaultAgentAvatar("agent_1"), defaultAgentAvatar("agent_1"));
  const faces = new Set(
    Array.from({ length: 40 }, (_, i) => JSON.stringify(defaultAgentAvatar(`cm${i}xyz`)))
  );
  assert.ok(faces.size > 10, `forty seeds made only ${faces.size} faces`);
  for (let i = 0; i < 40; i++) {
    const face = defaultAgentAvatar(`seed-${i}`);
    assert.ok(AGENT_SHAPES.includes(face.shape));
    assert.ok(AGENT_TONES.includes(face.tone));
    assert.ok(AGENT_EYES.includes(face.eyes));
    // An accessory is a choice a person makes, never a dice roll.
    assert.equal(face.mark, "none");
  }
});

test("normalizing keeps every known part and replaces only the unknown one", () => {
  const face = normalizeAgentAvatar({ shape: "heptagon", tone: "violet", eyes: "tall", mark: "leaf" }, "seed");
  assert.equal(face.tone, "violet");
  assert.equal(face.eyes, "tall");
  assert.equal(face.mark, "leaf");
  assert.equal(face.shape, defaultAgentAvatar("seed").shape);
  assert.deepEqual(normalizeAgentAvatar(null, "seed"), defaultAgentAvatar("seed"));
  assert.deepEqual(normalizeAgentAvatar([], "seed"), defaultAgentAvatar("seed"));
  assert.ok(AGENT_MARKS.includes(normalizeAgentAvatar({ mark: 3 }, "x").mark));
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test("paused beats everything, including a run that is still working", () => {
  assert.equal(deriveAgentState({ status: "paused", task: task("running"), now: NOW }), "sleeping");
});

test("a run that needs the person is waiting, live or terminal", () => {
  assert.equal(deriveAgentState({ status: "active", task: task("waiting_approval"), now: NOW }), "waiting");
  assert.equal(deriveAgentState({ status: "active", task: task("waiting_input"), now: NOW }), "waiting");
  // host_offline is terminal and still a decision the person has to make.
  assert.equal(
    deriveAgentState({ status: "active", task: task("host_offline", { needsAttention: true }), now: NOW }),
    "waiting"
  );
});

test("live work is working, but a draft or a run the person paused is not", () => {
  for (const status of ["queued", "preparing", "running"]) {
    assert.equal(deriveAgentState({ status: "active", task: task(status), now: NOW }), "working", status);
  }
  assert.equal(deriveAgentState({ status: "active", task: task("draft"), now: NOW }), "idle");
  assert.equal(deriveAgentState({ status: "active", task: task("paused"), now: NOW }), "idle");
});

test("done and blocked are recent history, and then they are just history", () => {
  assert.equal(deriveAgentState({ status: "active", task: task("completed"), now: NOW }), "done");
  assert.equal(
    deriveAgentState({
      status: "active",
      task: task("completed", { lastActivityAt: ago(AGENT_DONE_WINDOW_MS + 1_000) }),
      now: NOW,
    }),
    "idle"
  );
  assert.equal(deriveAgentState({ status: "active", task: task("failed"), now: NOW }), "blocked");
  assert.equal(deriveAgentState({ status: "active", task: task("budget_exceeded"), now: NOW }), "blocked");
  assert.equal(
    deriveAgentState({ status: "active", task: task("failed", { lastActivityAt: ago(7 * 60 * 60 * 1000) }), now: NOW }),
    "idle"
  );
  assert.equal(deriveAgentState({ status: "active", task: task("cancelled"), now: NOW }), "idle");
  assert.equal(deriveAgentState({ status: "active", task: null, now: NOW }), "idle");
});

test("the sentence names the task, and an idle agent says what is next", () => {
  const glance = task("waiting_approval");
  assert.equal(
    agentStateSentence({ state: "waiting", task: glance, nextRoutine: null, now: NOW }),
    "Needs your approval on Competitor pricing"
  );
  assert.equal(
    agentStateSentence({ state: "working", task: task("running"), nextRoutine: null, now: NOW }),
    "Working on Competitor pricing"
  );
  assert.equal(
    agentStateSentence({
      state: "idle",
      task: null,
      nextRoutine: { name: "Weekly digest", nextRunAt: new Date("2026-09-25T09:00:00.000Z") },
      now: NOW,
    }),
    "Next: Weekly digest, tomorrow at 09:00"
  );
  assert.equal(agentStateSentence({ state: "idle", task: null, nextRoutine: null, now: NOW }), "Ready for something new");
  assert.match(
    agentStateSentence({ state: "blocked", task: task("budget_exceeded"), nextRoutine: null, now: NOW }),
    /usage window/
  );
});

test("reflection is due on its interval, never while paused, and on demand", () => {
  const base = { status: "active", proactive: true, now: NOW };
  assert.equal(reflectionDue({ ...base, lastReflectedAt: null }), true);
  assert.equal(reflectionDue({ ...base, lastReflectedAt: ago(60_000) }), false);
  assert.equal(reflectionDue({ ...base, lastReflectedAt: ago(AGENT_REFLECT_INTERVAL_MS) }), true);
  assert.equal(reflectionDue({ ...base, proactive: false, lastReflectedAt: null }), false);
  assert.equal(reflectionDue({ ...base, proactive: false, lastReflectedAt: ago(1), force: true }), true);
  assert.equal(reflectionDue({ ...base, status: "paused", lastReflectedAt: null, force: true }), false);
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test("hiring input is bounded and defaulted, and an unknown autonomy is refused", () => {
  const parsed = createAgentSchema.parse({ name: "  Scout  ", connectorIds: ["github", "github", "notion"] });
  assert.equal(parsed.name, "Scout");
  assert.equal(parsed.approvalMode, "balanced");
  assert.equal(parsed.style, "warm");
  assert.deepEqual(parsed.connectorIds, ["github", "notion"]);
  assert.equal(createAgentSchema.safeParse({ name: "" }).success, false);
  assert.equal(createAgentSchema.safeParse({ name: "x", approvalMode: "yolo" }).success, false);
  assert.equal(createAgentSchema.safeParse({ name: "x", avatar: { shape: "orb", tone: "coral", eyes: "soft" } }).success, false);
  assert.equal(patchAgentSchema.safeParse({}).success, false);
});

test("an agent's model is a chat model stored by its canonical id, and its effort is a real tier", () => {
  assert.equal(patchAgentSchema.parse({ model: "claude-haiku-4-5" }).model, "anthropic:claude-haiku-4-5");
  assert.equal(patchAgentSchema.parse({ model: "juno:auto" }).model, "juno:auto");
  assert.equal(patchAgentSchema.parse({ model: null, reasoningEffort: null }).model, null);
  assert.equal(patchAgentSchema.parse({ reasoningEffort: "low" }).reasoningEffort, "low");
  // Not a model at all, a model announced but not out, and an effort no model has.
  assert.equal(patchAgentSchema.safeParse({ model: "nonsense" }).success, false);
  assert.equal(patchAgentSchema.safeParse({ model: "longcat:LongCat-2.0" }).success, false);
  assert.equal(patchAgentSchema.safeParse({ reasoningEffort: "turbo" }).success, false);
  assert.equal(createAgentSchema.safeParse({ name: "x", model: "nonsense" }).success, false);
  assert.equal(agentModelChoice("  anthropic:claude-haiku-4-5  "), "anthropic:claude-haiku-4-5");
});

test("a thread answers on its agent's model unless the message names another", () => {
  const agent = { model: "anthropic:claude-haiku-4-5", reasoningEffort: "low" };
  const usable = () => true;
  const own = { kind: "agent", model: "anthropic:claude-haiku-4-5", reasoningEffort: "low" };
  // No model named, or the agent's own in any spelling: the agent's, at its effort.
  assert.deepEqual(agentTurnModel({ agent, requestedModel: undefined, usable }), own);
  assert.deepEqual(agentTurnModel({ agent, requestedModel: "claude-haiku-4-5", usable }), own);
  // Another model is the person's choice for this message.
  assert.deepEqual(agentTurnModel({ agent, requestedModel: "juno:auto", usable }), { kind: "request" });
  assert.deepEqual(agentTurnModel({ agent, requestedModel: "openai:gpt-6-luna", usable }), { kind: "request" });
  // An agent with no model, or none at all, leaves the request alone.
  assert.deepEqual(agentTurnModel({ agent: { model: null, reasoningEffort: "low" }, requestedModel: undefined, usable }), {
    kind: "request",
  });
  assert.deepEqual(agentTurnModel({ agent: null, requestedModel: "juno:auto", usable }), { kind: "request" });
  // A model the account cannot use falls back quietly instead of refusing to answer.
  assert.deepEqual(agentTurnModel({ agent, requestedModel: undefined, usable: () => false }), { kind: "fallback" });
  assert.deepEqual(agentTurnModel({ agent, requestedModel: agent.model, usable: () => false }), { kind: "fallback" });
  // An effort nobody could have stored reads as none.
  assert.deepEqual(agentTurnModel({ agent: { ...agent, reasoningEffort: "turbo" }, requestedModel: undefined, usable }), {
    ...own,
    reasoningEffort: null,
  });
});

test("an agent's task keys are namespaced by the agent", () => {
  assert.deepEqual(agentTaskKeys("a1", "handoff:m1"), { session: "agent-task:a1:handoff:m1", run: "agent-run:a1:handoff:m1" });
  assert.notEqual(agentTaskKeys("a1", "k").session, agentTaskKeys("a2", "k").session);
  // Both sides of a handoff are written to the log under kinds it knows.
  assert.ok(AGENT_EVENT_KINDS.includes("handed_off"));
  assert.ok(AGENT_EVENT_KINDS.includes("handoff_received"));
});

test("every routine cadence becomes a trigger the scheduler's own parser accepts", () => {
  for (const cadence of ["hourly", "daily", "weekdays", "weekly", "monthly"] as const) {
    const input = createRoutineSchema.parse({
      name: "Digest",
      instructions: "Summarise the week",
      cadence,
      hour: 7,
      minute: 30,
      weekday: 1,
      monthday: 15,
      timezone: "Europe/Paris",
    });
    const trigger = routineTrigger(input);
    const read = parseTimeTrigger(trigger.kind, trigger.config, input.timezone);
    assert.equal(read.ok, true, `${cadence}: ${read.ok ? "" : read.message}`);
  }
});

test("every starting point is hireable as it stands", () => {
  const ids = new Set<string>();
  for (const template of AGENT_TEMPLATES) {
    assert.ok(!ids.has(template.id), `duplicate template ${template.id}`);
    ids.add(template.id);
    const parsed = createAgentSchema.safeParse({
      name: template.names[0],
      role: template.role,
      avatar: template.avatar,
      style: template.style,
      instructions: template.instructions,
      approvalMode: template.approvalMode,
      template: template.id,
      ...(template.firstGoal ? { firstGoal: template.firstGoal } : {}),
    });
    assert.equal(parsed.success, true, template.id);
  }
});

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

test("an agent's block names it, carries its brief and active goals, and states the floor", () => {
  const block = buildAgentPromptBlock(
    {
      name: "Scout",
      role: "Research and briefings",
      style: "direct",
      instructions: "Prefer primary sources.",
      approvalMode: "permissive",
      goals: [
        { title: "Track the EU AI Act", status: "active", lastCheckInNote: "Two new drafts this week." },
        { title: "Old goal", status: "achieved", lastCheckInNote: null },
      ],
      notes: [{ content: "Prefers bullet points", source: "user" }],
      teammates: [{ name: "Atlas", role: "Inbox" }],
      taskHandoff: true,
    },
    "Liam"
  );
  assert.match(block, /You are Scout, one of Liam's agents/);
  assert.match(block, /Prefer primary sources\./);
  assert.match(block, /Track the EU AI Act \(last check-in: Two new drafts this week\.\)/);
  assert.doesNotMatch(block, /Old goal/);
  assert.match(block, /Prefers bullet points/);
  assert.match(block, /Atlas: Inbox/);
  // The autonomy is named by its promise, and the floor is stated under every mode.
  assert.match(block, /Just do it/);
  assert.match(block, /always stop for Liam's approval/);
  assert.match(block, /start_task/);
});

test("the block never describes a tool the turn does not carry", () => {
  const block = buildAgentPromptBlock({
    name: "Scout",
    role: "",
    style: "warm",
    instructions: "",
    approvalMode: "balanced",
    goals: [],
    notes: [],
    teammates: [],
    taskHandoff: false,
  });
  assert.doesNotMatch(block, /start_task/);
  assert.doesNotMatch(block, /hand_off_to_teammate/);
  assert.equal(appendAgentBlock("base", null), "base");
  assert.equal(appendAgentBlock("base", block), `base\n\n${block}`);
});

test("teammates are named either way, and the handoff is described only on a turn that carries it", () => {
  const context = {
    name: "Scout",
    role: "Research",
    style: "warm",
    instructions: "",
    approvalMode: "balanced",
    goals: [],
    notes: [],
    teammates: [{ name: "Atlas", role: "Inbox" }],
    taskHandoff: true,
  };
  const without = buildAgentPromptBlock(context, "Liam");
  assert.match(without, /Atlas: Inbox/);
  assert.match(without, /you cannot message them yourself/);
  assert.doesNotMatch(without, /hand_off_to_teammate/);
  assert.equal(buildAgentPromptBlock({ ...context, handoff: false }, "Liam"), without);

  const withHandoff = buildAgentPromptBlock({ ...context, handoff: true }, "Liam");
  assert.match(withHandoff, /Atlas: Inbox/);
  assert.match(withHandoff, /When Liam asks you to pass work to one of them, or agrees when you suggest it, hand it over with hand_off_to_teammate/);
  assert.match(withHandoff, /they report back there, not here/);
  assert.doesNotMatch(withHandoff, /you cannot message them yourself/);

  // With nobody to hand to there is no section at all, so nothing to describe.
  assert.doesNotMatch(buildAgentPromptBlock({ ...context, teammates: [], handoff: true }), /hand_off_to_teammate|teammates/i);
});

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

const REFLECT_CONTEXT = {
  goalCount: 2,
  openIdeas: ["Draft the weekly digest"],
  dismissedIdeas: ["Compare three CRMs"],
  knownNotes: ["Prefers bullet points"],
};

test("a reflection keeps bounded, fresh ideas and drops irreversible ones", () => {
  const text = `Here you go:\n\`\`\`json\n${JSON.stringify({
    ideas: [
      { title: "Buy the cheaper laptop", detail: "It dropped", prompt: "Buy it", goal: 0 },
      { title: "Draft the weekly digest", detail: "", prompt: "Draft it", goal: 0 },
      { title: "compare three CRMs!", detail: "", prompt: "Compare", goal: null },
      { title: "Research flight prices for October", detail: "Prices move", prompt: "Research flights", goal: 1 },
      { title: "Summarise new EU AI Act drafts", detail: "", prompt: "Summarise", goal: 7 },
      { title: "Outline the Q4 plan", detail: "", prompt: "Outline" },
      { title: "One too many", detail: "", prompt: "x" },
    ],
    checkIns: [
      { goal: 1, note: "Nothing booked yet." },
      { goal: 1, note: "A duplicate." },
      { goal: 9, note: "Out of range." },
    ],
    notes: ["Prefers bullet points", "Lives in Paris", "Travels in October", "A third note"],
  })}\n\`\`\``;
  const result = parseReflection(text, REFLECT_CONTEXT);
  assert.ok(result);
  assert.deepEqual(
    result.ideas.map((idea) => idea.title),
    ["Research flight prices for October", "Summarise new EU AI Act drafts", "Outline the Q4 plan"]
  );
  assert.equal(result.ideas.length, REFLECTION_MAX_IDEAS);
  assert.equal(result.ideas[0].goalIndex, 1);
  assert.equal(result.ideas[1].goalIndex, null);
  assert.deepEqual(result.checkIns, [{ goalIndex: 1, note: "Nothing booked yet." }]);
  assert.deepEqual(result.notes, ["Lives in Paris", "Travels in October"]);
});

test("no JSON is no answer, and an empty object is an honest nothing", () => {
  assert.equal(parseReflection("I have no ideas today.", REFLECT_CONTEXT), null);
  assert.equal(parseReflection("{not json", REFLECT_CONTEXT), null);
  assert.deepEqual(parseReflection("{}", REFLECT_CONTEXT), { ideas: [], checkIns: [], notes: [] });
});

test("a reflection reads titles and statuses, never task content", () => {
  const message = reflectionUserMessage({
    agentName: "Scout",
    role: "Research",
    instructions: "",
    goals: [{ title: "Track the EU AI Act", detail: "", lastCheckInNote: null }],
    notes: [],
    tasks: [{ title: "Summarise drafts", status: "completed", when: "today at 09:00" }],
    openIdeas: [],
    dismissedIdeas: [],
    today: "2026-09-24",
  });
  assert.match(message, /0\. Track the EU AI Act/);
  assert.match(message, /- Summarise drafts: completed \(today at 09:00\)/);
});

test("onboarding, selfConfig, recent work untrusted wrapping, and paused state in buildAgentPromptBlock", () => {
  const onboardingBlock = buildAgentPromptBlock(
    {
      name: "Scout",
      role: "Research",
      style: "warm",
      instructions: "Short brief.",
      approvalMode: "balanced",
      goals: [],
      notes: [],
      teammates: [],
      taskHandoff: true,
      selfConfig: true,
      routinesCount: 0,
      recentWork: [
        {
          title: "Invoice sweep",
          status: "completed",
          summary: "Found 3 unpaid invoices totaling €4,200.",
        },
      ],
    },
    "Liam"
  );
  assert.match(onboardingBlock, /This teammate was created without a configuration form/);
  assert.match(onboardingBlock, /## Configuring yourself/);
  assert.match(onboardingBlock, /<<<JUNO_UNTRUSTED_BEGIN>>> source=recent_work/);
  assert.match(onboardingBlock, /<untrusted source="recent_work">/);
  assert.match(onboardingBlock, /Invoice sweep \(completed\): Found 3 unpaid invoices/);

  const voiceBlock = buildAgentPromptBlock(
    {
      name: "Scout",
      role: "Research",
      style: "warm",
      instructions: "Short brief.",
      approvalMode: "balanced",
      goals: [],
      notes: [],
      teammates: [],
      taskHandoff: false,
      selfConfig: false,
    },
    "Liam"
  );
  assert.doesNotMatch(voiceBlock, /## Configuring yourself/);
  assert.doesNotMatch(voiceBlock, /This teammate was created without a configuration form/);

  const pausedBlock = buildAgentPromptBlock(
    {
      name: "Scout",
      role: "Research",
      style: "warm",
      instructions: "Short brief.",
      approvalMode: "balanced",
      goals: [],
      notes: [],
      teammates: [{ name: "Atlas", role: "Inbox" }],
      taskHandoff: true,
      handoff: true,
      selfConfig: true,
      paused: true,
    },
    "Liam"
  );
  assert.match(pausedBlock, /You are currently paused/);
  assert.doesNotMatch(pausedBlock, /start_task/);
  assert.doesNotMatch(pausedBlock, /hand_off_to_teammate/);
});

