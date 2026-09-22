import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { GptLiveSession } from "../src/providers/gpt-live.js";
import { OpenAiVoiceSession } from "../src/providers/openai-voice.js";
import type { RealtimeDialect } from "../src/providers/openai-realtime.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";

/**
 * GPT-Live-1 is a different protocol from the Realtime dialect: `/v1/live/
 * sessions`, a `session.start` handshake, and a session config that rejects
 * unknown fields. These cover the parts a wrong guess would break silently —
 * what goes out on the wire, and what the thinking switch actually changes.
 */

const seed: VoiceSessionSeed = { instructions: "be brief", transcript: [] };

interface Recorded {
  audio: { pcm: Buffer; rate: number }[];
  transcripts: { role: string; text: string; final: boolean }[];
  turns: string[];
  errors: string[];
}

function recorder(): { events: ProviderEvents; recorded: Recorded } {
  const recorded: Recorded = { audio: [], transcripts: [], turns: [], errors: [] };
  return {
    recorded,
    events: {
      onAudio: (pcm, rate) => recorded.audio.push({ pcm, rate }),
      onTranscript: (t) => recorded.transcripts.push({ role: t.role, text: t.text, final: t.final }),
      onTurn: (phase) => recorded.turns.push(phase),
      onUserSpeechStart: () => recorded.turns.push("user-start"),
      onInterrupted: () => recorded.turns.push("interrupted"),
      onUsage: () => {},
      onError: (m) => recorded.errors.push(m),
      onClosed: () => {},
    },
  };
}

/** A stand-in Live endpoint that records what the relay sent it. */
async function withFakeLive(
  run: (ctx: { sent: Record<string, unknown>[]; socket: () => WsSocket }) => Promise<void>,
  options: { onStart?: "started" | "close" | "mute" | "destroy" } = {}
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const sent: Record<string, unknown>[] = [];
  let live: WsSocket | null = null;
  server.on("connection", (socket) => {
    live = socket;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(msg);
      if (msg.type !== "session.start") return;
      const mode = options.onStart ?? "started";
      if (mode === "started") socket.send(JSON.stringify({ type: "session.started" }));
      else if (mode === "close") socket.close(1007, "Unknown parameter: session.delegation.responses.reasoning");
      // No close frame at all — the shape an account without GPT-Live sees.
      else if (mode === "destroy") socket.terminate();
    });
  });

  const previous = {
    url: process.env.RELAY_OPENAI_LIVE_URL,
    key: process.env.OPENAI_API_KEY,
    model: process.env.RELAY_OPENAI_MODEL,
    backend: process.env.RELAY_OPENAI_BACKEND_MODEL,
  };
  process.env.RELAY_OPENAI_LIVE_URL = `ws://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.RELAY_OPENAI_MODEL;
  delete process.env.RELAY_OPENAI_BACKEND_MODEL;
  try {
    await run({ sent, socket: () => live as WsSocket });
  } finally {
    for (const [name, value] of [
      ["RELAY_OPENAI_LIVE_URL", previous.url],
      ["OPENAI_API_KEY", previous.key],
      ["RELAY_OPENAI_MODEL", previous.model],
      ["RELAY_OPENAI_BACKEND_MODEL", previous.backend],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the handshake is session.start on gpt-live-1, with reasoning off by default", async () => {
  await withFakeLive(async ({ sent }) => {
    const session = new GptLiveSession();
    await session.connect(seed, recorder().events);

    const start = sent.find((m) => m.type === "session.start");
    assert.ok(start, "must open with session.start, not session.update");
    const config = start.session as Record<string, unknown>;
    assert.equal(config.model, "gpt-live-1");
    assert.deepEqual(config.audio, {
      format: { type: "audio/pcm", rate: 24000 },
      output: { voice: "marin" },
    });
    const delegation = config.delegation as { type: string; responses: Record<string, unknown> };
    assert.equal(delegation.type, "responses");
    assert.equal(delegation.responses.model, "gpt-5.6-luna");
    // GPT-5.6 reasons at medium when the field is absent, so "off" has to be
    // said explicitly or the switch does nothing on exactly these models.
    assert.deepEqual(delegation.responses.reasoning, { effort: "none" });
    await session.close();
  });
});

test("thinking on asks the backend model to reason", async () => {
  await withFakeLive(async ({ sent }) => {
    const session = new GptLiveSession({ thinking: true });
    await session.connect(seed, recorder().events);

    const start = sent.find((m) => m.type === "session.start") as { session: Record<string, unknown> };
    const delegation = start.session.delegation as { responses: Record<string, unknown> };
    assert.deepEqual(delegation.responses.reasoning, { effort: "medium" });
    await session.close();
  });
});

test("mic audio goes out as session.input_audio.append, resampled to 24 kHz", async () => {
  await withFakeLive(async ({ sent }) => {
    const session = new GptLiveSession();
    await session.connect(seed, recorder().events);

    // 160 samples of 16 kHz -> 240 samples at 24 kHz.
    session.sendAudio(Buffer.alloc(320));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const append = sent.find((m) => m.type === "session.input_audio.append") as { audio: string };
    assert.ok(append, "audio must use the GPT-Live event name, not input_audio_buffer.append");
    assert.equal(Buffer.from(append.audio, "base64").length, 480);
    await session.close();
  });
});

test("an image goes out as a Responses input_image item", async () => {
  await withFakeLive(async ({ sent }) => {
    const session = new GptLiveSession();
    await session.connect(seed, recorder().events);

    session.sendVideoFrame(Buffer.from([0xff, 0xd8, 0xff]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const item = sent.find((m) => m.type === "response.item.create") as {
      item: { type: string; role: string; content: { type: string; image_url: string }[] };
    };
    assert.ok(item, "frames ride on response.item.create");
    assert.equal(item.item.role, "user");
    assert.equal(item.item.content[0].type, "input_image");
    assert.match(item.item.content[0].image_url, /^data:image\/jpeg;base64,/);
    await session.close();
  });
});

test("output audio opens a turn and a pause in it closes one", async () => {
  await withFakeLive(async ({ socket }) => {
    const session = new GptLiveSession();
    const { events, recorded } = recorder();
    await session.connect(seed, events);

    socket().send(
      JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.alloc(480).toString("base64") })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(recorded.turns, ["start"], "first delta opens the turn");
    assert.equal(recorded.audio[0]?.rate, 24000);

    // GPT-Live sends no end-of-response event; the gap is the boundary.
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(recorded.turns, ["start", "end"]);
    await session.close();
  });
});

test("a refused session reports the server's reason, not a timeout", async () => {
  await withFakeLive(
    async ({ sent }) => {
      const session = new GptLiveSession();
      const started = Date.now();
      const err = await session.connect(seed, recorder().events).then(
        () => null,
        (reason: unknown) => reason as Error
      );
      assert.ok(err, "a closed handshake must reject");
      assert.match(err.message, /gpt-live-1/);
      assert.match(err.message, /1007|refused/);
      assert.doesNotMatch(err.message, /timed out/);
      assert.ok(Date.now() - started < 5_000);
      assert.ok(sent.some((m) => m.type === "session.start"));
      await session.close();
    },
    { onStart: "close" }
  );
});

test("barge-in drops the rest of the interrupted answer, then listens again", async () => {
  await withFakeLive(async ({ socket }) => {
    const session = new GptLiveSession();
    const { events, recorded } = recorder();
    await session.connect(seed, events);
    const delta = () =>
      socket().send(
        JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.alloc(480).toString("base64") })
      );

    delta();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recorded.audio.length, 1);

    // The caller talks over it. GPT-Live has no cancel to send and keeps
    // streaming the tail for a moment; none of it may reach the ear.
    session.interrupt();
    delta();
    delta();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recorded.audio.length, 1, "audio after a barge-in must be discarded");
    assert.ok(recorded.turns.includes("end"), "the interrupted turn still ends");

    // Once the tail stops, the next answer has to be audible again — the bug
    // this guards is suppression that never lifts.
    await new Promise((resolve) => setTimeout(resolve, 900));
    delta();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recorded.audio.length, 2, "the next answer must be heard");
    await session.close();
  });
});

/**
 * An account without GPT-Live does not get a refusal: the upgrade is accepted
 * and the socket is then dropped with no close frame. That is close 1006, and
 * it is what the fallback exists for.
 */
test("an abrupt drop after session.start is reported as a drop, not as a bad model id", async () => {
  await withFakeLive(
    async () => {
      const session = new GptLiveSession();
      const err = await session.connect(seed, recorder().events).then(
        () => null,
        (reason: unknown) => reason as Error
      );
      assert.ok(err);
      assert.match(err.message, /no close frame/);
      assert.match(err.message, /GPT-Live enabled/);
      // The server said nothing, so nothing may be claimed on its behalf.
      assert.doesNotMatch(err.message, /refused the session/);
      await session.close();
    },
    { onStart: "destroy" }
  );
});

test("OpenAI voice falls back to Realtime, and says so instead of claiming thinking", async () => {
  // A second endpoint for the fallback leg, so the fallback actually succeeds
  // and what it REPORTS can be asserted — which is the whole point of it.
  const realtime = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => realtime.once("listening", resolve));
  const realtimePort = (realtime.address() as { port: number }).port;
  let realtimeConnections = 0;
  realtime.on("connection", () => {
    realtimeConnections += 1;
  });
  const fakeDialect: RealtimeDialect = {
    provider: "openai",
    url: () => `ws://127.0.0.1:${realtimePort}`,
    headers: () => ({}),
    inputRate: 24000,
    assistantHistoryContentType: "output_text",
    supportsVideo: true,
    sessionUpdate: () => ({}),
  };

  try {
    await withFakeLive(
      async () => {
        const session = new OpenAiVoiceSession(fakeDialect, { thinking: true });
        await session.connect(seed, recorder().events);
        assert.equal(realtimeConnections, 1, "a GPT-Live failure must fall back to Realtime");

        const established = session.established();
        // Asking for thinking and landing on a protocol that has none must
        // report what is actually running, or the menu shows a mode nothing
        // serves and the caller believes the model is reasoning.
        assert.equal(established.thinking, false);
        assert.match(established.notice ?? "", /not available on this account/);
        assert.match(established.notice ?? "", /no thinking mode/);
        await session.close();
      },
      { onStart: "destroy" }
    );
  } finally {
    await new Promise<void>((resolve) => realtime.close(() => resolve()));
  }
});

test("a GPT-Live session that comes up needs no notice and keeps the thinking it was given", async () => {
  const unusedDialect: RealtimeDialect = {
    provider: "openai",
    url: () => {
      throw new Error("the fallback must not be reached when GPT-Live answers");
    },
    headers: () => ({}),
    inputRate: 24000,
    assistantHistoryContentType: "output_text",
    supportsVideo: true,
    sessionUpdate: () => ({}),
  };

  await withFakeLive(async () => {
    const session = new OpenAiVoiceSession(unusedDialect, { thinking: true });
    await session.connect(seed, recorder().events);
    const established = session.established();
    assert.equal(established.thinking, true);
    assert.equal(established.notice, undefined, "a working session must not be annotated");
    await session.close();
  });
});
