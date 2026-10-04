import { notFound } from "next/navigation";

import { VoiceGlowGallery } from "./stage";
import { PLAYS, STATES, type GlowPlay, type GlowState } from "./scenes";

/**
 * The voice light (dev only; 404s in production, and outside `next dev` the
 * page extension does not exist at all).
 *
 *   /dev/voice-glow?state=lab&theme=light|dark       four directions × four moments, against today
 *   /dev/voice-glow?state=<state>&theme=light|dark   one state, in the real composer under a short thread
 *
 *   state   idle | connecting | listening | thinking | answering | muted | interrupted |
 *           approval | reconnecting | error | ended | dictation | lab
 *   still   1 freezes the state's chosen moment (the still); t=<ms> freezes that scene time
 *   play    flow | interrupt | mute | dictation: the scripted clip, looping
 *   rm      1 renders the reduced-motion form; solid=1 the reduced-transparency form
 *   rows    lab only: a comma list of direction keys to draw (A,B,C,D,Today)
 *   provider  gemini | openai: the call's provider and capabilities, for its settings panel
 *             (absent: Gemini with no capabilities, as the stills were drawn)
 *
 * The voices are deterministic synthetic speech (signal.ts) and a frozen
 * moment is simulated from silence, so every render of a state is the same
 * picture. Clip capture drives `window.__voiceGlowSetTime(ms)` frame by frame.
 */
export const metadata = { title: "Voice light" };

export default async function VoiceGlowPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const theme = str("theme") === "light" || str("theme") === "dark" ? (str("theme") as "light" | "dark") : undefined;
  const state = (STATES as readonly string[]).includes(str("state") ?? "") ? (str("state") as GlowState) : "lab";
  const play = (PLAYS as readonly string[]).includes(str("play") ?? "") ? (str("play") as GlowPlay) : undefined;
  const t = str("t") !== undefined && Number.isFinite(Number(str("t"))) ? Number(str("t")) : undefined;
  return (
    <VoiceGlowGallery
      key={`${state}-${play}-${t}-${str("still")}-${str("rm")}-${str("solid")}-${str("provider")}`}
      provider={str("provider") === "openai" ? "openai" : str("provider") === "gemini" ? "gemini" : "default"}
      state={state}
      play={play}
      theme={theme}
      t={t}
      still={str("still") === "1"}
      reduced={str("rm") === "1" ? true : undefined}
      solid={str("solid") === "1" ? true : undefined}
      rows={str("rows")?.split(",")}
    />
  );
}
