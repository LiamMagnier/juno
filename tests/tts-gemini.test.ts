import assert from "node:assert/strict";
import test from "node:test";
import { ttsProviderOrder, normalizeTtsProvider } from "@/lib/tts-order";
import {
  vetVoiceForProvider,
  voicesFor,
  defaultVoiceFor,
  GEMINI_VOICES,
  GEMINI_VOICE_IDS,
  VOICE_IDS,
  isGeminiVoice,
  isOpenAiVoice,
} from "@/lib/voices";

// env.ts reads the voice block at import, so the environment is fixed before
// anything that imports it loads (dynamically, below).
delete process.env.TTS_PROVIDER;
delete process.env.GOOGLE_TTS_MODEL;
delete process.env.GOOGLE_TTS_VOICE;
delete process.env.GOOGLE_BASE_URL;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_LIVE_API_KEY;
process.env.GOOGLE_API_KEY = "AIza-test-google";
process.env.OPENAI_API_KEY = "sk-test-openai";
delete process.env.ELEVENLABS_API_KEY;

const ALL = { google: true, openai: true, elevenlabs: true };

// ─── Provider order ─────────────────────────────────────────────────────────

test("Gemini leads whenever the Google key is set, then OpenAI, then ElevenLabs", () => {
  assert.deepEqual(ttsProviderOrder(undefined, ALL), ["google", "openai", "elevenlabs"]);
  assert.deepEqual(ttsProviderOrder("", { google: true, openai: false, elevenlabs: true }), ["google", "elevenlabs"]);
  assert.deepEqual(ttsProviderOrder(undefined, { google: true, openai: false, elevenlabs: false }), ["google"]);
});

test("without a Google key and without TTS_PROVIDER, server TTS stays off (OpenAI/ElevenLabs remain opt-in)", () => {
  assert.deepEqual(ttsProviderOrder(undefined, { google: false, openai: true, elevenlabs: true }), []);
});

test("TTS_PROVIDER forces its provider to the front and keeps the rest as fallbacks", () => {
  assert.deepEqual(ttsProviderOrder("openai", ALL), ["openai", "google", "elevenlabs"]);
  assert.deepEqual(ttsProviderOrder("elevenlabs", ALL), ["elevenlabs", "google", "openai"]);
  assert.deepEqual(ttsProviderOrder("gemini", ALL), ["google", "openai", "elevenlabs"]);
  assert.deepEqual(ttsProviderOrder(" Google ", { google: true, openai: false, elevenlabs: false }), ["google"]);
});

test("a forced provider without its key turns server TTS off rather than silently switching", () => {
  assert.deepEqual(ttsProviderOrder("openai", { google: true, openai: false, elevenlabs: true }), []);
});

test("an unknown TTS_PROVIDER is ignored, not trusted", () => {
  assert.equal(normalizeTtsProvider("polly"), null);
  assert.deepEqual(ttsProviderOrder("polly", ALL), ["google", "openai", "elevenlabs"]);
});

// ─── Voices ─────────────────────────────────────────────────────────────────

test("the Gemini list is the 30 prebuilt voices, with timbre-only descriptions", () => {
  assert.equal(GEMINI_VOICE_IDS.length, 30);
  assert.deepEqual(GEMINI_VOICES.map((v) => v.id), [...GEMINI_VOICE_IDS]);
  for (const v of GEMINI_VOICES) {
    assert.doesNotMatch(v.description, /\b(male|female|man|woman|boy|girl|young|youthful|old|mature|british|american|accent)\b/i, v.id);
  }
  // No id is valid for both providers, so a saved id always says whose it is.
  for (const id of VOICE_IDS) assert.equal(isGeminiVoice(id), false);
  for (const id of GEMINI_VOICE_IDS) assert.equal(isOpenAiVoice(id), false);
});

test("the picker lists the live provider's voices and its default", () => {
  assert.equal(voicesFor("google"), GEMINI_VOICES);
  assert.equal(voicesFor("openai").length, VOICE_IDS.length);
  assert.equal(voicesFor("elevenlabs").length, 0);
  assert.equal(voicesFor(null).length, 0);
  assert.equal(defaultVoiceFor("google"), "Kore");
  assert.equal(defaultVoiceFor("openai"), "alloy");
});

test("a saved voice is only sent to the provider that owns it", () => {
  // OpenAI id → Gemini: dropped (Gemini's default is used).
  assert.equal(vetVoiceForProvider("google", "alloy"), undefined);
  assert.equal(vetVoiceForProvider("google", "Kore"), "Kore");
  // Gemini id → OpenAI: dropped.
  assert.equal(vetVoiceForProvider("openai", "Puck"), undefined);
  assert.equal(vetVoiceForProvider("openai", "marin"), "marin");
  // ElevenLabs keeps unknown hashes, drops both known lists.
  assert.equal(vetVoiceForProvider("elevenlabs", "21m00Tcm4TlvDq8ikWAM"), "21m00Tcm4TlvDq8ikWAM");
  assert.equal(vetVoiceForProvider("elevenlabs", "alloy"), undefined);
  assert.equal(vetVoiceForProvider("elevenlabs", "Kore"), undefined);
  // Case matters: Google's names are capitalised.
  assert.equal(vetVoiceForProvider("google", "kore"), undefined);
  assert.equal(vetVoiceForProvider("google", undefined), undefined);
});

// ─── Gemini request / response ──────────────────────────────────────────────

function wavBytes(): Buffer {
  // 44-byte RIFF/WAVE header + 4 bytes of silence (24 kHz mono 16-bit).
  const data = Buffer.alloc(4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function geminiOk(): Response {
  return Response.json({
    id: "int_1",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "hi" }] },
      { type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wavBytes().toString("base64") }] },
    ],
  });
}

test("Gemini gets the documented Interactions body: model, text + speech_metadata style, WAV, voice", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  const calls = mockFetch(() => geminiOk());
  const out = await synthesizeSpeech("Bonjour tout le monde", "Puck");
  assert.ok(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "AIza-test-google");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "gemini-3.8-flash-tts");
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].type, "user_input");
  const part = body.input[0].content[0];
  assert.equal(part.type, "text");
  assert.equal(part.text, "Bonjour tout le monde");
  assert.equal(part.annotations[0].type, "speech_metadata");
  assert.match(part.annotations[0].style, /native/);
  assert.deepEqual(body.response_format, { type: "audio", mime_type: "audio/wav", sample_rate: 24000 });
  assert.deepEqual(body.generation_config, { speech_config: [{ voice: "Puck" }] });
});

test("Gemini audio comes back as audio/wav bytes, decoded from steps[].content[].data", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  mockFetch(() => geminiOk());
  const out = await synthesizeSpeech("Hello", undefined);
  assert.ok(out);
  assert.equal(out.provider, "google");
  assert.equal(out.contentType, "audio/wav");
  assert.deepEqual(Buffer.from(out.audio), wavBytes());
});

test("a saved OpenAI voice reaches Gemini as the default (Kore), never as itself", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  const calls = mockFetch(() => geminiOk());
  await synthesizeSpeech("Hello", "alloy");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.generation_config.speech_config, [{ voice: "Kore" }]);
});

test("when Gemini fails, OpenAI answers with MP3 and its own default voice", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  const prevError = console.error;
  console.error = () => {};
  try {
    const calls = mockFetch((url) =>
      url.includes("googleapis")
        ? new Response("quota", { status: 429 })
        : new Response(new Uint8Array([0xff, 0xf3, 0x00, 0x00]), { status: 200 })
    );
    const out = await synthesizeSpeech("Hello", "Kore");
    assert.ok(out);
    assert.equal(out.provider, "openai");
    assert.equal(out.contentType, "audio/mpeg");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(String(calls[1].init.body));
    // The Gemini id is not OpenAI's: OpenAI uses TTS_VOICE's default.
    assert.equal(body.voice, "alloy");
  } finally {
    console.error = prevError;
  }
});

test("a Gemini response without audio counts as a failure, so the chain moves on", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  const prevError = console.error;
  console.error = () => {};
  try {
    mockFetch((url) =>
      url.includes("googleapis") ? Response.json({ steps: [] }) : new Response(new Uint8Array([1, 2]), { status: 200 })
    );
    const out = await synthesizeSpeech("Hello", undefined);
    assert.equal(out?.provider, "openai");
  } finally {
    console.error = prevError;
  }
});

test("every provider failing yields null (the route answers 502)", async () => {
  const { synthesizeSpeech } = await import("@/lib/tts");
  const prevError = console.error;
  console.error = () => {};
  try {
    mockFetch(() => new Response("nope", { status: 500 }));
    assert.equal(await synthesizeSpeech("Hello", undefined), null);
  } finally {
    console.error = prevError;
  }
});

test("server TTS is on and Gemini is the active provider with only the Google + OpenAI keys", async () => {
  const { isServerTtsConfigured, activeTtsProvider, serverTtsOrder } = await import("@/lib/env");
  assert.equal(isServerTtsConfigured(), true);
  assert.equal(activeTtsProvider(), "google");
  assert.deepEqual(serverTtsOrder(), ["google", "openai"]);
});

test("the route returns the provider's real content type, not a hard-coded audio/mpeg", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(new URL("../src/app/api/voice/tts/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /"Content-Type": "audio\/mpeg"/);
  assert.match(route, /"Content-Type": spoken\.contentType/);
});
