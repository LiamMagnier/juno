// Single source of truth for the server text-to-speech voices (OpenAI's, and
// Gemini's further down) — used by the settings picker and by the TTS route to
// reject stale or foreign voice ids.
//
// The list is the one the API enumerates for itself (an invalid `voice` value
// makes it reply with the full set); all 13 are valid for gpt-4o-mini-tts.
//
// SCOPE: the ids in VOICE_IDS are OpenAI-only. ElevenLabs voice ids are account-specific
// hashes and will never appear here, so a false from `isOpenAiVoice` means
// "not an OpenAI voice" — NOT "invalid". Never use it to reject an ElevenLabs id.

// Kept in the API's own enumeration order rather than alphabetised: it puts the
// long-standing voices first and the newer additions last, which is also a
// reasonable familiarity ordering for the picker.
export const VOICE_IDS = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "coral",
  "verse",
  "ballad",
  "ash",
  "sage",
  "marin",
  "cedar",
] as const;

export type VoiceId = (typeof VOICE_IDS)[number];

export interface Voice {
  id: VoiceId;
  label: string;
  /** Two or three words on timbre only. Deliberately makes no claim about the
   *  voice's gender or accent — the model reads each language natively, so any
   *  such claim would be wrong as often as right. The preview button is the
   *  real answer to "what does this sound like". */
  description: string;
}

export const VOICES: readonly Voice[] = [
  // alloy / nova / onyx keep the wording the voice settings picker already
  // ships ("Clear" / "Warm" / "Deep"), so the same voice isn't described two ways.
  { id: "alloy", label: "Alloy", description: "Neutral and crisp" },
  { id: "echo", label: "Echo", description: "Even and measured" },
  { id: "fable", label: "Fable", description: "Bright and expressive" },
  { id: "onyx", label: "Onyx", description: "Low and steady" },
  { id: "nova", label: "Nova", description: "Rounded and friendly" },
  { id: "shimmer", label: "Shimmer", description: "Light and airy" },
  { id: "coral", label: "Coral", description: "Warm and lively" },
  { id: "verse", label: "Verse", description: "Animated and varied" },
  { id: "ballad", label: "Ballad", description: "Soft and unhurried" },
  { id: "ash", label: "Ash", description: "Firm and direct" },
  { id: "sage", label: "Sage", description: "Calm and level" },
  { id: "marin", label: "Marin", description: "Relaxed and conversational" },
  { id: "cedar", label: "Cedar", description: "Smooth and easy-going" },
];

export const DEFAULT_VOICE: VoiceId = "alloy";

export function isOpenAiVoice(id: string | null | undefined): id is VoiceId {
  return typeof id === "string" && (VOICE_IDS as readonly string[]).includes(id);
}

// ─── Gemini (gemini-3.8-flash-tts) ──────────────────────────────────────────
//
// The 30 prebuilt voices of Google's TTS models, in the order Google's speech
// generation docs list them. Ids are the API's own names, capitalised as sent
// (`speech_config: [{ voice: "Kore" }]`), so none collides with an OpenAI id.
// Descriptions follow the rule above: timbre only, no gender, age or accent —
// the model detects the text's language and reads it natively.
export const GEMINI_VOICE_IDS = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

export type GeminiVoiceId = (typeof GEMINI_VOICE_IDS)[number];

export interface GeminiVoice {
  id: GeminiVoiceId;
  label: string;
  description: string;
}

export const GEMINI_VOICES: readonly GeminiVoice[] = [
  { id: "Zephyr", label: "Zephyr", description: "Bright and clear" },
  { id: "Puck", label: "Puck", description: "Upbeat and lively" },
  { id: "Charon", label: "Charon", description: "Informative and level" },
  { id: "Kore", label: "Kore", description: "Firm and assured" },
  { id: "Fenrir", label: "Fenrir", description: "Excitable and quick" },
  { id: "Leda", label: "Leda", description: "Light and fresh" },
  { id: "Orus", label: "Orus", description: "Firm and grounded" },
  { id: "Aoede", label: "Aoede", description: "Breezy and open" },
  { id: "Callirrhoe", label: "Callirrhoe", description: "Easy-going and relaxed" },
  { id: "Autonoe", label: "Autonoe", description: "Bright and articulate" },
  { id: "Enceladus", label: "Enceladus", description: "Breathy and soft" },
  { id: "Iapetus", label: "Iapetus", description: "Clear and direct" },
  { id: "Umbriel", label: "Umbriel", description: "Easy-going and warm" },
  { id: "Algieba", label: "Algieba", description: "Smooth and mellow" },
  { id: "Despina", label: "Despina", description: "Smooth and flowing" },
  { id: "Erinome", label: "Erinome", description: "Clear and precise" },
  { id: "Algenib", label: "Algenib", description: "Gravelly and textured" },
  { id: "Rasalgethi", label: "Rasalgethi", description: "Informative and steady" },
  { id: "Laomedeia", label: "Laomedeia", description: "Upbeat and bright" },
  { id: "Achernar", label: "Achernar", description: "Soft and gentle" },
  { id: "Alnilam", label: "Alnilam", description: "Firm and even" },
  { id: "Schedar", label: "Schedar", description: "Even and balanced" },
  { id: "Gacrux", label: "Gacrux", description: "Rich and seasoned" },
  { id: "Pulcherrima", label: "Pulcherrima", description: "Forward and confident" },
  { id: "Achird", label: "Achird", description: "Friendly and open" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi", description: "Casual and loose" },
  { id: "Vindemiatrix", label: "Vindemiatrix", description: "Gentle and calm" },
  { id: "Sadachbia", label: "Sadachbia", description: "Lively and animated" },
  { id: "Sadaltager", label: "Sadaltager", description: "Knowledgeable and measured" },
  { id: "Sulafat", label: "Sulafat", description: "Warm and full" },
];

export const DEFAULT_GEMINI_VOICE: GeminiVoiceId = "Kore";

export function isGeminiVoice(id: string | null | undefined): id is GeminiVoiceId {
  return typeof id === "string" && (GEMINI_VOICE_IDS as readonly string[]).includes(id);
}

// ─── Per provider ───────────────────────────────────────────────────────────

/** The server TTS engines, in the default fallback order (see `lib/tts.ts`). */
export type TtsProvider = "google" | "openai" | "elevenlabs";

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

/** The voices the picker offers under `provider` — empty for ElevenLabs, whose
 *  ids are account-specific and set by the operator (ELEVENLABS_VOICE_ID). */
export function voicesFor(provider: TtsProvider | null | undefined): readonly VoiceOption[] {
  if (provider === "google") return GEMINI_VOICES;
  if (provider === "openai") return VOICES;
  return [];
}

export function defaultVoiceFor(provider: TtsProvider | null | undefined): string | null {
  if (provider === "google") return DEFAULT_GEMINI_VOICE;
  if (provider === "openai") return DEFAULT_VOICE;
  return null;
}

/**
 * The caller's saved voice, narrowed to what `provider` can actually use.
 *
 * A saved id can belong to the OTHER provider (the setting was chosen while
 * OpenAI was live, or the fallback chain crossed over), and handing a provider
 * an id it doesn't own is a guaranteed 400/404. Undefined means "use the
 * provider's own configured default".
 */
export function vetVoiceForProvider(provider: TtsProvider, voiceId: string | null | undefined): string | undefined {
  if (!voiceId) return undefined;
  if (provider === "google") return isGeminiVoice(voiceId) ? voiceId : undefined;
  if (provider === "openai") return isOpenAiVoice(voiceId) ? voiceId : undefined;
  // ElevenLabs ids can't be validated (arbitrary hashes) — but a known OpenAI
  // or Gemini voice name is definitely not one of them, so drop those.
  return isOpenAiVoice(voiceId) || isGeminiVoice(voiceId) ? undefined : voiceId;
}
