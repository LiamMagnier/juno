import assert from "node:assert/strict";
import test from "node:test";
import { MockVoiceSession } from "../src/providers/mock.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import { RelaySession } from "../src/session.js";

/*
 * A caller who hangs up while the provider is still connecting.
 *
 * destroy() closes `this.provider`, which is still null while startProvider
 * awaits connect. When connect then resolves, the session was adopted and a
 * fresh session timer armed — whose handler returns early because the relay
 * is closed — so nothing ever closed the provider. On a provider billed per
 * connected second (GPT-Live, xAI) that is up to an hour of unmetered spend
 * nobody hears (docs/handoff/2026-10-31/cost/voice-realtime-findings.md, V1).
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Record<string, unknown>[] = [];
  send(data: unknown): void {
    if (typeof data === "string") this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test("a provider that finishes connecting after the caller hung up is closed, never adopted", async () => {
  let releaseConnect!: () => void;
  const connecting = new Promise<void>((resolve) => (releaseConnect = resolve));
  let closes = 0;
  const originalConnect = MockVoiceSession.prototype.connect;
  const originalClose = MockVoiceSession.prototype.close;
  MockVoiceSession.prototype.connect = async function (seed: VoiceSessionSeed, events: ProviderEvents) {
    await connecting;
    return originalConnect.call(this, seed, events);
  };
  MockVoiceSession.prototype.close = async function () {
    closes++;
    return originalClose.call(this);
  };
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    const starting = session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    // The caller hangs up mid-connect.
    await new Promise((resolve) => setImmediate(resolve));
    await session.destroy();
    releaseConnect();
    await starting;

    assert.equal(closes, 1, "the late session is closed exactly once");
    assert.equal(ws.frames.filter((frame) => frame.type === "session.ready").length, 0, "no ready frame after hang-up");
  } finally {
    MockVoiceSession.prototype.connect = originalConnect;
    MockVoiceSession.prototype.close = originalClose;
    await session.destroy();
  }
});

/*
 * The same hang-up during a provider switch: the old session is closed first,
 * then the new one dialled, and the caller can leave at either await.
 */
function trackMockSessions() {
  const connected: MockVoiceSession[] = [];
  const closed: MockVoiceSession[] = [];
  const originalConnect = MockVoiceSession.prototype.connect;
  const originalClose = MockVoiceSession.prototype.close;
  const gates = { connect: null as Promise<void> | null, close: null as Promise<void> | null };
  MockVoiceSession.prototype.connect = async function (seed: VoiceSessionSeed, events: ProviderEvents) {
    connected.push(this);
    // Only the switch's session stalls; the first connects at once.
    if (connected.length > 1 && gates.connect) await gates.connect;
    return originalConnect.call(this, seed, events);
  };
  MockVoiceSession.prototype.close = async function () {
    closed.push(this);
    if (gates.close) await gates.close;
    return originalClose.call(this);
  };
  const restore = () => {
    MockVoiceSession.prototype.connect = originalConnect;
    MockVoiceSession.prototype.close = originalClose;
  };
  return { connected, closed, gates, restore };
}

test("a hang-up while a switch is connecting closes the session it switched to", async () => {
  const mocks = trackMockSessions();
  let releaseConnect!: () => void;
  mocks.gates.connect = new Promise<void>((resolve) => (releaseConnect = resolve));
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    const switching = session.handleText(JSON.stringify({ type: "session.switch", provider: "mock" }));
    await new Promise((resolve) => setImmediate(resolve));
    await session.destroy();
    releaseConnect();
    await switching;

    assert.equal(mocks.connected.length, 2);
    assert.deepEqual(mocks.closed, mocks.connected, "the old session by the switch, the new one once it connected");
    assert.equal(ws.frames.filter((frame) => frame.type === "session.ready").length, 1, "only the first session was ready");
  } finally {
    mocks.restore();
    await session.destroy();
  }
});

test("a hang-up while a switch closes the old session dials nothing new", async () => {
  const mocks = trackMockSessions();
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    let releaseClose!: () => void;
    mocks.gates.close = new Promise<void>((resolve) => (releaseClose = resolve));
    const switching = session.handleText(JSON.stringify({ type: "session.switch", provider: "mock" }));
    const ending = session.destroy();
    // destroy() has latched closed and waits on the same stalled close.
    await new Promise((resolve) => setImmediate(resolve));
    releaseClose();
    await Promise.all([switching, ending]);

    assert.equal(mocks.connected.length, 1, "no replacement was dialled for a caller who left");
    assert.equal(ws.frames.filter((frame) => frame.type === "session.ready").length, 1);
  } finally {
    mocks.restore();
    await session.destroy();
  }
});
