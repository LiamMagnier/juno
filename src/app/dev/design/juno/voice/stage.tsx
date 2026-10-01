"use client";

import * as React from "react";
import Link from "next/link";
import { crewMember, useMemberTheme } from "../crew-bridge";
import { CREW, THREAD_TITLE } from "../fixtures";
import { Icon } from "../icons";
import { MotionPref } from "../motion";
import { AppFrame, ChatSidebar, MobileBar, panelOf, TopBar, usePanelAtEnd } from "../shell";
import { ClockProvider, LevelProvider, useSampled, type LevelFn } from "./clock";
import { VoiceLab } from "./lab";
import { VoicePeek, type PeekPhase } from "./peek";
import { LOUD_AT, smoothed, type Talker } from "./signal";
import { PLAYS, STATES, type Play, type VoiceState } from "./states";
import { AlevrTranscript, MemberTranscript, wordCount, YOU_1, YOU_CUT, ALEVR_1, MEMBER_YOU, MEMBER_SAYS, type AlevrSnap, type MemberSnap } from "./transcript";
import { VoiceComposer, type ComposerMode, type ErrorKind } from "./voice-composer";
import type { StringPhase } from "./voice-string";

/*
 * Alevr voice and dictation: every state a URL, every still a frozen moment
 * of a deterministic scene, every clip a script on the same clock (see
 * page.dev.tsx for the parameters).
 */

/** The moment each state's still is frozen at (scene ms). */
const STILL_AT: Partial<Record<VoiceState, number>> = {
  "dictation-listening": LOUD_AT.you,
  "dictation-interim": LOUD_AT.you,
  "voice-connecting": 900,
  "voice-listening": LOUD_AT.you,
  // Mid-pass: the handoff has carried your tone to the middle of the row (it starts at 0 and crosses in about 1.35 s).
  "voice-thinking": 820,
  "voice-answering": LOUD_AT.alevr,
  "voice-interrupted": 3890,
  "voice-tool-approval": 1200,
  "voice-error": 1200,
  "orbit-voice": LOUD_AT.member,
  "crew-voice": LOUD_AT.member,
  "voice-lab": 3920,
};
/** When the interrupting voice starts in the voice-interrupted state (the still sits 90 ms after it, mid-handover). */
const CUT_AT = 3800;
/** Thinking in the state URL: the start, then the first tool step at 900 ms (a re-pass coalesced to 1.6 s). */
const THINK_BEATS = [0, 900];
/** Reconnecting: real attempts at 0, 2 s and 5 s (each one reaches once). */
const RECONNECT_BEATS = [0, 2000, 5000];

const DICTATED = "Draft a short note to Kari at Halvorsen asking whether they want to move back to the annual plan before the renewal";
const DICT_WORDS = DICTATED.split(/(?<=\s)/);

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** A word count revealed between two times. */
const reveal = (t: number, from: number, to: number, n: number) => Math.round(clamp01((t - from) / (to - from)) * n);

/* —————————————————————————— Levels for each scene —————————————————————————— */

/** A voice whose first phrase begins at `at` (the synthetic signal shifted to a phrase start), silent before. */
function voiceFrom(at: number, who: Talker, until = Infinity): (t: number) => number {
  const phraseStart = { you: 2600, alevr: 2200, member: 1200 }[who];
  return (t) => (t < at || t > until ? 0 : smoothed(t - at + phraseStart, who));
}

function playLevel(play: Play): LevelFn {
  switch (play) {
    case "voice": {
      const you = voiceFrom(1600, "you", 4300);
      const alevr = voiceFrom(6300, "alevr", 12000);
      return (t, who) => (who === "you" ? you(t) : who === "alevr" ? alevr(t) : 0);
    }
    case "interrupt": {
      const alevr = voiceFrom(0, "alevr", 2400);
      const you = voiceFrom(2200, "you", 4600);
      return (t, who) => (who === "you" ? you(t) : who === "alevr" ? alevr(t) : 0);
    }
    case "mute": {
      const a = voiceFrom(300, "you", 2800);
      const b = voiceFrom(5700, "you");
      return (t, who) => (who === "you" ? Math.max(a(t), b(t)) : 0);
    }
    case "dictation": {
      const you = voiceFrom(900, "you", 6700);
      return (t, who) => (who === "you" ? you(t) : 0);
    }
    case "approval": {
      const you = voiceFrom(1800, "you", 3200);
      return (t, who) => (who === "you" ? you(t) : 0);
    }
    case "reconnect":
      return () => 0;
    case "orbit":
    case "crew": {
      const you = voiceFrom(300, "you", 2800);
      const member = voiceFrom(4400, "member");
      return (t, who) => (who === "you" ? you(t) : who === "member" ? member(t) : 0);
    }
  }
}

/* —————————————————————————— What a scene shows at time t —————————————————————————— */

interface Shot {
  composer: ComposerMode;
  alevr?: AlevrSnap;
  member?: MemberSnap;
  peek?: { phase: PeekPhase; since: number };
}

const DONE = { heard: 99, settled: 99 };

function stateShot(state: VoiceState, kind?: string, orbitPhase?: string): Shot {
  switch (state) {
    case "dictation-idle":
      return { composer: { kind: "text", tip: true }, alevr: { begun: false } };
    case "dictation-permission":
      return { composer: { kind: "dictation", phase: "permission" }, alevr: { begun: false } };
    case "dictation-listening":
      return { composer: { kind: "dictation", phase: "listening" }, alevr: { begun: false } };
    case "dictation-interim":
      return { composer: { kind: "dictation", phase: "interim", final: DICT_WORDS.slice(0, 13).join(""), interim: DICT_WORDS.slice(13, 16).join("") }, alevr: { begun: false } };
    case "dictation-done":
      return { composer: { kind: "dictation", phase: "done", final: DICTATED }, alevr: { begun: false } };
    case "dictation-error": {
      const k = (kind === "silence" || kind === "network" ? kind : "blocked") as ErrorKind;
      const kept = k === "network" ? DICT_WORDS.slice(0, 9).join("") : undefined;
      return { composer: { kind: "dictation", phase: "error", error: k, final: kept }, alevr: { begun: false } };
    }
    case "voice-connecting":
      return { composer: { kind: "voice", phase: "connecting", since: 0 }, alevr: { begun: false } };
    case "voice-listening":
      return { composer: { kind: "voice", phase: "listening", since: 0 }, alevr: { begun: true, you1: { heard: 9, settled: 7 } } };
    case "voice-thinking":
      return { composer: { kind: "voice", phase: "thinking", since: 0, beats: THINK_BEATS }, alevr: { begun: true, you1: DONE, live: "Reading Q3 Forecast.xlsx", beats: THINK_BEATS } };
    case "voice-answering":
      return { composer: { kind: "voice", phase: "answering", since: 0 }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 21 } } };
    case "voice-muted":
      // Muted to type: the call stays open, the words go in by hand ("Add to the conversation").
      return { composer: { kind: "voice", phase: "muted", since: 0, typed: "Use the annual plan figures, not the monthly ones" }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 } } };
    case "voice-interrupted":
      return {
        composer: { kind: "voice", phase: "interrupted", since: CUT_AT },
        alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 14, cut: true }, youCut: { heard: 3, settled: 1 } },
      };
    case "voice-tool-approval":
      return { composer: { kind: "voice", phase: "approval", since: 0 }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 }, you2: true, alevr2: true, approval: true } };
    case "voice-error":
      if (kind === "reconnecting")
        return { composer: { kind: "voice", phase: "reconnecting", since: 0, beats: RECONNECT_BEATS }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 } } };
      return { composer: { kind: "voice", phase: "error", since: 0, error: "voice-lost" }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 } } };
    case "voice-ended":
      return { composer: { kind: "text" }, alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 }, ended: "Voice conversation ended, 2 min 41 s" } };
    case "orbit-voice":
    case "crew-voice": {
      const p = orbitPhase === "listening" || orbitPhase === "thinking" ? orbitPhase : "answering";
      if (p === "listening")
        return { composer: { kind: "voice", phase: "listening", since: 0, answerer: "member" }, member: { you: { heard: 4, settled: 3 } }, peek: { phase: "listening", since: 0 } };
      if (p === "thinking")
        return {
          composer: { kind: "voice", phase: "thinking", since: 0, answerer: "member", beats: THINK_BEATS },
          member: { you: DONE, live: "Reading 90 days of seat usage" },
          peek: { phase: "thinking", since: 0 },
        };
      return { composer: { kind: "voice", phase: "answering", since: 0, answerer: "member" }, member: { you: DONE, says: 17 }, peek: { phase: "answering", since: 0 } };
    }
    default:
      return { composer: { kind: "text" } };
  }
}

function playShot(play: Play, t: number): Shot {
  const v = (phase: StringPhase, since: number, extra?: Partial<Extract<ComposerMode, { kind: "voice" }>>): ComposerMode => ({ kind: "voice", phase, since, ...extra });
  const you1 = (from: number, to: number, settleBy: number) => {
    const n = wordCount(YOU_1);
    const heard = reveal(t, from, to, n);
    return { heard, settled: t >= settleBy ? n : Math.max(0, heard - 2) };
  };
  switch (play) {
    case "voice": {
      if (t < 600) return { composer: { kind: "text" }, alevr: { begun: false } };
      if (t < 1400) return { composer: v("connecting", 600), alevr: { begun: false } };
      if (t < 4400) return { composer: v("listening", 1400), alevr: { begun: true, you1: you1(1750, 4100, 4400) } };
      if (t < 6300) {
        const beats = [4400, 4600, 5400];
        const live = t < 4600 ? null : t < 5400 ? "Reading Q3 Forecast.xlsx" : "Checking the Stripe renewals";
        return { composer: v("thinking", 4400, { beats }), alevr: { begun: true, you1: DONE, live, beats } };
      }
      const shown = reveal(t, 6400, 12000, Math.round(((12000 - 6400) / 1000) * 3.1));
      const base: AlevrSnap = { begun: true, you1: DONE, trace1: true, alevr1: { shown } };
      if (t < 12000) return { composer: v("answering", 6300), alevr: base };
      if (t < 12500) return { composer: v("ended", 12000), alevr: base };
      return { composer: { kind: "text" }, alevr: { ...base, ended: "Voice conversation ended, 0 min 12 s" } };
    }
    case "interrupt": {
      const n = wordCount(ALEVR_1);
      const spoken = Math.min(n, 6 + reveal(t, 0, 2200, 7));
      const cutWords = YOU_CUT.split(/(?<=\s)/).length;
      if (t < 2200) return { composer: v("answering", 0), alevr: { begun: true, you1: DONE, trace1: true, alevr1: { shown: spoken } } };
      const heard = reveal(t, 2400, 4300, cutWords);
      const snap: AlevrSnap = { begun: true, you1: DONE, trace1: true, alevr1: { shown: 13, cut: t >= 2500 }, youCut: { heard, settled: t >= 4700 ? cutWords : Math.max(0, heard - 2) } };
      if (t < 4700) return { composer: v("interrupted", 2200), alevr: snap };
      const beats = [4700, 4900];
      return { composer: v("thinking", 4700, { beats }), alevr: { ...snap, live: t >= 4900 ? "Checking Stripe customers named Halvorsen" : null, beats } };
    }
    case "mute": {
      const snap: AlevrSnap = { begun: true, you1: you1(450, 2600, 2900) };
      if (t < 3000) return { composer: v("listening", 0), alevr: snap };
      if (t < 5200) return { composer: v("muted", 3000), alevr: snap };
      return { composer: v("listening", 5200), alevr: snap };
    }
    case "approval": {
      // Alevr asks; the card arrives; you say "yes, send it" and nothing is approved: the card waits for a click.
      const base: AlevrSnap = { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 }, you2: true, alevr2: true };
      if (t < 700) return { composer: v("answering", 0), alevr: base };
      return { composer: v("approval", 700), alevr: { ...base, approval: true, saidYes: t >= 1800 ? { heard: reveal(t, 1900, 3000, 4), settled: t >= 3300 ? 4 : reveal(t, 1900, 3000, 4) - 1 } : undefined } };
    }
    case "reconnect": {
      const base: AlevrSnap = { begun: true, you1: DONE, trace1: true, alevr1: { shown: 99 } };
      if (t < 800) return { composer: v("listening", 0), alevr: base };
      if (t < 6600) return { composer: v("reconnecting", 800, { beats: [800, 2800, 5800] }), alevr: base };
      return { composer: v("listening", 6600), alevr: base };
    }
    case "dictation": {
      if (t < 700) return { composer: { kind: "text", focused: true }, alevr: { begun: false } };
      const n = DICT_WORDS.length;
      const heard = Math.min(n, reveal(t, 1000, 3300, 10) + reveal(t, 4300, 6500, n - 10));
      if (t < 6800) {
        const fin = Math.max(0, heard - 3);
        return { composer: { kind: "dictation", phase: heard ? "interim" : "listening", final: DICT_WORDS.slice(0, fin).join(""), interim: DICT_WORDS.slice(fin, heard).join("") }, alevr: { begun: false } };
      }
      if (t < 7250) return { composer: { kind: "dictation", phase: "finalizing", final: DICT_WORDS.slice(0, n - 3).join(""), interim: DICT_WORDS.slice(n - 3).join("") }, alevr: { begun: false } };
      return { composer: { kind: "dictation", phase: "done", final: DICTATED }, alevr: { begun: false } };
    }
    case "orbit":
    case "crew": {
      const youN = wordCount(MEMBER_YOU);
      const heard = reveal(t, 450, 2500, youN);
      if (t < 2900) return { composer: v("listening", 0, { answerer: "member" }), member: { you: { heard, settled: Math.max(0, heard - 2) } }, peek: { phase: "listening", since: 0 } };
      if (t < 4400) {
        const beats = [2900, 3300];
        return { composer: v("thinking", 2900, { answerer: "member", beats }), member: { you: DONE, live: t >= 3300 ? "Reading 90 days of seat usage" : undefined }, peek: { phase: "thinking", since: 2900 } };
      }
      return {
        composer: v("answering", 4400, { answerer: "member" }),
        member: { you: DONE, says: reveal(t, 4500, 9500, Math.round(wordCount(MEMBER_SAYS) * 0.62)) },
        peek: { phase: "answering", since: 4400 },
      };
    }
  }
}

/* —————————————————————————— Frames —————————————————————————— */

/** Following the call (M17): while the transcript grows, the newest turn stays in view, in the same frame (no smooth scroll per word). */
function useFollow(shot: Shot) {
  React.useLayoutEffect(() => {
    const p = panelOf();
    if (p) p.scrollTop = p.scrollHeight;
  }, [shot]);
}

function AlevrFrame({ shot }: { shot: Shot }) {
  usePanelAtEnd(true);
  useFollow(shot);
  const permission = shot.composer.kind === "dictation" && shot.composer.phase === "permission";
  return (
    <AppFrame sidebar={<ChatSidebar current="thread" />}>
      <div className="jn-chat jv-chat">
        <MobileBar title={THREAD_TITLE} />
        <TopBar title={THREAD_TITLE} />
        <AlevrTranscript snap={shot.alevr ?? { begun: false }} />
        <div className="jn-dock jv-dock">
          <VoiceComposer mode={shot.composer} />
          <p className="jn-dock__note">{permission ? "Allow the microphone when your browser asks. Alevr listens only while the mic is on." : "Alevr can make mistakes. Check what matters."}</p>
        </div>
      </div>
      {permission ? <BrowserPrompt /> : null}
    </AppFrame>
  );
}

/** The browser's own permission prompt, drawn neutrally for the flow (Alevr never draws its own). */
function BrowserPrompt() {
  return (
    <div className="jv-browser" role="dialog" aria-label="Browser permission prompt (the browser’s, not Alevr’s)">
      <p className="jv-browser__head">
        <Icon name="mic" size={16} />
        <span>
          <b>alevr.app</b> wants to use your microphone
        </span>
      </p>
      <div className="jv-browser__verbs">
        <span className="jv-browser__btn">Block</span>
        <span className="jv-browser__btn jv-browser__btn--main">Allow</span>
      </div>
    </div>
  );
}

const MIRA_ROW = CREW.find((c) => c.id === "mira") ?? CREW[0];

function OrbitFrame({ shot }: { shot: Shot }) {
  usePanelAtEnd(true);
  useFollow(shot);
  const member = crewMember(MIRA_ROW);
  const theme = useMemberTheme(member);
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" crewCurrent={member.id} />}>
      <div className="jn-chat jn-mthread jv-chat" style={theme.style} data-member-theme={theme.family}>
        <MobileBar title={member.name} back />
        <header className="jn-mhead">
          <div className="jn-mhead__bar">
            <button type="button" className="jib jicon-trigger jn-mhead__back" aria-label="Back">
              <Icon name="chevron-left" size={20} />
            </button>
            <span className="jn-mhead__actions">
              <button type="button" className="jib jicon-trigger" aria-label="More">
                <Icon name="more" size={20} />
              </button>
            </span>
          </div>
          <div className="jn-mhead__peek">
            <VoicePeek member={member} phase={shot.peek?.phase ?? "other"} since={shot.peek?.since} />
          </div>
        </header>
        <MemberTranscript member={member} snap={shot.member ?? {}} />
        <div className="jn-dock jv-dock">
          <VoiceComposer mode={shot.composer} placeholder={`Message ${member.name}…`} label={`Message ${member.name}`} who={member.name} />
        </div>
      </div>
    </AppFrame>
  );
}

function Scene({ state, play, kind, orbitPhase }: { state: VoiceState; play?: Play; kind?: string; orbitPhase?: string }) {
  const shotAt = useSampled((t) => (play ? playShot(play, t) : stateShot(state, kind, orbitPhase)), 50, [state, play, kind, orbitPhase]);
  const orbit = play ? play === "orbit" || play === "crew" : state === "orbit-voice" || state === "crew-voice";
  return orbit ? <OrbitFrame shot={shotAt} /> : <AlevrFrame shot={shotAt} />;
}

/* —————————————————————————— The stage —————————————————————————— */

export function VoiceStage({
  state,
  theme,
  reduced,
  freeze,
  play,
  kind,
  orbitPhase,
  fontClass,
}: {
  state?: VoiceState;
  theme?: "light" | "dark";
  reduced: boolean;
  freeze?: string;
  play?: Play;
  kind?: string;
  orbitPhase?: string;
  fontClass: string;
}) {
  const s = state ?? (play ? (play === "orbit" || play === "crew" ? "orbit-voice" : play === "dictation" ? "dictation-listening" : "voice-listening") : undefined);
  const stillAt = s ? (STILL_AT[s] ?? 0) : 0;
  const freezeAt = freeze === undefined ? undefined : freeze === "1" || freeze === "" ? stillAt : Number(freeze);
  const fromZero = s === "voice-connecting" || s === "voice-thinking" || s === "voice-tool-approval" || s === "voice-error" || ((s === "orbit-voice" || s === "crew-voice") && orbitPhase === "thinking");
  const start = play || fromZero ? 0 : Math.max(0, stillAt - 400);
  const level = React.useMemo<LevelFn>(() => {
    if (play) return playLevel(play);
    if (s === "voice-interrupted") {
      const you = voiceFrom(CUT_AT, "you");
      return (t, who) => (who === "you" ? (t < CUT_AT ? 0 : Math.max(you(t), smoothed(t, "you"))) : smoothed(t, who));
    }
    // Nobody is speaking in these: the signature is judged on its own form and motion.
    if (s === "voice-thinking" || s === "voice-tool-approval" || s === "voice-error" || s === "voice-connecting") return () => 0;
    if ((s === "orbit-voice" || s === "crew-voice") && orbitPhase === "thinking") return () => 0;
    return smoothed;
  }, [play, s, orbitPhase]);

  return (
    <div className={`jn ${fontClass} jv`} data-theme={theme} data-rm={reduced ? "" : undefined} data-still={freezeAt !== undefined ? "" : undefined} data-voice-state={s}>
      <MotionPref reduced={reduced}>
        <ClockProvider freezeAt={freezeAt} start={start} reduced={reduced}>
          <LevelProvider level={level}>
            {!s ? <VoiceIndex /> : s === "voice-lab" ? <VoiceLab theme={theme} /> : <Scene state={s} play={play} kind={kind} orbitPhase={orbitPhase} />}
          </LevelProvider>
        </ClockProvider>
      </MotionPref>
    </div>
  );
}

function VoiceIndex() {
  return (
    <main className="jn-index">
      <h1 className="t-title">Alevr voice and dictation</h1>
      <p className="jn-index__lede">The composer, speaking. Every state is a URL; add &amp;theme=dark, &amp;rm=1 for reduced motion, &amp;freeze=1 for the still.</p>
      <nav className="jn-index__list">
        {STATES.filter((st) => st !== "crew-voice").map((st) => (
          <div key={st} className="jn-index__row">
            <Link className="jn-index__main" href={`/dev/design/juno/voice?state=${st}`}>
              {st}
            </Link>
            <span className="jn-index__links">
              <Link href={`/dev/design/juno/voice?state=${st}&theme=light`}>light</Link>
              <Link href={`/dev/design/juno/voice?state=${st}&theme=dark`}>dark</Link>
              <Link href={`/dev/design/juno/voice?state=${st}&rm=1`}>reduced</Link>
            </span>
          </div>
        ))}
        {PLAYS.filter((p) => p !== "crew").map((p) => (
          <div key={p} className="jn-index__row">
            <Link className="jn-index__main" href={`/dev/design/juno/voice?play=${p}`}>
              play={p}
            </Link>
            <span className="jn-index__links">
              <Link href={`/dev/design/juno/voice?play=${p}&theme=dark`}>dark</Link>
              <Link href={`/dev/design/juno/voice?play=${p}&rm=1`}>reduced</Link>
            </span>
          </div>
        ))}
      </nav>
    </main>
  );
}
