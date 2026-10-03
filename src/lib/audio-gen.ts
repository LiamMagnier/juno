import "server-only";
import { googleNativeBaseUrl, providerApiKey } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import type { MediaWire } from "@/lib/media-params";
import { isAudioGenSupported, requestLyriaTrack, type GeneratedAudio } from "@/lib/audio-gen-core";

export { isAudioGenSupported, type GeneratedAudio } from "@/lib/audio-gen-core";

/**
 * Generate one track with an audio model. Google's Lyria is the only audio
 * provider today; the request, parsing and error wording live in
 * `audio-gen-core.ts`, where the tests can reach them.
 */
export async function generateAudio(model: ModelInfo, prompt: string, wire: MediaWire | null = null): Promise<GeneratedAudio> {
  if (!isAudioGenSupported(model)) throw new Error(`${model.name} can't generate audio here yet.`);
  const apiKey = providerApiKey("google");
  if (!apiKey) throw new Error("Google API key is not configured.");
  return requestLyriaTrack(model, prompt, { apiKey, baseUrl: googleNativeBaseUrl(), wire });
}
