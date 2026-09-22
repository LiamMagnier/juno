import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { GeminiLiveSession } from "../src/providers/gemini-live.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";

/**
 * Gemini rejects a bad setup frame by closing the socket, not by answering it.
 * The relay used to wait out its own 15-second timer and report "gemini setup
 * timed out" for every one of those — a retired model id and a key the Live
 * surface will not take produced the same uninformative sentence, while the
 * close frame that said which it was went only to the relay's log.
 */

const seed: VoiceSessionSeed = { instructions: "be brief", transcript: [] };

function silentEvents(): ProviderEvents {
  return {
    onAudio: () => {},
    onTranscript: () => {},
    onTurn: () => {},
    onUserSpeechStart: () => {},
    onInterrupted: () => {},
    onUsage: () => {},
    onError: () => {},
    onClosed: () => {},
  };
}

/** A stand-in Live endpoint. `onSetup` decides how it answers the setup frame. */
async function withFakeLive(
  onSetup: (socket: WsSocket) => void,
  run: () => Promise<void>
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  server.on("connection", (socket) => {
    socket.once("message", () => onSetup(socket));
  });

  const previousUrl = process.env.RELAY_GEMINI_LIVE_URL;
  const previousKey = process.env.GEMINI_LIVE_API_KEY;
  const previousModel = process.env.RELAY_GEMINI_MODEL;
  process.env.RELAY_GEMINI_LIVE_URL = `ws://127.0.0.1:${port}`;
  process.env.GEMINI_LIVE_API_KEY = "AIzaTestKey";
  process.env.RELAY_GEMINI_MODEL = "gemini-test-live";
  try {
    await run();
  } finally {
    if (previousUrl === undefined) delete process.env.RELAY_GEMINI_LIVE_URL;
    else process.env.RELAY_GEMINI_LIVE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.GEMINI_LIVE_API_KEY;
    else process.env.GEMINI_LIVE_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.RELAY_GEMINI_MODEL;
    else process.env.RELAY_GEMINI_MODEL = previousModel;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a setup the server closes on reports the server's reason, not a timeout", async () => {
  await withFakeLive(
    (socket) => socket.close(1007, "models/gemini-test-live is not found for API version v1beta"),
    async () => {
      const session = new GeminiLiveSession();
      const started = Date.now();
      const err = await session.connect(seed, silentEvents()).then(
        () => null,
        (reason: unknown) => reason as Error
      );

      assert.ok(err, "connect must reject when the Live API closes on the setup frame");
      // The three things a reader needs: which model, that the server refused
      // it, and what the server said.
      assert.match(err.message, /gemini-test-live/);
      assert.match(err.message, /1007/);
      assert.match(err.message, /is not found/);
      assert.doesNotMatch(err.message, /timed out/);
      // It must settle on the close, not sit out the 15s timer.
      assert.ok(Date.now() - started < 5_000, "must fail on the close, not on the timeout");
      await session.close();
    }
  );
});

test("a setup the server answers still connects", async () => {
  await withFakeLive(
    (socket) => socket.send(JSON.stringify({ setupComplete: {} })),
    async () => {
      const session = new GeminiLiveSession();
      await session.connect(seed, silentEvents());
      await session.close();
    }
  );
});

test("a mute server leaves the connect pending rather than resolving it", async () => {
  await withFakeLive(
    () => {
      /* deliberately mute — the genuine timeout path */
    },
    async () => {
      const session = new GeminiLiveSession();
      // The timeout itself is 15s, too long to hold the suite for. What this
      // guards is that settling on close did not accidentally settle a socket
      // that is merely slow.
      const err = await Promise.race([
        session.connect(seed, silentEvents()).then(
          () => null,
          (reason: unknown) => reason as Error
        ),
        new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 300)),
      ]);
      assert.equal(err, "still-waiting", "a mute server must not resolve the connect");
      await session.close();
    }
  );
});
