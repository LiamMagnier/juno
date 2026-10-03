import { notFound } from "next/navigation";

import { VoiceSoundsGallery } from "./gallery";

/**
 * The voice call's two chimes (dev only; 404s in production, and outside
 * `next dev` the page extension does not exist at all).
 *
 *   /dev/voice-sounds   play each cue, and render it through an
 *                       OfflineAudioContext to read its length, level and pitch
 *
 * The offline report is also left on `window.__voiceCueReport` for scripts.
 */
export const metadata = { title: "Voice sounds" };

export default function VoiceSoundsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VoiceSoundsGallery />;
}
