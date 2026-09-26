import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VOICE_MEMORY_MAX_CHARS, parseVoiceMemoryRequest, voiceMemoryInstructions } from "@/lib/voice-memory";

/*
 * Voice mode reads memory.
 *
 * A voice call ran on the relay's fixed instructions and the chat's recent
 * turns: whoever typed to Juno all year was a stranger the moment they pressed
 * the microphone. Now a chat's call carries what that chat would know —
 * fetched by the relay from the app, server to server, never through the
 * browser — and what is said aloud is learned from as soon as it is saved.
 * The relay's half is tested in relay/tests/voice-memory.test.ts.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

test("nothing remembered, no block", () => {
  assert.equal(voiceMemoryInstructions({ summary: null, recent: [], scope: "account" }), null);
  assert.equal(voiceMemoryInstructions({ summary: "  ", recent: [" "], scope: "account" }), null);
});

test("the summary arrives as plain speech-ready text, with the notes after it", () => {
  const block = voiceMemoryInstructions({
    summary: "## Work context\nThe user is a **product designer** at [Globex](https://globex.test).\n\n## Preferences\n- Prefers detailed answers.",
    recent: ["The user is learning Portuguese."],
    scope: "account",
  })!;
  assert.match(block, /^What you already know about this user, from earlier conversations\./);
  assert.match(block, /Work context:\nThe user is a product designer at Globex\./);
  assert.match(block, /Preferences:\n- Prefers detailed answers\./);
  assert.match(block, /More recent notes:\n- The user is learning Portuguese\.$/);
  assert.equal(/[#*]|\]\(/.test(block), false);
});

test("the model is told not to recite it, and that what is said now wins", () => {
  const block = voiceMemoryInstructions({ summary: null, recent: ["The user likes tea."], scope: "account" })!;
  assert.match(block, /never recite it, never read it out as a list/);
  assert.match(block, /what they say now wins/);
  assert.match(block, /Notes:\n- The user likes tea\./);
});

test("a project call is told its memory is the project's", () => {
  const block = voiceMemoryInstructions({ summary: "## Purpose & context\nA thesis.", recent: [], scope: "project" })!;
  assert.match(block, /^What you already know from this project's chats/);
});

test("an oversized block is cut at a line, under the cap", () => {
  const recent = Array.from({ length: 300 }, (_, i) => `The user noted item number ${i} at some length.`);
  const block = voiceMemoryInstructions({ summary: null, recent, scope: "account" })!;
  assert.ok(block.length <= VOICE_MEMORY_MAX_CHARS);
  assert.match(block, /length\.$/);
});

// ---------------------------------------------------------------------------
// Asking for it
// ---------------------------------------------------------------------------

test("memory is asked for explicitly, and a malformed project asks for none", () => {
  assert.equal(parseVoiceMemoryRequest(new URLSearchParams("")), null);
  assert.deepEqual(parseVoiceMemoryRequest(new URLSearchParams("memory=1")), { projectId: null });
  assert.deepEqual(parseVoiceMemoryRequest(new URLSearchParams("memory=1&projectId=cm1a2b3c4d5e6f7g8h9i0j")), {
    projectId: "cm1a2b3c4d5e6f7g8h9i0j",
  });
  // Not "the account's memory instead" — a project call reading account
  // memory is the leak project isolation exists to prevent.
  assert.equal(parseVoiceMemoryRequest(new URLSearchParams("memory=1&projectId=../../x")), null);
  assert.equal(parseVoiceMemoryRequest(new URLSearchParams("memory=true")), null);
});

// ---------------------------------------------------------------------------
// Wiring — app side
// ---------------------------------------------------------------------------

test("the token carries a memory grant only after the project is shown to be usable", () => {
  const route = src("src/app/api/voice/relay-token/route.ts");
  assert.match(route, /const params = new URL\(req\.url\)\.searchParams;/);
  assert.match(route, /parseVoiceMemoryRequest\(params\)/);
  assert.match(route, /checkProjectAccess\(user\.id, memory\.projectId, "VIEWER"\)\)\.allowed\) \{[\s\S]{0,300}memory = null;/);
  assert.match(route, /\.\.\.\(memory \? \{ mem: 1, \.\.\.\(memory\.projectId \? \{ pid: memory\.projectId \} : \{\}\) \} : \{\}\)/);
});

test("the memory route answers only the relay, only for memory, under every chat rule", () => {
  const route = src("src/app/api/voice/memory/route.ts");
  assert.match(route, /const AUDIENCE = "juno\.voice\.memory";/);
  assert.match(route, /if \(payload\.aud !== AUDIENCE\) return null;/);
  assert.match(route, /if \(settings\?\.memoryEnabled === false\) return NextResponse\.json\(\{ instructions: null \}\);/);
  assert.match(route, /checkProjectAccess\(userId, projectId, "VIEWER"\)/);
  assert.match(route, /workspacePermits\(parseWorkspaceConfig\(workspace\?\.config\), "memoryRecall"\)/);
  // The same retrieval a typed turn uses — isolation included.
  assert.match(route, /getMemoryProfile\(userId, \{\s+projectId,/);
});

test("a chat asks for memory for its calls — its project's — and never in incognito", () => {
  const chat = src("src/components/chat/chat-view.tsx");
  // The thread rides beside memory (tests/voice-persona.test.ts), under the
  // same incognito rule: a private chat asks for neither.
  assert.match(
    chat,
    /realtimeVoice\.start\(\s*undefined,\s*history,\s*privateMode \? undefined : \{ memory: \{ projectId: activeProjectId \}, conversationId: currentConversationId \?\? null \}\s*\)/
  );
  const hook = src("src/hooks/use-realtime-voice.ts");
  assert.match(hook, /if \(!isReconnect\) memoryRef\.current = opts\?\.memory \?\? null;/);
  assert.match(hook, /memory: "1",/);
  assert.match(hook, /setMemoryOn\(msg\.memory === true\);/);
});

test("the call says when it knows what Juno remembers — only once the relay confirms it", () => {
  const dock = src("src/components/voice/realtime-voice.tsx");
  // Said in the call's detail line (the status tooltip), and only once confirmed.
  assert.match(dock, /voice\.memory \? "remembers you" : null/);
  // Both copies of the protocol carry the flag.
  assert.match(src("relay/src/protocol.ts"), /memory\?: boolean;/);
  assert.match(src("src/lib/voice-relay-protocol.ts"), /memory\?: boolean;/);
});

test("what is said aloud is learned from as soon as it is saved, under the typed turn's gates", () => {
  const route = src("src/app/api/voice/transcript/route.ts");
  const fn = route.slice(route.indexOf("function learnFromVoiceLater("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /after\(async \(\) => \{/);
  assert.match(body, /if \(settings\?\.memoryEnabled === false \|\| !convo\) return;/);
  assert.match(body, /"memoryRecall"\)\) return;/);
  assert.match(body, /await extractConversationMemory\(\{ userId, conversationId \}\);/);
  assert.match(route, /learnFromVoiceLater\(user\.id, result\.conversationId\);/);
});

// ---------------------------------------------------------------------------
// Wiring — relay side
// ---------------------------------------------------------------------------

test("the relay fetches memory server to server, under a memory-scoped token, once per call", () => {
  const session = src("relay/src/session.ts");
  assert.match(session, /\/api\/voice\/memory`/);
  assert.match(session, /mintRelayCallbackToken\(userId, 60, "juno\.voice\.memory"/);
  // Memory is folded into every connect's instructions, beside the persona
  // when the call is an agent's (tests/voice-persona.test.ts).
  assert.match(session, /instructions: voiceInstructions\(this\.memory \?\? null, this\.persona\?\.instructions \?\? null\),\s+transcript: this\.transcript\.slice\(-30\),/);
  assert.match(session, /if \(this\.memory !== undefined\) return;/);
  // A memory fetch that fails is a call without memory, never a failed call.
  assert.match(session, /this\.memory = await fetchMemory\(this\.userId, grant\)\.catch\(\(\) => null\);/);
  assert.match(src("relay/src/server.ts"), /new RelaySession\(ws, userId, \{ memory: grant\.memory, agentId: grant\.agentId \?\? null \}\)/);
});
