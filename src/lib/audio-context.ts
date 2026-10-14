/**
 * The page's one shared AudioContext, created on first use and resumed when
 * the browser has suspended it.
 *
 * The same few lines `voice-glow` exports as `getAudioContext`. The product
 * imported that package for this function alone, and because the dev voice
 * labs import its `VoiceBeam` from the same module, webpack kept the whole
 * library (38.5 kB minified) in the chunk every conversation loads. The labs
 * still use the package; voice in the product shares this context instead.
 */
let shared: AudioContext | null = null;

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function getAudioContext(): AudioContext | null {
  const AudioContextClass = audioContextClass();
  if (!AudioContextClass) return null;
  shared ??= new AudioContextClass();
  if (shared.state === "suspended") shared.resume().catch(() => {});
  return shared;
}
