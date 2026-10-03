import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_AUDIO_MODEL, GEN_MODELS, resolveModel, type Modality } from "../src/lib/models";
import { effectiveMinPlan } from "../src/lib/plans";
import { DEFAULT_ESTIMATE_MICRO_USD } from "../src/lib/spend-ceiling";
import { sniffAudioMime } from "../src/lib/uploads";
import {
  LYRIA_CLIP_MICRO_USD,
  LYRIA_SONG_MICRO_USD,
  audioRequestCostMicroUsd,
  buildLyriaRequestBody,
  isAudioGenSupported,
  lyriaErrorMessage,
  lyricsMarkdown,
  parseLyriaInteraction,
  readableLyrics,
  requestLyriaTrack,
} from "../src/lib/audio-gen-core";
import { audioTitleParts, formatTrackTime } from "../src/components/chat/audio-attachment";

/** A plausible MP3: an ID3v2 header followed by enough frame bytes to pass the size floor. */
function fakeMp3(size = 4096): Buffer {
  const bytes = Buffer.alloc(size, 0x55);
  bytes.write("ID3", 0, "ascii");
  bytes[3] = 0x04;
  return bytes;
}

/** A RIFF/WAVE header over silence. */
function fakeWav(size = 4096): Buffer {
  const bytes = Buffer.alloc(size, 0);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

function interaction(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "int_1", status: "completed", steps: [{ type: "model_output", content: blocks }], ...extra };
}

// ---- Catalog --------------------------------------------------------------

test("the three Lyria models are audio entries with Google's exact ids", () => {
  const ids = ["google:lyria-3.5", "google:lyria-3-clip-preview", "google:lyria-3-pro-preview"];
  for (const id of ids) {
    const model = resolveModel(id);
    assert.ok(model, `${id} must resolve`);
    assert.equal(model.modality satisfies Modality, "audio");
    assert.equal(model.provider, "google");
    assert.equal(model.providerModel, id.slice("google:".length));
    assert.equal(effectiveMinPlan(model.minPlan), "PRO");
    assert.equal(model.vision, false, "the route sends text only, so no attach affordance");
    assert.equal(model.reasoning, false);
    assert.equal(model.webSearch, false);
    assert.ok(model.description && !model.description.includes("—"), "catalogue voice: no em dash");
    assert.ok(GEN_MODELS.some((m) => m.id === id), `${id} must be in GEN_MODELS`);
  }
  assert.equal(resolveModel("google:lyria-3.5")?.status, "current");
  assert.equal(resolveModel("google:lyria-3-clip-preview")?.status, "current");
  assert.equal(resolveModel("google:lyria-3-pro-preview")?.status, "legacy", "Lyria 3.5 supersedes Lyria 3 Pro");
});

test("Lyria 3.5 is the default audio model and Lyria RealTime is not offered", () => {
  assert.equal(DEFAULT_AUDIO_MODEL, "google:lyria-3.5");
  assert.equal(resolveModel(DEFAULT_AUDIO_MODEL)?.modality, "audio");
  assert.equal(
    GEN_MODELS.some((m) => m.providerModel.startsWith("lyria-realtime")),
    false,
    "a streaming model has no player to stream into",
  );
  assert.ok(GEN_MODELS.filter((m) => m.modality === "audio").every(isAudioGenSupported));
});

// ---- Request / response ---------------------------------------------------

test("the request body is the documented { model, input }", () => {
  assert.deepEqual(buildLyriaRequestBody("lyria-3.5", "A beautiful piano melody."), {
    model: "lyria-3.5",
    input: "A beautiful piano melody.",
  });
});

test("parser returns the MP3 bytes and the lyrics from a model_output step", () => {
  const mp3 = fakeMp3();
  const result = parseLyriaInteraction(
    interaction([
      { type: "text", text: "[Verse]\nRain on the window\n\n[Chorus]\nHold on" },
      { type: "audio", data: mp3.toString("base64"), mime_type: "audio/mp3" },
    ]),
  );
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.ext, "mp3");
  assert.deepEqual(result.bytes, mp3);
  assert.equal(result.lyrics, "[Verse]\nRain on the window\n\n[Chorus]\nHold on");
});

test("parser trusts the bytes over the label: a RIFF track is WAV whatever it says", () => {
  const wav = fakeWav();
  const result = parseLyriaInteraction(interaction([{ type: "audio", data: wav.toString("base64"), mime_type: "audio/mpeg" }]));
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.ext, "wav");
  assert.equal(result.lyrics, null);
});

test("parser ignores a stored interaction's user_input step", () => {
  const mp3 = fakeMp3();
  const result = parseLyriaInteraction({
    status: "completed",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "my prompt" }] },
      { type: "model_output", content: [{ type: "audio", data: mp3.toString("base64") }] },
    ],
  });
  assert.equal(result.lyrics, null);
});

test("a JSON structure description becomes readable lyrics, or nothing", () => {
  assert.equal(
    readableLyrics([JSON.stringify({ sections: [{ section: "Verse", lyrics: "Line one\nLine two" }, { section: "Chorus", lines: ["Sing", "it"] }] })]),
    "[Verse]\nLine one\nLine two\n\n[Chorus]\nSing\nit",
  );
  assert.equal(readableLyrics([JSON.stringify({ sections: [{ section: "Intro", start: "0:00", end: "0:10" }] })]), null);
  assert.equal(readableLyrics(["  "]), null);
});

test("lyrics become Markdown that keeps every line and never turns a lyric into a list", () => {
  const md = lyricsMarkdown("[Verse 1]\nRain on the window\n- not a bullet\n1. not a list\n\n[Chorus]\nhold *on*");
  assert.equal(md, "*Verse 1*  \nRain on the window  \n\\- not a bullet  \n1\\. not a list\n\n*Chorus*  \nhold \\*on\\*");
});

test("no audio block (a blocked prompt) and failed interactions are clear errors", () => {
  assert.throws(() => parseLyriaInteraction(interaction([{ type: "text", text: "sorry" }])), /returned no audio.*safety filters/s);
  assert.throws(
    () => parseLyriaInteraction({ status: "failed", error: { message: "Internal error" } }),
    /couldn't make this track: Internal error/,
  );
  assert.throws(
    () => parseLyriaInteraction(interaction([{ type: "audio", data: Buffer.from("<html>not audio</html>".repeat(80)).toString("base64") }])),
    /couldn't play/,
  );
});

test("HTTP errors read as actions, not codes", () => {
  assert.match(lyriaErrorMessage(429, "{}"), /at its limit/);
  assert.match(
    lyriaErrorMessage(400, JSON.stringify({ error: { code: 400, message: "Request blocked by safety filters", status: "INVALID_ARGUMENT" } })),
    /declined this prompt/,
  );
  assert.match(lyriaErrorMessage(403, "{}"), /refused the API key/);
  assert.match(lyriaErrorMessage(404, "{}"), /isn't available/);
  assert.match(lyriaErrorMessage(503, "{}"), /had a problem \(503\)/);
  assert.match(lyriaErrorMessage(400, JSON.stringify({ error: { message: "input too long" } })), /rejected the request \(400\): input too long/);
});

test("requestLyriaTrack posts to /interactions with the key header and parses the reply", async () => {
  const mp3 = fakeMp3();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(interaction([{ type: "audio", data: mp3.toString("base64") }, { type: "text", text: "La la" }])), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const track = await requestLyriaTrack({ providerModel: "lyria-3.5", name: "Lyria 3.5" }, "a lullaby", {
    apiKey: "test-key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "test-key");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { model: "lyria-3.5", input: "a lullaby" });
  assert.ok(calls[0].init.signal, "the call carries a timeout");
  assert.equal(track.lyrics, "La la");
  assert.deepEqual(track.bytes, mp3);
});

test("requestLyriaTrack maps a 429 and a timeout to readable errors", async () => {
  const busy = (async () => new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }), { status: 429 })) as typeof fetch;
  await assert.rejects(
    requestLyriaTrack({ providerModel: "lyria-3.5", name: "Lyria 3.5" }, "x", { apiKey: "k", baseUrl: "https://x/v1beta", fetchImpl: busy }),
    /Lyria 3.5 is at its limit/,
  );
  const slow = (async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  }) as typeof fetch;
  await assert.rejects(
    requestLyriaTrack({ providerModel: "lyria-3.5", name: "Lyria 3.5" }, "x", { apiKey: "k", baseUrl: "https://x/v1beta", fetchImpl: slow }),
    /took too long/,
  );
});

// ---- Sniffing -------------------------------------------------------------

test("audio sniffing: ID3, MPEG frames, WAV, FLAC, Ogg; not JPEG or ADTS or noise", () => {
  assert.equal(sniffAudioMime(fakeMp3(16)), "audio/mpeg");
  assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])), "audio/mpeg"); // MPEG-1 Layer III, 128k, 44.1k
  assert.equal(sniffAudioMime(fakeWav(16)), "audio/wav");
  assert.equal(sniffAudioMime(Buffer.from("fLaC\0\0\0\x22")), "audio/flac");
  assert.equal(sniffAudioMime(Buffer.from("OggS\0\x02\0\0")), "audio/ogg");
  assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), null, "JPEG is not audio");
  assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xf1, 0x50, 0x80])), null, "ADTS AAC uses the reserved layer");
  assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xff, 0xff, 0xff])), null, "invalid bitrate and sample rate");
  assert.equal(sniffAudioMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), null, "WebP is RIFF but not WAVE");
});

// ---- Spend ----------------------------------------------------------------

test("audio is metered at Google's per-song price", () => {
  assert.equal(LYRIA_SONG_MICRO_USD, 80_000, "$0.08 per song");
  assert.equal(LYRIA_CLIP_MICRO_USD, 40_000, "$0.04 per 30s clip");
  assert.equal(audioRequestCostMicroUsd("google:lyria-3.5"), 80_000);
  assert.equal(audioRequestCostMicroUsd("google:lyria-3-pro-preview"), 80_000);
  assert.equal(audioRequestCostMicroUsd("google:lyria-3-clip-preview"), 40_000);
  assert.equal(DEFAULT_ESTIMATE_MICRO_USD.audio, 80_000);

  // spend.ts is server-only (Prisma), so its wiring is pinned as text.
  const spend = readFileSync(new URL("../src/lib/spend.ts", import.meta.url), "utf8");
  const body = spend.slice(spend.indexOf("export function mediaRequestCost"));
  assert.match(body, /kind: "image" \| "video" \| "audio"/);
  assert.match(body, /if \(kind === "audio"\) return audioRequestCostMicroUsd\(id\);/);
  assert.match(spend, /input\.kind === "image" \|\| input\.kind === "video" \|\| input\.kind === "audio"/);
});

// ---- Route wiring ---------------------------------------------------------

test("/api/generate dispatches audio, stores a FILE with lyrics, records audio spend and refunds on failure", () => {
  const route = readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(media === "audio"\) \{/);
  // The prompt carries any prompt-steered choice (instrumental); the wire carries WAV.
  assert.match(route, /await generateAudio\(model, providerPrompt, genPlan\.wire\)/);
  assert.match(route, /keepalive = setInterval\(\(\) => send\(composing\), 8_000\)/);
  assert.match(route, /baseName = `\$\{model\.name\} — \$\{title \|\| "track"\}`/);
  assert.match(route, /audio: "New track"/);
  assert.match(route, /kind: media,/);
  assert.match(route, /content: encryptMessageText\(replyText\)/);
  assert.match(route, /refundMessage\(user\.id, plan\)/);
});

// ---- Player helpers -------------------------------------------------------

test("the player names a track from its file name and formats time", () => {
  assert.deepEqual(audioTitleParts("Lyria 3.5 — Rain on a tin roof.mp3"), { title: "Rain on a tin roof", source: "Lyria 3.5" });
  assert.deepEqual(audioTitleParts("demo.wav"), { title: "demo", source: null });
  assert.equal(formatTrackTime(7), "0:07");
  assert.equal(formatTrackTime(161.9), "2:41");
  assert.equal(formatTrackTime(3723), "1:02:03");
  assert.equal(formatTrackTime(Number.NaN), "–:––");
  assert.equal(formatTrackTime(Number.POSITIVE_INFINITY), "–:––");
});
