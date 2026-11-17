import assert from "node:assert/strict";
import test from "node:test";
import { MockVoiceSession } from "../src/providers/mock.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import { RelaySession } from "../src/session.js";

/*
 * What the relay tells a client when something goes wrong.
 *
 * Every `error` used to be terminal on the client, so a provider's passing
 * complaint (a cancel with nothing to cancel) read "Call stopped" over a call
 * that went on talking, and a client could only tell failures apart by
 * parsing provider text. Errors now carry a `code` and say whether they are
 * `fatal`. The budget cut used to leave the socket open with nobody behind
 * it; it now says why it closed, and closes.
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  closedWith: [number | undefined, string | undefined] | null = null;
  readonly frames: Record<string, unknown>[] = [];
  send(data: unknown): void {
    if (typeof data === "string") this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
    this.readyState = 3;
  }
}

test("a provider the relay does not know is a fatal error with a code", async () => {
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "nope" }));
    const error = ws.frames.find((frame) => frame.type === "error");
    assert.ok(error, "an error is sent");
    assert.equal(error.code, "provider_unknown");
    assert.equal(error.fatal, true);
  } finally {
    await session.destroy();
  }
});

test("a provider's own error is not fatal: a provider that really fails also closes", async () => {
  let events: ProviderEvents | null = null;
  const originalConnect = MockVoiceSession.prototype.connect;
  MockVoiceSession.prototype.connect = async function (seed: VoiceSessionSeed, ev: ProviderEvents) {
    events = ev;
    return originalConnect.call(this, seed, ev);
  };
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    assert.ok(events, "the mock connected");
    (events as ProviderEvents).onError("mock: response_cancel_not_active");
    const error = ws.frames.find((frame) => frame.type === "error");
    assert.deepEqual(
      { code: error?.code, fatal: error?.fatal },
      { code: "provider_error", fatal: false },
      "the call outlives it"
    );
    // The dying path closes, and the close is what ends the call.
    (events as ProviderEvents).onClosed("provider");
    assert.ok(ws.frames.some((frame) => frame.type === "session.closed" && frame.reason === "provider"));
  } finally {
    MockVoiceSession.prototype.connect = originalConnect;
    await session.destroy();
  }
});

test("a spent budget closes the call: the reason, the error older clients read, then the socket", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.JUNO_APP_URL;
  process.env.JUNO_APP_URL = "https://juno.test";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ allowed: false }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const ws = new FakeSocket();
  const session = new RelaySession(ws as never, "user-1", {});
  try {
    await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
    // Enough spend to be worth reporting, then the tick that reports it.
    const internals = session as unknown as {
      usage: { costInUsd: number; costInMeasured: boolean };
      providerId: string | null;
      reportSpend(final: boolean): Promise<void>;
    };
    internals.usage.costInUsd = 0.05;
    internals.usage.costInMeasured = true;
    await internals.reportSpend(false);

    const types = ws.frames.map((frame) => frame.type);
    const closedAt = types.indexOf("session.closed");
    const errorAt = types.lastIndexOf("error");
    assert.ok(closedAt >= 0 && ws.frames[closedAt].reason === "budget", "the close says why");
    assert.ok(errorAt > closedAt, "the error older clients understand follows it");
    assert.equal(ws.frames[errorAt].code, "budget");
    assert.equal(ws.frames[errorAt].fatal, true);
    assert.deepEqual(ws.closedWith, [1000, "budget"], "and the socket is closed, not left open with nobody behind it");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.JUNO_APP_URL;
    else process.env.JUNO_APP_URL = originalUrl;
    await session.destroy();
  }
});
