import { env, serverTtsOrder } from "@/lib/env";
import { googleNativeBaseUrl, providerApiKey } from "@/lib/providers";
import { vetVoiceForProvider, type TtsProvider } from "@/lib/voices";

/**
 * Server text-to-speech: one call per provider, and the fallback chain the
 * `/api/voice/tts` route runs. Each provider returns its audio with its REAL
 * content type — Gemini answers with WAV, OpenAI and ElevenLabs with MP3 — so
 * the route never labels one as the other.
 */

export interface TtsAudio {
  audio: ArrayBuffer;
  contentType: string;
  provider: TtsProvider;
}

// One sentence of direction for every engine that takes one: read the text in
// its own language the way a native speaker would. Without it a model tends to
// carry the voice's "home" accent into French, Japanese, Arabic…
const NATIVE_DELIVERY =
  "Detect the language of the text and read it as a native speaker of that language would, " +
  "with that language's natural accent, rhythm and pronunciation. Never read it with an English accent " +
  "unless the text itself is English. Speak naturally and clearly at a conversational pace.";

// Gemini's `speech_metadata.style` is a delivery attribute ("cheerful", "out of
// breath"), so it gets the short form of the same instruction.
export const GEMINI_NATIVE_STYLE =
  "natural, native-speaker delivery in the text's own language and accent; clear, conversational pace";

/** The Interactions API request body for one single-speaker Gemini reading. */
export function geminiTtsBody(text: string, voice: string, model: string) {
  return {
    model,
    input: [
      {
        type: "user_input",
        content: [
          {
            type: "text",
            text,
            annotations: [{ type: "speech_metadata", style: GEMINI_NATIVE_STYLE }],
          },
        ],
      },
    ],
    // Unary + audio/wav: a complete RIFF file (24 kHz mono 16-bit PCM) that an
    // <audio> element, AVAudioPlayer and AudioContext all play as-is.
    response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
    generation_config: { speech_config: [{ voice }] },
  };
}

interface GeminiInteraction {
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; mime_type?: string }>;
  }>;
}

/** The last audio part of the interaction, decoded. Null when there is none. */
export function geminiAudioFromResponse(json: unknown): { audio: ArrayBuffer; contentType: string } | null {
  const steps = (json as GeminiInteraction | null)?.steps;
  if (!Array.isArray(steps)) return null;
  let found: { data: string; mime?: string } | null = null;
  for (const step of steps) {
    for (const part of step?.content ?? []) {
      if (part?.type === "audio" && typeof part.data === "string" && part.data) {
        found = { data: part.data, mime: part.mime_type };
      }
    }
  }
  if (!found) return null;
  const bytes = Buffer.from(found.data, "base64");
  if (bytes.length === 0) return null;
  // Trust the bytes over the label: a RIFF header is WAV whatever the part says.
  const isRiff = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  const contentType = isRiff ? "audio/wav" : found.mime || "audio/wav";
  const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { audio, contentType };
}

// gemini-3.8-flash-tts: Google's TTS model. It detects the text's language
// itself (130+) and reads it natively; the style annotation reinforces that.
export async function googleTts(
  text: string,
  voiceId: string | undefined,
  apiKey: string
): Promise<{ audio: ArrayBuffer; contentType: string }> {
  const res = await fetch(`${googleNativeBaseUrl()}/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    // Caller-supplied ids are vetted against GEMINI_VOICE_IDS before they get
    // here; GOOGLE_TTS_VOICE deliberately is NOT (see env.ts).
    body: JSON.stringify(geminiTtsBody(text, voiceId || env.voice.googleTtsVoice, env.voice.googleTtsModel)),
  });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const decoded = geminiAudioFromResponse(await res.json().catch(() => null));
  if (!decoded) throw new Error("Gemini TTS returned no audio");
  return decoded;
}

// gpt-4o-mini-tts: high quality, and it reads text in the text's OWN language
// with a native accent — unlike the browser's SpeechSynthesis fallback, which
// applies the OS voice's accent (e.g. French read with an English accent).
export async function openaiTts(text: string, voiceId: string | undefined, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.voice.ttsModel,
      // Caller-supplied ids are vetted against the known list before they get
      // here; TTS_VOICE deliberately is NOT, so an operator can adopt a voice
      // OpenAI ships before this code learns about it.
      voice: voiceId || env.voice.ttsVoice,
      input: text,
      response_format: "mp3",
      // `instructions` is only accepted by the gpt-4o*-tts line; the older
      // tts-1/tts-1-hd models reject it.
      ...(/^gpt-4o.*-tts$/.test(env.voice.ttsModel) ? { instructions: NATIVE_DELIVERY } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.arrayBuffer();
}

// eleven_multilingual_v2: strong across ~30 languages.
export async function elevenTts(
  text: string,
  voiceId: string | undefined,
  apiKey: string,
  defaultVoice?: string
): Promise<ArrayBuffer> {
  const vid = voiceId || defaultVoice || "21m00Tcm4TlvDq8ikWAM";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Read `text` aloud with the first provider in the chain that succeeds.
 * Null when every attempt failed (or none is configured).
 *
 * A saved voiceId is only ever as good as the moment it was stored: it can be
 * stale (a retired voice), hand-edited, or belong to ANOTHER provider now that
 * the chain can cross over. Each attempt keeps only an id its provider owns and
 * otherwise uses its own configured default.
 */
export async function synthesizeSpeech(text: string, voiceId: string | undefined): Promise<TtsAudio | null> {
  for (const provider of serverTtsOrder()) {
    const voice = vetVoiceForProvider(provider, voiceId);
    try {
      if (provider === "google") {
        const key = providerApiKey("google");
        if (!key) continue;
        const out = await googleTts(text, voice, key);
        return { ...out, provider };
      }
      if (provider === "openai") {
        const key = env.voice.openaiApiKey;
        if (!key) continue;
        return { audio: await openaiTts(text, voice, key), contentType: "audio/mpeg", provider };
      }
      const key = env.voice.elevenlabsApiKey;
      if (!key) continue;
      return {
        audio: await elevenTts(text, voice, key, env.voice.elevenlabsVoiceId),
        contentType: "audio/mpeg",
        provider,
      };
    } catch (err) {
      console.error("[tts]", err);
    }
  }
  return null;
}
