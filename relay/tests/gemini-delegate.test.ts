import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { GeminiLiveSession } from "../src/providers/gemini-live.js";
import {
  geminiDelegateConfig,
  geminiDelegateRequest,
  geminiVoicePlan,
  GEMINI_DELEGATE_DECLARATION,
  GEMINI_DELEGATE_FUNCTION,
} from "../src/providers/gemini-delegate.js";
import type { ProviderEvents, VoiceSessionSeed } from "../src/providers/types.js";

/**
 * Gemini Live delegates to Gemini 3.8 Flash through function calling: 3.8 Live
 * at thinkingLevel low, 3.8 Live Extended Thinking at high, with Google Search
 * grounding on the delegate.
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

test("Gemini 3.8 Live delegates to Gemini 3.8 Flash at low; Extended Thinking at high", () => {
  const previous = process.env.RELAY_GEMINI_DELEGATE_MODEL;
  delete process.env.RELAY_GEMINI_DELEGATE_MODEL;
  try {
    assert.deepEqual(geminiDelegateConfig(false), { model: "gemini-3.8-flash", effort: "low", webSearch: true });
    assert.deepEqual(geminiDelegateConfig(true), { model: "gemini-3.8-flash", effort: "high", webSearch: true });
    assert.deepEqual(new GeminiLiveSession().established().delegate, geminiDelegateConfig(false));
    // The old on/off `thinking: true` lands on Medium, which hands Flash medium.
    assert.deepEqual(new GeminiLiveSession({ thinking: true }).established().delegate, { ...geminiDelegateConfig(true), effort: "medium" });
  } finally {
    if (previous !== undefined) process.env.RELAY_GEMINI_DELEGATE_MODEL = previous;
  }
});

test("one dial picks the Live model, its own level, and Flash's", () => {
  assert.deepEqual(geminiVoicePlan("low"), { thinking: false, delegate: geminiDelegateConfig(false) });
  assert.deepEqual(geminiVoicePlan("medium"), { thinking: true, liveThinkingLevel: "low", delegate: { ...geminiDelegateConfig(true), effort: "medium" } });
  assert.deepEqual(geminiVoicePlan("high"), { thinking: true, liveThinkingLevel: "high", delegate: geminiDelegateConfig(true) });
  const low = new GeminiLiveSession({ effort: "low" }).established();
  assert.equal(low.model, process.env.RELAY_GEMINI_MODEL || "gemini-3.8-live");
  assert.equal(low.effort, "low");
  const high = new GeminiLiveSession({ effort: "high" }).established();
  assert.equal(high.thinking, true);
  assert.equal(high.delegate?.effort, "high");
  // The older on/off request lands on Medium.
  assert.equal(new GeminiLiveSession({ thinking: true }).established().effort, "medium");
});

test("the delegate request carries the thinking level and Google Search", () => {
  const body = geminiDelegateRequest(
    { model: "gemini-3.8-flash", effort: "high", webSearch: true },
    { question: "Who won last night?", context: "We were talking about football." }
  ) as { generationConfig: unknown; tools?: unknown; contents: Array<{ parts: Array<{ text: string }> }> };
  assert.deepEqual(body.generationConfig, { thinkingConfig: { thinkingLevel: "high" } });
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.match(body.contents[0].parts[0].text, /Who won last night\?/);
  assert.match(body.contents[0].parts[0].text, /football/);

  const quiet = geminiDelegateRequest({ model: "gemini-3.8-flash", effort: "low", webSearch: false }, { question: "2+2" });
  assert.equal("tools" in quiet, false);
});

test("a Live tool call is answered from Gemini 3.8 Flash with a toolResponse", async () => {
  // The REST side: one generateContent, recorded.
  const restCalls: { url: string; body: Record<string, unknown> }[] = [];
  const rest = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      restCalls.push({ url: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Four." }] } }] }));
    });
  });
  await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
  const restPort = (rest.address() as { port: number }).port;

  // The Live side: setupComplete, then one function call.
  const live = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => live.once("listening", resolve));
  const livePort = (live.address() as { port: number }).port;
  const frames: Record<string, unknown>[] = [];
  let toolResponse: ((frame: Record<string, unknown>) => void) | null = null;
  const answered = new Promise<Record<string, unknown>>((resolve) => (toolResponse = resolve));
  live.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if ("setup" in frame) {
        socket.send(JSON.stringify({ setupComplete: {} }));
        socket.send(
          JSON.stringify({
            toolCall: { functionCalls: [{ id: "call-1", name: GEMINI_DELEGATE_FUNCTION, args: { question: "2+2?" } }] },
          })
        );
      }
      if ("toolResponse" in frame) toolResponse?.(frame);
    });
  });

  const env = {
    RELAY_GEMINI_LIVE_URL: `ws://127.0.0.1:${livePort}`,
    RELAY_GEMINI_REST_URL: `http://127.0.0.1:${restPort}`,
    GEMINI_LIVE_API_KEY: "AIzaTestKey",
    RELAY_GEMINI_MODEL: undefined,
    RELAY_GEMINI_DELEGATE_MODEL: undefined,
    RELAY_GEMINI_DELEGATE_WEB_SEARCH: undefined,
  } as const;
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const session = new GeminiLiveSession({ effort: "high" });
    await session.connect(seed, silentEvents());

    const setup = (frames.find((f) => "setup" in f) as { setup: Record<string, unknown> }).setup;
    assert.deepEqual(setup.tools, [{ functionDeclarations: [JSON.parse(JSON.stringify(GEMINI_DELEGATE_DECLARATION))] }]);
    // High: Extended Thinking at its own deepest level.
    assert.equal(setup.model, "models/gemini-3.8-live-extended-thinking");
    assert.deepEqual((setup.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingLevel: "high" });
    const instructions = (setup.systemInstruction as { parts: { text: string }[] }).parts[0].text;
    assert.match(instructions, /can search the web/);

    const frame = (await answered) as {
      toolResponse: { functionResponses: Array<{ id: string; name: string; response: unknown }> };
    };
    assert.deepEqual(frame.toolResponse.functionResponses, [
      { id: "call-1", name: GEMINI_DELEGATE_FUNCTION, response: { answer: "Four." } },
    ]);
    assert.equal(restCalls.length, 1);
    assert.match(restCalls[0].url, /\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
    assert.deepEqual(restCalls[0].body.generationConfig, { thinkingConfig: { thinkingLevel: "high" } });
    assert.deepEqual(restCalls[0].body.tools, [{ google_search: {} }]);
    await session.close();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((resolve) => live.close(() => resolve()));
    await new Promise<void>((resolve) => rest.close(() => resolve()));
  }
});
