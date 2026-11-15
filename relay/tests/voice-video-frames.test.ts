import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MockVoiceSession } from "../src/providers/mock.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";
import { RelaySession } from "../src/session.js";

/*
 * Camera/screen frames reach the provider only when they show something new.
 *
 * Clients send one frame a second whether or not the picture changed, and the
 * relay forwarded each one: on Gemini every frame stays in the context and is
 * re-billed every turn, on OpenAI each is a permanent conversation item
 * (docs/handoff/2026-10-31/cost/voice-realtime-findings.md, V2).
 */

process.env.AUTH_SECRET = "relay-test-secret";
process.env.RELAY_ENABLE_MOCK = "1";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  send(): void {}
}

const frame = (label: string) => JSON.stringify({ type: "video.frame", jpegBase64: Buffer.from(label).toString("base64") });

/** A call on the mock provider whose forwarded frames and texts are logged in order. */
async function startCall(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const log: string[] = [];
  const sessions: MockVoiceSession[] = [];
  let events: ProviderEvents | null = null;
  const originalConnect = MockVoiceSession.prototype.connect;
  t.mock.method(MockVoiceSession.prototype, "connect", async function (this: MockVoiceSession, seed: VoiceSessionSeed, ev: ProviderEvents) {
    sessions.push(this);
    events = ev;
    return originalConnect.call(this, seed, ev);
  });
  t.mock.method(MockVoiceSession.prototype, "sendVideoFrame", function (this: MockVoiceSession, jpeg: Buffer) {
    log.push(`${sessions.indexOf(this)}:${jpeg.toString()}`);
  });
  // Logged, not answered: the mock's spoken reply is beside the point here.
  t.mock.method(MockVoiceSession.prototype, "sendText", function (this: MockVoiceSession, text: string) {
    log.push(`${sessions.indexOf(this)}:text ${text}`);
  });
  const session = new RelaySession(new FakeSocket() as never, "user-1", {});
  t.after(() => session.destroy());
  await session.handleText(JSON.stringify({ type: "session.start", provider: "mock" }));
  return { session, log, speak: () => events?.onUserSpeechStart() };
}

test("a frame identical to the last one forwarded is dropped", async (t) => {
  const { session, log } = await startCall(t);
  await session.handleText(frame("A"));
  t.mock.timers.tick(1_000);
  await session.handleText(frame("A"));
  t.mock.timers.tick(1_000);
  await session.handleText(frame("B"));
  t.mock.timers.tick(1_000);
  await session.handleText(frame("B"));
  assert.deepEqual(log, ["0:A", "0:B"]);
});

test("frames under 900 ms apart are held, and the newest goes when the caller starts speaking", async (t) => {
  const { session, log, speak } = await startCall(t);
  await session.handleText(frame("A"));
  t.mock.timers.tick(300);
  await session.handleText(frame("B"));
  t.mock.timers.tick(300);
  await session.handleText(frame("C"));
  assert.deepEqual(log, ["0:A"], "B and C came too soon");

  speak();
  assert.deepEqual(log, ["0:A", "0:C"], "the newest held frame, not every one");
  speak();
  assert.deepEqual(log, ["0:A", "0:C"], "nothing is held any more");

  t.mock.timers.tick(899);
  await session.handleText(frame("D"));
  assert.deepEqual(log, ["0:A", "0:C"], "the cap counts from the frame sent on speech");
  t.mock.timers.tick(1);
  await session.handleText(frame("E"));
  assert.deepEqual(log, ["0:A", "0:C", "0:E"]);
});

test("a typed turn sends the held frame before its words", async (t) => {
  const { session, log } = await startCall(t);
  await session.handleText(frame("A"));
  t.mock.timers.tick(200);
  await session.handleText(frame("B"));
  await session.handleText(JSON.stringify({ type: "input.text", text: "what is on my screen?" }));
  assert.deepEqual(log, ["0:A", "0:B", "0:text what is on my screen?"]);
});

test("a held frame is dropped once the picture is back to what the model has", async (t) => {
  const { session, log, speak } = await startCall(t);
  await session.handleText(frame("A"));
  t.mock.timers.tick(300);
  await session.handleText(frame("B"));
  t.mock.timers.tick(300);
  await session.handleText(frame("A"));
  speak();
  assert.deepEqual(log, ["0:A"]);
});

test("a provider switched to is sent the picture, unchanged or not", async (t) => {
  const { session, log } = await startCall(t);
  await session.handleText(frame("A"));
  await session.handleText(JSON.stringify({ type: "session.switch", provider: "mock" }));
  await session.handleText(frame("A"));
  assert.deepEqual(log, ["0:A", "1:A"]);
});
