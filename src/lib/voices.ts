// Single source of truth for the OpenAI text-to-speech voices — used by the
// settings picker and by the TTS route to reject stale or foreign voice ids.
//
// The list is the one the API enumerates for itself (an invalid `voice` value
// makes it reply with the full set); all 13 are valid for gpt-4o-mini-tts.
//
// SCOPE: these ids are OpenAI-only. ElevenLabs voice ids are account-specific
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
