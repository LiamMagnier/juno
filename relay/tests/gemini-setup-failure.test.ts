import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { GeminiLiveSession, redactKey } from "../src/providers/gemini-live.js";
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
/** Filled with the upgrade requests the relay made, for auth assertions. */
const seen: { url: string; headers: Record<string, string | string[] | undefined> }[][] = [];

async function withFakeLive(
  onSetup: (socket: WsSocket) => void,
  run: () => Promise<void>,
  /** Receives each frame the relay sent, for assertions on the setup itself. */
  onFrame?: (frame: Record<string, unknown>) => void
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const upgrades: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  server.on("connection", (socket, request) => {
    upgrades.push({ url: request.url ?? "", headers: request.headers });
    socket.once("message", (raw: Buffer) => {
      if (onFrame) onFrame(JSON.parse(raw.toString()) as Record<string, unknown>);
      onSetup(socket);
    });
  });
  seen.length = 0;
  seen.push(upgrades);

  const previousUrl = process.env.RELAY_GEMINI_LIVE_URL;
  const previousKey = process.env.GEMINI_LIVE_API_KEY;
  const previousModel = process.env.RELAY_GEMINI_MODEL;
  const previousRest = process.env.RELAY_GEMINI_REST_URL;
  process.env.RELAY_GEMINI_LIVE_URL = `ws://127.0.0.1:${port}`;
  process.env.GEMINI_LIVE_API_KEY = "AIzaTestKey";
  process.env.RELAY_GEMINI_MODEL = "gemini-test-live";
  // An auth rejection now reaches for the token service. Point it at a closed
  // port: no test may go to Google to find out what these messages say.
  process.env.RELAY_GEMINI_REST_URL = "http://127.0.0.1:1";
  try {
    await run();
  } finally {
    if (previousUrl === undefined) delete process.env.RELAY_GEMINI_LIVE_URL;
    else process.env.RELAY_GEMINI_LIVE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.GEMINI_LIVE_API_KEY;
    else process.env.GEMINI_LIVE_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.RELAY_GEMINI_MODEL;
    else process.env.RELAY_GEMINI_MODEL = previousModel;
    if (previousRest === undefined) delete process.env.RELAY_GEMINI_REST_URL;
    else process.env.RELAY_GEMINI_REST_URL = previousRest;
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

test("the API key travels in the query string, which is what the Live socket reads", async () => {
  await withFakeLive(
    (socket) => socket.send(JSON.stringify({ setupComplete: {} })),
    async () => {
      const session = new GeminiLiveSession();
      await session.connect(seed, silentEvents());

      const upgrade = seen[0][0];
      assert.ok(upgrade, "the relay must have opened a socket");
      // x-goog-api-key is the REST surface's mechanism and is not read on the
      // WebSocket upgrade: header-only auth is answered with "Expected OAuth 2
      // access token", which looks like a bad key and is a missing one.
      const query = new URLSearchParams(upgrade.url.slice(upgrade.url.indexOf("?") + 1));
      assert.equal(query.get("key"), "AIzaTestKey");
      // Sent as well, because ephemeral tokens do travel as a header.
      assert.equal(upgrade.headers["x-goog-api-key"], "AIzaTestKey");
      await session.close();
    }
  );
});

test("a socket error never quotes the key back into a log or the caller's screen", () => {
  assert.equal(
    redactKey("connect ECONNREFUSED wss://host/ws?key=AIzaSecretValue&alt=sse"),
    "connect ECONNREFUSED wss://host/ws?key=***&alt=sse"
  );
  assert.equal(redactKey('failed: "?key=AIzaSecretValue"'), 'failed: "?key=***"');
  // The short-lived token is a credential too, and it rides in the query.
  assert.equal(redactKey("ws?access_token=tok_secret&x=1"), "ws?access_token=***&x=1");
  assert.equal(redactKey("nothing sensitive here"), "nothing sensitive here");
});

test("an auth rejection names the key's kind and clears the model of blame", async () => {
  // Google's own words, from the failure this diagnosis exists for.
  const googleSaid = "Request had invalid authentication credentials. Expected OAuth 2 access token";
  await withFakeLive(
    (socket) => socket.close(1008, googleSaid),
    async () => {
      const session = new GeminiLiveSession();
      const err = await session.connect(seed, silentEvents()).then(
        () => null,
        (reason: unknown) => reason as Error
      );
      assert.ok(err);
      assert.match(err.message, /rejected the credential/);
      // The fixture key is a classic AIza one, so the shape is not the fault.
      assert.match(err.message, /holds a classic "AIza" key/);
      // Google checks the credential first, so blaming the model id sends the
      // reader to change the one thing that provably was not consulted.
      assert.match(err.message, /never reached/);
      assert.doesNotMatch(err.message, /refused the session setup/);
      await session.close();
    }
  );
});

test("an AQ-format key is named as the wrong kind of key, and never printed", async () => {
  await withFakeLive(
    (socket) => socket.close(1008, "Request had invalid authentication credentials."),
    async () => {
      // Set inside the callback: withFakeLive installs its own fixture key
      // just before calling this, so an outer assignment would be overwritten.
      process.env.GEMINI_LIVE_API_KEY = "AQ.SecretValue123";
      {
        const session = new GeminiLiveSession();
        const err = await session.connect(seed, silentEvents()).then(
          () => null,
          (reason: unknown) => reason as Error
        );
        assert.ok(err);
        assert.match(err.message, /new "AQ\." key, which this socket does not take as a query key/);
        // ...and having said so, it must have actually tried the exchange.
        assert.match(err.message, /Exchanging it for a short-lived token failed too/);
        assert.match(err.message, /GEMINI_LIVE_API_KEY/);
        assert.doesNotMatch(err.message, /SecretValue123/);
        await session.close();
      }
    }
  );
});

test("an auth-rejected key is exchanged for a short-lived token and retried", async () => {
  // A tiny stand-in for the token service, so the exchange is exercised rather
  // than described. Google is retiring "AIza" keys, and the "AQ." ones that
  // replace them are not accepted as `?key=` on this socket — this path is
  // what makes voice work for a key that cannot be minted in the old format.
  const rest = createServer((req, res) => {
    restCalls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "auth_tokens/ephemeral-123" }));
  });
  const restCalls: string[] = [];
  await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
  const restPort = (rest.address() as { port: number }).port;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const wsPort = (server.address() as { port: number }).port;
  const upgradeUrls: string[] = [];
  server.on("connection", (socket, request) => {
    upgradeUrls.push(request.url ?? "");
    socket.once("message", () => {
      // Refuse the key exactly as Google does; accept the token.
      if ((request.url ?? "").includes("access_token=")) {
        socket.send(JSON.stringify({ setupComplete: {} }));
      } else {
        socket.close(1008, "Request had invalid authentication credentials.");
      }
    });
  });

  const previous = {
    url: process.env.RELAY_GEMINI_LIVE_URL,
    rest: process.env.RELAY_GEMINI_REST_URL,
    key: process.env.GEMINI_LIVE_API_KEY,
  };
  process.env.RELAY_GEMINI_LIVE_URL = `ws://127.0.0.1:${wsPort}/ws/BidiGenerateContent`;
  process.env.RELAY_GEMINI_REST_URL = `http://127.0.0.1:${restPort}`;
  process.env.GEMINI_LIVE_API_KEY = "AQ.SomeNewFormatKey";
  try {
    const session = new GeminiLiveSession();
    await session.connect(seed, silentEvents());

    assert.deepEqual(restCalls, ["POST /v1beta/auth_tokens"], "the key must be exchanged once");
    assert.equal(upgradeUrls.length, 2, "one refused attempt, then one with the token");
    assert.match(upgradeUrls[0], /[?&]key=/);
    // The token is accepted on the Constrained variant, and as access_token.
    assert.match(upgradeUrls[1], /BidiGenerateContentConstrained/);
    assert.match(upgradeUrls[1], /[?&]access_token=auth_tokens%2Fephemeral-123/);
    await session.close();
  } finally {
    for (const [name, value] of [
      ["RELAY_GEMINI_LIVE_URL", previous.url],
      ["RELAY_GEMINI_REST_URL", previous.rest],
      ["GEMINI_LIVE_API_KEY", previous.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  }
});

test("the thinking level goes only to the model that requires one", async () => {
  // Extended Thinking fails setup without `thinkingLevel`; plain 3.8 Live
  // fails setup WITH it. One constant cannot serve both.
  const setups: Record<string, unknown>[] = [];
  const capture = async (thinking: boolean) => {
    await withFakeLive(
      (socket) => socket.send(JSON.stringify({ setupComplete: {} })),
      async () => {
        const session = new GeminiLiveSession({ thinking });
        await session.connect(seed, silentEvents());
        await session.close();
      },
      (frame) => setups.push(frame)
    );
  };

  await capture(false);
  await capture(true);

  const plain = (setups[0].setup as { generationConfig: Record<string, unknown> }).generationConfig;
  const extended = (setups[1].setup as { generationConfig: Record<string, unknown> }).generationConfig;
  assert.equal(plain.thinkingConfig, undefined, "the plain model must be sent no level at all");
  assert.deepEqual(extended.thinkingConfig, { thinkingLevel: "low" });
});
