import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAgentPromptBlock } from "@/lib/agents/prompt";
import { defaultAgentAvatar } from "@/lib/agents/avatar";
import type { ClientAgent } from "@/lib/agents/types";
import type { VoicePhase } from "@/lib/voice-phase";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { threadAgentState } from "@/components/agents/thread-agent-state";
import {
  VOICE_PERSONA_MAX_CHARS,
  VOICE_SLOT_COUNT,
  agentVoiceSlot,
  parseVoiceConversationRequest,
  voicePersonaInstructions,
} from "@/lib/voice-persona";

/*
 * A voice call in an agent's thread is that agent, and its face listens.
 *
 * The call used to answer as Juno whatever thread it was opened in, and the
 * face in the thread's header never left the state its task gave it. Now the
 * token names the thread's agent once the app has found it behind one of the
 * person's own conversations, the relay asks for the agent's persona server to
 * server, and the face listens — pupils on the caller's level — while the call
 * is open. The relay's half is relay/tests/voice-persona.test.ts.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const block = (instructions: string, notes: string[] = []) =>
  buildAgentPromptBlock(
    {
      name: "Quill",
      role: "Writer",
      style: "warm",
      instructions,
      approvalMode: "balanced",
      goals: [{ title: "Ship the **launch** post", status: "active", lastCheckInNote: null }],
      notes: notes.map((content) => ({ content, source: "reflection" })),
      teammates: [{ name: "Scout", role: "Researcher" }],
      taskHandoff: false,
    },
    "Liam"
  );

// ---------------------------------------------------------------------------
// The persona
// ---------------------------------------------------------------------------

test("no block, no persona", () => {
  assert.equal(voicePersonaInstructions(null), null);
  assert.equal(voicePersonaInstructions("  \n "), null);
});

test("the chat's block arrives as plain spoken text, and names the person", () => {
  const text = voicePersonaInstructions(
    block("## Voice\nWrite like **Liam**, see [the guide](https://x.test).\n* Short `sentences`."),
    "Liam"
  )!;
  assert.match(text, /^Who you are in this conversation:\nYou are Quill, one of Liam's agents in Juno\./);
  assert.match(text, /Your brief:\nVoice:\nWrite like Liam, see the guide\.\n- Short sentences\./);
  assert.match(text, /Goals you are working towards:\n- Ship the launch post/);
  // No Markdown a speaking model could pick up the habit of reading aloud.
  assert.equal(/[#*`]|\]\(/.test(text), false);
  // Built without the task tool: a call has none.
  assert.equal(/start_task|background task/.test(text), false);
});

test("the last line says it is a call and that nothing is started from it", () => {
  const text = voicePersonaInstructions(block("Draft things."), "Liam")!;
  const last = text.split("\n").at(-1)!;
  assert.match(last, /^You are on a voice call with Liam in your thread\./);
  assert.match(last, /cannot start tasks or use tools from a call/);
  assert.match(last, /never say you have started or done something/);
  assert.match(voicePersonaInstructions(block("Draft things."))!, /voice call with the person you work for/);
});

test("an oversized persona is cut at a line under the cap, and the call line survives it", () => {
  const brief = Array.from({ length: 200 }, (_, i) => `Rule ${i}: keep the paragraph at a readable length.`).join("\n");
  const notes = Array.from({ length: 24 }, (_, i) => `Liam prefers option ${i} when it is quiet.`);
  const text = voicePersonaInstructions(block(brief, notes), "Liam")!;
  assert.ok(text.length <= VOICE_PERSONA_MAX_CHARS, `${text.length} > ${VOICE_PERSONA_MAX_CHARS}`);
  assert.match(text, /readable length\.\n\nYou are on a voice call with Liam/);
  assert.match(text, /from a call, so never say/);
  assert.ok(text.startsWith("Who you are in this conversation:"));
});

// ---------------------------------------------------------------------------
// The voice slot
// ---------------------------------------------------------------------------

test("an agent keeps its voice slot, and agents spread over the slots", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `cm${String(i).padStart(3, "0")}agentidentifier0000`);
  for (const id of ids) {
    const slot = agentVoiceSlot(id);
    assert.equal(slot, agentVoiceSlot(id));
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < VOICE_SLOT_COUNT);
  }
  // The relay picks slot % list length; every vetted list divides the range.
  for (const length of [8, 10]) assert.equal(VOICE_SLOT_COUNT % length, 0);
  assert.ok(new Set(ids.map((id) => agentVoiceSlot(id) % 8)).size >= 4);
});

// ---------------------------------------------------------------------------
// Asking for it
// ---------------------------------------------------------------------------

test("the thread is named by a conversation id, or not at all", () => {
  assert.equal(parseVoiceConversationRequest(new URLSearchParams("")), null);
  assert.equal(parseVoiceConversationRequest(new URLSearchParams("memory=1")), null);
  assert.equal(
    parseVoiceConversationRequest(new URLSearchParams("memory=1&conversationId=cm1a2b3c4d5e6f7g8h9i0jk")),
    "cm1a2b3c4d5e6f7g8h9i0jk"
  );
  assert.equal(parseVoiceConversationRequest(new URLSearchParams("conversationId=../../x")), null);
  assert.equal(parseVoiceConversationRequest(new URLSearchParams("agentId=cm1a2b3c4d5e6f7g8h9i0jk")), null);
});

test("the token names an agent only behind the person's own conversation, and never fails for it", () => {
  const route = src("src/app/api/voice/relay-token/route.ts");
  assert.match(route, /threadAgent\(user\.id, parseVoiceConversationRequest\(params\)\)/);
  assert.match(route, /prisma\.conversation\.findFirst\(\{\s+where: \{ id: conversationId, userId \},/);
  assert.match(route, /prisma\.agent\.findFirst\(\{\s+where: \{ id: conversation\.agentId, userId, deletedAt: null \},/);
  assert.match(route, /\.\.\.\(agentId \? \{ aid: agentId \} : \{\}\)/);
  // A lookup that throws is a call with Juno, not a failed token.
  const helper = route.slice(route.indexOf("async function threadAgent("));
  assert.match(helper, /\} catch \{\s+return null;\s+\}/);
});

test("the persona route answers only the relay, only for the agent it signed, as the chat would", () => {
  const route = src("src/app/api/voice/persona/route.ts");
  assert.match(route, /const AUDIENCE = "juno\.voice\.persona";/);
  assert.match(route, /if \(payload\.aud !== AUDIENCE\) return null;/);
  assert.match(route, /typeof payload\.aid !== "string"/);
  assert.match(route, /agentChatContext\(user, agentId, \{ taskHandoff: false \}\)/);
  // Retired, or not theirs: nobody.
  assert.match(route, /if \(!context\) return NextResponse\.json\(\{ instructions: null \}\);/);
  assert.match(route, /voiceSlot: agentVoiceSlot\(context\.agent\.id\)/);
});

test("a chat names its thread for its calls, kept across reconnects and retries, never in incognito", () => {
  const hook = src("src/hooks/use-realtime-voice.ts");
  assert.match(hook, /if \(!isReconnect\) conversationRef\.current = opts\?\.conversationId \?\? null;/);
  assert.match(hook, /\.\.\.\(conversationId \? \{ conversationId \} : \{\}\)/);
  assert.match(hook, /setPersonaOn\(msg\.persona === true\);/);
  assert.match(hook, /start\(undefined, undefined, \{ memory: memoryRef\.current, conversationId: conversationRef\.current \}\)/);
  const chat = src("src/components/chat/chat-view.tsx");
  assert.match(chat, /privateMode \? undefined : \{ memory: \{ projectId: activeProjectId \}, conversationId: currentConversationId \?\? null \}/);
  // The bar names the agent only once the relay confirms the call is it.
  assert.equal(chat.match(/<RealtimeVoice voice=\{realtimeVoice\} onClose=\{closeVoice\} speakerName=\{agent\?\.name\} \/>/g)?.length, 2);
  const bar = src("src/components/voice/realtime-voice.tsx");
  assert.match(bar, /const speaker = voice\.persona && speakerName \? speakerName : "Juno";/);
  assert.match(bar, /label=\{`Stop \$\{speaker\} speaking`\}/);
  assert.match(bar, /announcementFor\(phase, prevPhase\.current, speaker\)/);
  // Both copies of the protocol carry the flag.
  assert.match(src("relay/src/protocol.ts"), /persona\?: boolean;/);
  assert.match(src("src/lib/voice-relay-protocol.ts"), /persona\?: boolean;/);
});

// ---------------------------------------------------------------------------
// The face listens
// ---------------------------------------------------------------------------

const agent: ClientAgent = {
  id: "cm1a2b3c4d5e6f7g8h9i0jk",
  name: "Quill",
  role: "Writer",
  avatar: defaultAgentAvatar("cm1a2b3c4d5e6f7g8h9i0jk"),
  style: "warm",
  instructions: "",
  model: null,
  reasoningEffort: null,
  approvalMode: "balanced",
  connectorIds: [],
  projectId: null,
  conversationId: "cm9z8y7x6w5v4u3t2s1r0qp",
  status: "active",
  proactive: true,
  template: null,
  lastReflectedAt: null,
  sortOrder: 0,
  createdAt: "2026-09-24T09:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
  state: "idle",
  stateSentence: "Ready for something new",
  task: null,
  needsYou: 0,
  nextRoutine: null,
  newIdeas: 0,
};

const running = {
  id: "cmsession00000000000000",
  title: "Draft the launch post",
  status: "running",
  needsAttention: false,
  lastActivityAt: new Date().toISOString(),
} as ClientWorkSession;

test("an open call is listening, and thinking while it composes an answer", () => {
  for (const phase of ["connecting", "listening", "user-speaking", "speaking", "muted"] as VoicePhase[]) {
    assert.equal(threadAgentState(agent, false, null, phase), "listening", phase);
    // A call left open while its task runs is still a call the face listens to.
    assert.equal(threadAgentState(agent, false, running, phase), "listening", phase);
  }
  assert.equal(threadAgentState(agent, false, running, "thinking"), "thinking");
});

test("no call, an ended one or a failed one: the face is what it was", () => {
  for (const phase of [null, "idle", "error"] as (VoicePhase | null)[]) {
    assert.equal(threadAgentState(agent, false, null, phase), "idle");
    assert.equal(threadAgentState(agent, true, null, phase), "thinking");
    assert.equal(threadAgentState(agent, false, running, phase), "working");
  }
  // Three arguments are what every caller before the call passed.
  assert.equal(threadAgentState({ ...agent, state: "waiting" }, false, null), "waiting");
});

test("the pupils follow the level only while listening, and only where motion is wanted", () => {
  const header = src("src/components/agents/agent-thread-header.tsx");
  assert.match(header, /const listening = state === "listening" && !!levelRef;/);
  assert.match(header, /if \(!listening \|\| !levelRef \|\| !face\) return;/);
  assert.match(header, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches\) return;/);
  assert.match(header, /cancelAnimationFrame\(raf\);\s+face\.style\.removeProperty\("--level"\);/);
  const chat = src("src/components/chat/chat-view.tsx");
  assert.match(chat, /threadAgentState\(agent, chat\.isBusy, work\.session, voiceOpen \? voicePhaseOf\(realtimeVoice\) : null\)/);
  assert.match(chat, /levelRef=\{voiceOpen \? realtimeVoice\.levelRef : undefined\}/);

  const css = src("src/app/globals.css");
  const still = css.indexOf('.agent-face[data-state="listening"] .agent-face__eye { transform: scale(1.15); }');
  const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)", css.indexOf("AGENT FACES"));
  const driven = css.indexOf('.agent-face[data-state="listening"] .agent-face__eye { transform: scale(calc(1.15 + var(--level, 0) * 0.3)); }');
  assert.ok(still > 0 && motion > still && driven > motion, "the level-driven scale sits inside the motion block, after the still one");
});

test("the server still never reports listening", () => {
  assert.match(src("src/lib/agents/domain.ts"), /\): Exclude<AgentState, "thinking" \| "listening"> \{/);
});

// ---------------------------------------------------------------------------
// Thread-first hire & /agents/[id] redirect
// ---------------------------------------------------------------------------

test("hiring lands directly in the agent's thread and /agents/[id] redirects to /chat/<conversationId>", () => {
  const page = src("src/app/(app)/agents/[id]/page.tsx");
  assert.match(page, /ensureAgentThread/);
  assert.match(page, /redirect\(`\/chat\/\$\{encodeURIComponent\(conversationId\)\}/);

  const greeting = src("src/components/agents/agent-thread-header.tsx");
  assert.match(greeting, /Tell me what you'd like me to take on and I'll set myself up\./);
});

