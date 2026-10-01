import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { mintRelayCallbackToken, verifyRelayToken } from "../src/auth.js";
import { GeminiLiveSession } from "../src/providers/gemini-live.js";
import { MockVoiceSession } from "../src/providers/mock.js";
import { OpenAiVoiceSession } from "../src/providers/openai-voice.js";
import { AGENT_VOICES, agentVoice } from "../src/providers/registry.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import {
  RelaySession,
  VOICE_PERSONA_MAX_CHARS,
  fetchVoicePersona,
  voiceInstructions,
  type VoicePersona,
} from "../src/session.js";

/*
 * A voice call in an agent's thread is that agent.
 *
 * The app resolves the thread's conversation to its agent before it signs the
 * call's token; the relay then asks the app for the agent's persona, server to
 * server, beside memory, and speaks it in a voice of its own — the same voice
 * every call, on every provider that has a vetted list. A call that cannot
 * reach the persona is still a call, answered by Juno. The app's half is
 * tests/voice-persona.test.ts at the repo root.
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";

const seeds: { provider: string; seed: VoiceSessionSeed }[] = [];
function record<T extends { connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> }>(
  proto: T,
  provider: string,
  passThrough: boolean
) {
  const original = proto.connect;
  proto.connect = async function (this: T, seed: VoiceSessionSeed, events: ProviderEvents) {
    seeds.push({ provider, seed });
    if (passThrough) return original.call(this, seed, events);
  };
}
record(MockVoiceSession.prototype, "mock", true);
// Neither of these may reach the network here: record what they were given.
record(OpenAiVoiceSession.prototype, "openai", false);
record(GeminiLiveSession.prototype, "gemini", false);

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Record<string, unknown>[] = [];
  send(data: unknown): void {
    if (typeof data === "string") this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  ready() {
    return this.frames.filter((frame) => frame.type === "session.ready");
  }
}

const AGENT = "cm1a2b3c4d5e6f7g8h9i0jk";
const PERSONA = "Who you are in this conversation:\nYou are Quill, one of Liam's agents in Juno.";
const MEMORY = "What you already know about this user, from earlier conversations.\n\nThe user likes tea.";

function call(opts: ConstructorParameters<typeof RelaySession>[2]) {
  seeds.length = 0;
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", opts);
  return { ws, session };
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test("without a persona the instructions are Juno's, byte for byte", () => {
  assert.equal(voiceInstructions(null, null), voiceInstructions(null));
  assert.equal(voiceInstructions(MEMORY, null), voiceInstructions(MEMORY));
  assert.match(voiceInstructions(null), /^You are Alevr, a warm, quick-witted voice assistant\. You are having a spoken conversation: /);
});

test("a persona replaces who is speaking, keeps how, and memory still follows", () => {
  const text = voiceInstructions(MEMORY, PERSONA);
  assert.ok(text.startsWith(PERSONA));
  assert.equal(text.includes("You are Alevr"), false);
  assert.match(text, /\n\nYou are having a spoken conversation: keep replies short/);
  assert.ok(text.endsWith("The user likes tea."));
  assert.ok(voiceInstructions(null, PERSONA).endsWith("pick up naturally."));
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function sessionToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("base64url");
  return `${body}.${mac}`;
}

const inAMinute = () => Math.floor(Date.now() / 1000) + 60;

test("a session token names the agent only when the app signed one in", () => {
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), aid: AGENT })), {
    userId: "u",
    memory: null,
    agentId: AGENT,
  });
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), mem: 1, aid: AGENT })), {
    userId: "u",
    memory: { projectId: null },
    agentId: AGENT,
  });
  // No claim, or one that is not an id: the grant a token always gave.
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute() })), { userId: "u", memory: null });
  for (const aid of ["", "../../x", 42, "a".repeat(80)]) {
    assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), aid })), { userId: "u", memory: null });
  }
});

test("a persona callback token names its purpose and agent, and opens no session", () => {
  const token = mintRelayCallbackToken("u", 60, "juno.voice.persona", { aid: AGENT });
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.aud, "juno.voice.persona");
  assert.equal(payload.aid, AGENT);
  assert.equal(payload.pid, undefined);
  assert.equal(verifyRelayToken(token), null);
  // Memory's token does not carry the agent.
  const memory = JSON.parse(Buffer.from(mintRelayCallbackToken("u", 60, "juno.voice.memory").split(".")[0], "base64url").toString("utf8"));
  assert.equal(memory.aid, undefined);
});

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

test("a call in an agent's thread is the agent, fetched beside memory, and says so", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { ws, session } = call({
    memory: { projectId: null },
    agentId: AGENT,
    fetchMemory: async () => {
      started.push("memory");
      await gate;
      return MEMORY;
    },
    fetchPersona: async (_userId, agentId) => {
      started.push(`persona:${agentId}`);
      await gate;
      return { instructions: PERSONA, voiceSlot: 3 };
    },
  });
  try {
    const starting = session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    await new Promise((resolve) => setImmediate(resolve));
    // Both asked before either answered: side by side, not one after the other.
    assert.deepEqual(started.sort(), ["memory", `persona:${AGENT}`]);
    release();
    await starting;
    assert.equal(seeds[0].seed.instructions, voiceInstructions(MEMORY, PERSONA));
    // The mock has no vetted voices: its default, not a name it cannot say.
    assert.equal(seeds[0].seed.voice, undefined);
    assert.equal(ws.ready()[0]?.persona, true);
    assert.equal(ws.ready()[0]?.memory, true);
  } finally {
    await session.destroy();
  }
});

test("a call with no agent never asks, and its ready frame is what it was", async () => {
  let asked = 0;
  const { ws, session } = call({
    memory: null,
    fetchPersona: async () => {
      asked++;
      return { instructions: PERSONA, voiceSlot: 0 };
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.equal(asked, 0);
    assert.equal(seeds[0].seed.instructions, voiceInstructions(null));
    assert.equal("persona" in (ws.ready()[0] ?? {}), false);
  } finally {
    await session.destroy();
  }
});

test("a call that cannot reach the persona is Juno, and says so without an error", async () => {
  const { ws, session } = call({
    agentId: AGENT,
    fetchPersona: async () => {
      throw new Error("app unreachable");
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.equal(seeds[0].seed.instructions, voiceInstructions(null));
    assert.equal(ws.ready()[0]?.persona, false);
    assert.equal(ws.frames.some((frame) => frame.type === "error"), false);
  } finally {
    await session.destroy();
  }
});

test("the persona is fetched once, and the voice is chosen again on every switch", async () => {
  process.env.OPENAI_API_KEY = "test";
  process.env.GEMINI_LIVE_API_KEY = "test";
  let asked = 0;
  const persona: VoicePersona = { instructions: PERSONA, voiceSlot: 13 };
  const { session } = call({
    agentId: AGENT,
    fetchPersona: async () => {
      asked++;
      return persona;
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "openai" }));
    await session.handleText(JSON.stringify({ type: "session.switch", provider: "gemini" }));
    await session.handleText(JSON.stringify({ type: "session.switch", provider: "mock" }));
    assert.equal(asked, 1);
    assert.deepEqual(
      seeds.map(({ provider, seed }) => [provider, seed.voice]),
      [
        ["openai", AGENT_VOICES.openai![13 % 10]],
        ["gemini", AGENT_VOICES.gemini![13 % 8]],
        ["mock", undefined],
      ]
    );
    for (const { seed } of seeds) assert.equal(seed.instructions, voiceInstructions(null, PERSONA));
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_LIVE_API_KEY;
    await session.destroy();
  }
});

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

test("an agent's voice is stable, vetted, and absent where nothing is vetted", () => {
  assert.equal(agentVoice("openai", 0), "alloy");
  assert.equal(agentVoice("openai", 10), "alloy");
  assert.equal(agentVoice("openai", 8), "marin");
  assert.equal(agentVoice("gemini", 3), "Fenrir");
  assert.equal(agentVoice("gemini", 3), agentVoice("gemini", 3 + AGENT_VOICES.gemini!.length));
  for (const provider of ["qwen", "minimax", "mock"] as const) assert.equal(agentVoice(provider, 5), undefined);
  for (const slot of [null, -1, 1.5, Number.NaN]) assert.equal(agentVoice("openai", slot), undefined);
});

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

test("the fetch asks the app's persona route under an agent-scoped token, and bounds the answer", async () => {
  process.env.JUNO_APP_URL = "https://juno.example/";
  const seen: { url: string; auth: string | null }[] = [];
  const answer = (body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  try {
    const persona = await fetchVoicePersona(
      "user-1",
      AGENT,
      answer({ instructions: `\u0000${"x".repeat(VOICE_PERSONA_MAX_CHARS * 2)}`, voiceSlot: 7 })
    );
    assert.equal(seen[0].url, "https://juno.example/api/voice/persona");
    const token = seen[0].auth?.replace(/^Bearer /, "") ?? "";
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    assert.deepEqual([payload.uid, payload.aud, payload.aid], ["user-1", "juno.voice.persona", AGENT]);
    assert.equal(persona?.instructions.length, VOICE_PERSONA_MAX_CHARS);
    assert.equal(persona?.instructions.includes("\u0000"), false);
    assert.equal(persona?.voiceSlot, 7);
    // A slot that is not a whole, non-negative number is no slot.
    for (const voiceSlot of [-1, 2.5, "3", null]) {
      assert.equal((await fetchVoicePersona("u", AGENT, answer({ instructions: PERSONA, voiceSlot })))?.voiceSlot, null);
    }
    // A retired agent answers null: no persona.
    assert.equal(await fetchVoicePersona("u", AGENT, answer({ instructions: null })), null);
  } finally {
    delete process.env.JUNO_APP_URL;
  }
});

test("no app configured, or an error: no persona", async () => {
  let called = 0;
  const count = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  assert.equal(await fetchVoicePersona("u", AGENT, count), null);
  assert.equal(called, 0);
  process.env.JUNO_APP_URL = "https://juno.example";
  try {
    const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    assert.equal(await fetchVoicePersona("u", AGENT, failing), null);
    const throwing = (async () => {
      throw new Error("network");
    }) as typeof fetch;
    assert.equal(await fetchVoicePersona("u", AGENT, throwing), null);
  } finally {
    delete process.env.JUNO_APP_URL;
  }
});
