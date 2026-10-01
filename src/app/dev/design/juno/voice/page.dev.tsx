import { notFound } from "next/navigation";
import { JUNO_FONTS } from "../fonts";
import { VoiceStage } from "./stage";
import { PLAYS, STATES, type Play, type VoiceState } from "./states";
import "../tokens.css";
import "../shell.css";
import "../composer.css";
import "../thread.css";
import "../pages.css";
import "../sheet.css";
import "../member.css";
import "./voice.css";

/**
 * Voice and dictation, design round 3 (dev only; 404s in production).
 *
 *   /dev/design/juno/voice                                   index
 *   /dev/design/juno/voice?state=<state>&theme=light|dark    one state, live (theme absent: the OS decides)
 *
 *   state    dictation-idle | dictation-permission | dictation-listening | dictation-interim |
 *            dictation-done | dictation-error (kind=blocked|silence|network) |
 *            voice-lab | voice-connecting | voice-listening | voice-thinking | voice-answering |
 *            voice-muted | voice-interrupted | voice-tool-approval | voice-error | voice-ended |
 *            crew-voice (phase=listening|thinking|answering)
 *   freeze   1 freezes the state's chosen moment (the still); a number freezes that scene time in ms
 *   play     voice | dictation | interrupt | mute | crew: the scripted clip, from its first frame
 *   rm       1 renders the reduced-motion form
 *
 * Audio levels come from a deterministic synthetic voice (signal.ts), so every
 * render of a state is the same picture.
 */
export const metadata = { title: "Juno voice" };

export default async function JunoVoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const theme = str("theme") === "light" || str("theme") === "dark" ? (str("theme") as "light" | "dark") : undefined;
  const state = (STATES as readonly string[]).includes(str("state") ?? "") ? (str("state") as VoiceState) : undefined;
  const play = (PLAYS as readonly string[]).includes(str("play") ?? "") ? (str("play") as Play) : undefined;
  return (
    <VoiceStage
      key={`${state}-${play}-${str("freeze")}-${str("rm")}`}
      state={state}
      theme={theme}
      reduced={str("rm") === "1"}
      freeze={str("freeze")}
      play={play}
      kind={str("kind")}
      crewPhase={str("phase")}
      fontClass={JUNO_FONTS}
    />
  );
}
