import { notFound } from "next/navigation";

import { VoiceCallStage } from "./stage";
import { STAGE_STATES, type StageState } from "./states";

/**
 * The voice call in the real chat composer (dev only; 404s in production,
 * and outside `next dev` the page extension does not exist at all).
 *
 *   /dev/voice-call?state=<state>&theme=light|dark
 *
 *   state   composer (no call yet: press the voice button to open one) |
 *           connecting | listening | thinking | speaking | muted |
 *           muted-speaking | reconnecting | error | ended | draft
 *   rm      1 renders the reduced-motion form (data-motion="reduced")
 *   ios     1 hides screen sharing, as iOS Safari has no getDisplayMedia
 *
 * The call is a stand-in controller with the hook's shape, and the levels
 * are synthetic speech written to the same bus the hook writes
 * (lib/voice-level.ts), so the chip's meter and the edge light run exactly
 * as in a call. `window.__voiceStage(state)` moves the call from a script;
 * pressing the composer's voice button runs connecting → listening.
 */
export const metadata = { title: "Voice call" };

export default async function VoiceCallPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const theme = str("theme") === "light" || str("theme") === "dark" ? (str("theme") as "light" | "dark") : undefined;
  const state = (STAGE_STATES as readonly string[]).includes(str("state") ?? "") ? (str("state") as StageState) : "composer";
  return <VoiceCallStage key={`${state}-${str("rm")}-${str("ios")}`} state={state} theme={theme} reduced={str("rm") === "1"} ios={str("ios") === "1"} />;
}
