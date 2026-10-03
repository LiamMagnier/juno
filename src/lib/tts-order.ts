import type { TtsProvider } from "@/lib/voices";

/**
 * Which server TTS engines to try, in order — pure, so the route, the feature
 * flags and the tests all agree on one answer.
 *
 * Default (TTS_PROVIDER unset): Gemini 3.8 Flash TTS whenever the Google key is
 * configured, then OpenAI, then ElevenLabs, each only if its key is set. The
 * fallbacks keep read-aloud working (and multilingual) when one provider is
 * rate-limited or out of credit.
 *
 * Without a Google key and without TTS_PROVIDER, server TTS stays off — the
 * other two were always opt-in, and an OPENAI_API_KEY set for chat models must
 * not quietly start billing speech.
 *
 * TTS_PROVIDER forces its provider to the front. If that provider has no key,
 * server TTS is off (the route answers 501 and clients use the device voice):
 * a forced provider that silently became a different one would be harder to
 * notice than a missing key.
 */
export const TTS_DEFAULT_ORDER: readonly TtsProvider[] = ["google", "openai", "elevenlabs"];

export type TtsKeys = Record<TtsProvider, boolean>;

export function normalizeTtsProvider(raw: string | null | undefined): TtsProvider | null {
  const v = raw?.trim().toLowerCase();
  if (v === "google" || v === "gemini") return "google";
  if (v === "openai") return "openai";
  if (v === "elevenlabs") return "elevenlabs";
  return null;
}

export function ttsProviderOrder(forcedRaw: string | null | undefined, keys: TtsKeys): TtsProvider[] {
  const forced = normalizeTtsProvider(forcedRaw);
  if (forced) {
    if (!keys[forced]) return [];
    return [forced, ...TTS_DEFAULT_ORDER.filter((p) => p !== forced && keys[p])];
  }
  if (!keys.google) return [];
  return TTS_DEFAULT_ORDER.filter((p) => keys[p]);
}
