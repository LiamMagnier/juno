import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { mintRelayCallbackToken, verifyRelayToken } from "../src/auth.js";
import { MockVoiceSession } from "../src/providers/mock.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import { RelaySession, VOICE_MEMORY_MAX_CHARS, fetchVoiceMemory, voiceInstructions } from "../src/session.js";

/*
 * A voice call that knows who it is talking to.
 *
 * The app mints the call's token; when the chat asked for memory, the token
 * says so (and names the project, if any). The relay then asks the app for
 * the memory block, server to server, and folds it into the provider's
 * instructions — once per call, surviving provider switches, and never at the
 * cost of the call when it cannot be had. These run the real RelaySession
 * against the dev-only mock provider, whose seed is recorded here.
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";

const seeds: VoiceSessionSeed[] = [];
const originalConnect = MockVoiceSession.prototype.connect;
MockVoiceSession.prototype.connect = async function (seed: VoiceSessionSeed, events: ProviderEvents) {
  seeds.push(seed);
  return originalConnect.call(this, seed, events);
};

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

const MEMORY = "What you already know about this user, from earlier conversations.\n\nThe user likes tea.";

async function call(opts: {
  memory?: { projectId: string | null } | null;
  fetchMemory?: (userId: string, grant: { projectId: string | null }) => Promise<string | null>;
}) {
  seeds.length = 0;
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", opts);
  return { ws, session };
}

test("a call whose token asked for memory is told what Juno remembers", async () => {
  const asked: { projectId: string | null }[] = [];
  const { ws, session } = await call({
    memory: { projectId: null },
    fetchMemory: async (_userId, grant) => {
      asked.push(grant);
      return MEMORY;
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.deepEqual(asked, [{ projectId: null }]);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].instructions, voiceInstructions(MEMORY));
    assert.ok(seeds[0].instructions.startsWith("You are Juno"));
    assert.ok(seeds[0].instructions.endsWith("The user likes tea."));
    assert.equal(ws.ready()[0]?.memory, true);
  } finally {
    await session.destroy();
  }
});

test("a call that did not ask never fetches, and says so", async () => {
  let fetched = 0;
  const { ws, session } = await call({
    memory: null,
    fetchMemory: async () => {
      fetched++;
      return MEMORY;
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.equal(fetched, 0);
    assert.equal(seeds[0].instructions, voiceInstructions(null));
    assert.equal(ws.ready()[0]?.memory, false);
  } finally {
    await session.destroy();
  }
});

test("memory is fetched once and survives a provider switch", async () => {
  let fetched = 0;
  const { session } = await call({
    memory: { projectId: "proj_thesis" },
    fetchMemory: async () => {
      fetched++;
      return MEMORY;
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    await session.handleText(JSON.stringify({ type: "session.switch", provider: "mock" }));
    assert.equal(fetched, 1);
    assert.equal(seeds.length, 2);
    for (const seed of seeds) assert.equal(seed.instructions, voiceInstructions(MEMORY));
  } finally {
    await session.destroy();
  }
});

test("a call that cannot reach memory is still a call", async () => {
  const { ws, session } = await call({
    memory: { projectId: null },
    fetchMemory: async () => {
      throw new Error("app unreachable");
    },
  });
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.equal(seeds[0].instructions, voiceInstructions(null));
    assert.equal(ws.ready()[0]?.memory, false);
    assert.equal(ws.frames.some((frame) => frame.type === "error"), false);
  } finally {
    await session.destroy();
  }
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

test("a session token grants memory only when the app signed it in", () => {
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), mem: 1, pid: "proj_1" })), {
    userId: "u",
    memory: { projectId: "proj_1" },
  });
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), mem: 1 })), {
    userId: "u",
    memory: { projectId: null },
  });
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute() })), { userId: "u", memory: null });
  // Anything but the exact grant is no grant.
  assert.deepEqual(verifyRelayToken(sessionToken({ uid: "u", exp: inAMinute(), mem: true })), {
    userId: "u",
    memory: null,
  });
});

test("a memory callback token names its purpose and project, and opens no session", () => {
  const token = mintRelayCallbackToken("u", 60, "juno.voice.memory", { pid: "proj_1" });
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.aud, "juno.voice.memory");
  assert.equal(payload.pid, "proj_1");
  assert.equal(verifyRelayToken(token), null);
  // The spend token keeps its own audience.
  const spend = JSON.parse(Buffer.from(mintRelayCallbackToken("u").split(".")[0], "base64url").toString("utf8"));
  assert.equal(spend.aud, "juno.voice.spend");
  assert.equal(spend.pid, undefined);
});

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

test("the fetch asks the app's memory route under a memory-scoped token, and bounds the answer", async () => {
  process.env.JUNO_APP_URL = "https://juno.example/";
  const seen: { url: string; auth: string | null }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ instructions: `\u0000${"x".repeat(VOICE_MEMORY_MAX_CHARS * 2)}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const text = await fetchVoiceMemory("user-1", { projectId: "proj_1" }, fake);
    assert.equal(seen[0].url, "https://juno.example/api/voice/memory");
    const token = seen[0].auth?.replace(/^Bearer /, "") ?? "";
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    assert.deepEqual([payload.uid, payload.aud, payload.pid], ["user-1", "juno.voice.memory", "proj_1"]);
    assert.equal(text?.length, VOICE_MEMORY_MAX_CHARS);
    assert.equal(text?.includes("\u0000"), false);
  } finally {
    delete process.env.JUNO_APP_URL;
  }
});

test("no app configured, an error, or an empty answer: no memory", async () => {
  let called = 0;
  const count = (async () => {
    called++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  assert.equal(await fetchVoiceMemory("u", { projectId: null }, count), null);
  assert.equal(called, 0);

  process.env.JUNO_APP_URL = "https://juno.example";
  try {
    const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    assert.equal(await fetchVoiceMemory("u", { projectId: null }, failing), null);
    const empty = (async () => new Response(JSON.stringify({ instructions: null }), { status: 200 })) as typeof fetch;
    assert.equal(await fetchVoiceMemory("u", { projectId: null }, empty), null);
    const throwing = (async () => {
      throw new Error("network");
    }) as typeof fetch;
    assert.equal(await fetchVoiceMemory("u", { projectId: null }, throwing), null);
  } finally {
    delete process.env.JUNO_APP_URL;
  }
});
