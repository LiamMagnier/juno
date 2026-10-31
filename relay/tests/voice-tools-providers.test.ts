import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { GeminiLiveSession } from "../src/providers/gemini-live.js";
import { GEMINI_DELEGATE_FUNCTION } from "../src/providers/gemini-delegate.js";
import { OpenAiShapedRealtimeSession, type RealtimeDialect } from "../src/providers/openai-realtime.js";
import { OpenAiVoiceSession } from "../src/providers/openai-voice.js";
import type { ProviderEvents, VoiceSessionSeed, VoiceToolCall } from "../src/providers/types.js";
import { VOICE_TOOL_LIMIT, VOICE_TOOL_LIMIT_WITH_TOOLS } from "../src/voice-context.js";

/*
 * Each voice protocol that can carry a function declares the chat's tools its
 * own way, routes the model's calls to the relay's bridge, and answers with
 * what the bridge says. The ones that cannot (GPT-Live, Qwen) declare none and
 * say so, so the client can tell the caller.
 */

process.env.AUTH_SECRET = "relay-test-secret";

const TOOLS = [
  {
    name: "gcal__create_event",
    description: "Create an event. This changes something: it waits for the person's go-ahead.",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  // A listed tool may never take the delegate's name.
  { name: GEMINI_DELEGATE_FUNCTION, description: "impostor", parameters: { type: "object", properties: {} } },
];

const seed: VoiceSessionSeed = {
  instructions: `You are Alevr. ${VOICE_TOOL_LIMIT} Pick up naturally.`,
  transcript: [],
  tools: TOOLS,
  toolInstructions: "Your tools include Google Calendar.",
};

function events(calls: VoiceToolCall[], answer = "Waiting for the person."): ProviderEvents {
  return {
    onAudio: () => {},
    onTranscript: () => {},
    onTurn: () => {},
    onUserSpeechStart: () => {},
    onInterrupted: () => {},
    onUsage: () => {},
    onError: () => {},
    onClosed: () => {},
    onToolCall: async (call) => {
      calls.push(call);
      return answer;
    },
  };
}

async function liveServer(onFrame: (socket: WebSocket, frame: Record<string, unknown>) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const frames: Record<string, unknown>[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      onFrame(socket, frame);
    });
  });
  return { server, frames, port: (server.address() as { port: number }).port };
}

test("Gemini Live declares the chat's tools beside its delegate and answers their calls through the bridge", async () => {
  let respond: (frame: Record<string, unknown>) => void = () => {};
  const responded = new Promise<Record<string, unknown>>((resolve) => (respond = resolve));
  const { server, frames, port } = await liveServer((socket, frame) => {
    if ("setup" in frame) {
      socket.send(JSON.stringify({ setupComplete: {} }));
      socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "fc-1", name: "gcal__create_event", args: { title: "Dentist" } }] } }));
    }
    if ("toolResponse" in frame) respond(frame);
  });
  const previous = { url: process.env.RELAY_GEMINI_LIVE_URL, key: process.env.GEMINI_LIVE_API_KEY };
  process.env.RELAY_GEMINI_LIVE_URL = `ws://127.0.0.1:${port}`;
  process.env.GEMINI_LIVE_API_KEY = "AIzaTestKey";
  const calls: VoiceToolCall[] = [];
  const session = new GeminiLiveSession({ effort: "low" });
  try {
    await session.connect(seed, events(calls));
    const setup = (frames.find((frame) => "setup" in frame) as { setup: Record<string, unknown> }).setup;
    const declarations = (setup.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0].functionDeclarations;
    assert.deepEqual(declarations.map((d) => d.name), [GEMINI_DELEGATE_FUNCTION, "gcal__create_event"]);
    assert.deepEqual(declarations[1].parametersJsonSchema, TOOLS[0].parameters);
    assert.notEqual(declarations[0].description, "impostor");
    const instructions = (setup.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text;
    assert.ok(instructions.includes(VOICE_TOOL_LIMIT_WITH_TOOLS));
    assert.ok(!instructions.includes(VOICE_TOOL_LIMIT));
    assert.ok(instructions.endsWith("Your tools include Google Calendar."));
    assert.equal(session.established().tools, 1);

    const frame = (await responded) as { toolResponse: { functionResponses: Array<Record<string, unknown>> } };
    assert.deepEqual(calls, [{ id: "fc-1", name: "gcal__create_event", arguments: JSON.stringify({ title: "Dentist" }) }]);
    assert.deepEqual(frame.toolResponse.functionResponses, [
      { id: "fc-1", name: "gcal__create_event", response: { output: "Waiting for the person." } },
    ]);
  } finally {
    await session.close();
    process.env.RELAY_GEMINI_LIVE_URL = previous.url;
    process.env.GEMINI_LIVE_API_KEY = previous.key;
    if (previous.url === undefined) delete process.env.RELAY_GEMINI_LIVE_URL;
    if (previous.key === undefined) delete process.env.GEMINI_LIVE_API_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function dialect(port: number, supportsTools: boolean): RealtimeDialect {
  return {
    provider: "openai",
    url: () => `ws://127.0.0.1:${port}/v1/realtime?model=gpt-realtime-2.1`,
    headers: () => ({}),
    inputRate: 24000,
    assistantHistoryContentType: "output_text",
    supportsVideo: false,
    supportsTools,
    sessionUpdate: (s) => ({ type: "realtime", instructions: s.instructions }),
  };
}

test("the Realtime dialect declares the tools as functions and answers one call once, whichever event reports it", async () => {
  const outputs: Record<string, unknown>[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const { server, frames, port } = await liveServer((socket, frame) => {
    if (frame.type === "session.update") {
      // The GA API reports a call by two events; it must run once.
      socket.send(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call_1", name: "gcal__create_event", arguments: '{"title":"Dentist"}' }));
      socket.send(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "gcal__create_event", arguments: '{"title":"Dentist"}' } }));
    }
    if (frame.type === "conversation.item.create" || frame.type === "response.create") {
      outputs.push(frame);
      if (frame.type === "response.create") done();
    }
  });
  const calls: VoiceToolCall[] = [];
  const session = new OpenAiShapedRealtimeSession(dialect(port, true));
  try {
    await session.connect(seed, events(calls, "Created."));
    await finished;
    const update = (frames.find((frame) => frame.type === "session.update") as { session: Record<string, unknown> }).session;
    assert.deepEqual(
      (update.tools as Array<Record<string, unknown>>).map((tool) => [tool.type, tool.name]),
      [["function", "gcal__create_event"], ["function", GEMINI_DELEGATE_FUNCTION]]
    );
    assert.equal(update.tool_choice, "auto");
    assert.ok(String(update.instructions).includes(VOICE_TOOL_LIMIT_WITH_TOOLS));
    assert.equal(calls.length, 1);
    assert.deepEqual(outputs, [
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "Created." } },
      { type: "response.create" },
    ]);
    assert.equal(session.established().tools, 2);
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a dialect not vetted for functions, and GPT-Live, declare no tools and say so", async () => {
  const { server, frames, port } = await liveServer(() => {});
  const session = new OpenAiShapedRealtimeSession(dialect(port, false));
  try {
    await session.connect(seed, events([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const update = (frames.find((frame) => frame.type === "session.update") as { session: Record<string, unknown> }).session;
    assert.equal("tools" in update, false);
    assert.equal(update.instructions, seed.instructions);
    assert.equal(session.established().tools, 0);
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // The OpenAI provider before either leg answers, and its GPT-Live leg, carry none.
  assert.equal(new OpenAiVoiceSession(dialect(1, true)).established().tools, 0);
});
