"use client";

import * as React from "react";
import { VoiceBeam } from "voice-glow";
import { junoVoicePalette } from "@/components/effects/use-effect-theme";
import { Icon } from "../icons";
import { VoiceChannel } from "./channel";
import { CONTINUUM_BLADES, passStarts, segmentTint, PASS } from "./continuum";
import { useClock, useLevel, useTick } from "./clock";
import type { Talker } from "./signal";
import { VoiceString, type StringPhase } from "./voice-string";

/*
 * The Alevr voice signature lab: four candidates and two references, each in
 * the same composer, on the same synthetic voice, in the four states that
 * matter most (you speaking, Alevr thinking, Alevr speaking, muted). Tone,
 * form and motion each have to tell the states apart on their own. The
 * verdict beside each row is the critique that picked the channel; the clips
 * (design-v3/voice/motion/voice-lab*.webm) show them moving.
 *
 *   A · The string    round 3's pick: one hairline across the row (Juno era)
 *   B · The channel   Continuum: two paths, yours and Alevr's, passing across an open channel  ← chosen
 *   C · The mark      Continuum: the mark itself carries the voice
 *   D · The trace     Continuum: one blade whose weight is the envelope's recent history
 *   Today · The glow  production 1.8.1 (libraries.dev voice-glow, retuned), the real component
 *   Reference · The orb   the pattern ChatGPT made the default, drawn generically
 */

type LabPhase = Extract<StringPhase, "listening" | "thinking" | "answering" | "muted">;
type Option = "string" | "channel" | "mark" | "trace" | "glow" | "orb";

/** The lab's still is frozen at 3920 ms (both voices mid-phrase). Thinking passes start so each is mid-pass at the still. */
const STILL = 3920;
const THINK_SINCE_STRING = STILL - 575;
const THINK_SINCE = STILL - 820;

const COLS: { phase: LabPhase; label: string }[] = [
  { phase: "listening", label: "You speaking" },
  { phase: "thinking", label: "Alevr thinking" },
  { phase: "answering", label: "Alevr speaking" },
  { phase: "muted", label: "Muted" },
];

const OPTIONS: { id: Option; tag: string; name: string; line: string; verdict: string; chosen?: boolean; reference?: boolean }[] = [
  {
    id: "channel",
    tag: "B",
    name: "The channel",
    line: "Continuum. Two paths, yours and Alevr’s, broad at their anchors and pointed where they pass across an open channel.",
    verdict:
      "Chosen. The brand’s own geometry doing the one job: who speaks is which path moves, in which tone, toward whom, and input and output stay independent, so talking over Alevr is drawn as two voices instead of one blended line. Thinking is the Continuum’s tonal handoff carried from your anchor to Alevr’s, settling where the paths pass; it re-passes only on real steps. Its forms say connected (the ends pass), muted (yours withdraws) and held (both draw back) with no word on screen. Silence is still. Costs: two objects, and a 4 px channel to check on 1x screens.",
    chosen: true,
  },
  {
    id: "string",
    tag: "A",
    name: "The string",
    line: "Round 3’s pick. One 1.5 px hairline across the row, fixed at both ends; direction says who.",
    verdict:
      "Superseded. Still calm and honest, but not Alevr’s: one sine line across a bar is the 2013 Siri waveform, it borrows nothing from the Continuum, and a single line can only blend two voices when you talk over Alevr. Its thinking crest is a generic travelling highlight, not the brand’s handoff.",
  },
  {
    id: "mark",
    tag: "C",
    name: "The mark",
    line: "Continuum. The 22 px mark carries the voice: its blades take the speaker’s tone with the level, one blade per syllable.",
    verdict:
      "Rejected. A logo flickering on every syllable is the decorative logo loop the brand forbids; 22 px cannot show an envelope, so it reads as a pulsing badge, one step from the orb; and it spends the ThinkingMark’s meaning on speech, so thinking and speaking become the same object.",
  },
  {
    id: "trace",
    tag: "D",
    name: "The trace",
    line: "Continuum. One blade whose weight along its length is the last two seconds of the speaker’s envelope.",
    verdict:
      "Rejected. The most literal ‘actual audio envelope’, and that is the problem: a scrolling envelope is a voice-memo waveform with a pointed end. It shows what was said, not who has the floor, and swells to 9 px on a loud word: a meter in all but name.",
  },
  {
    id: "glow",
    tag: "Today",
    name: "The glow",
    line: "Production 1.8.1: libraries.dev voice-glow, retuned warm/cool. The real component on the same voice.",
    verdict:
      "Replace. Honest about state, but a stock effect (the package’s chat-input demo, recoloured): a coloured haze over the one object the system defines by a crisp edge, breathing while nobody speaks (its idle), with no shape the brand owns. Put another product’s name above it and it is theirs.",
    reference: true,
  },
  {
    id: "orb",
    tag: "Reference",
    name: "The orb",
    line: "The pattern ChatGPT made the default, drawn generically: a soft sphere that swells with the voice.",
    verdict:
      "Ruled out by the owner, and for cause: presence without information. It cannot say whose voice it is or show two at once, it glows, and it usually lives in its own screen, apart from the conversation and the composer.",
    reference: true,
  },
];

export function VoiceLab({ theme }: { theme?: "light" | "dark" }) {
  const resolved = useResolvedTheme(theme);
  return (
    <main className="jv-lab">
      <header className="jv-lab__head">
        <h1 className="t-display">The Alevr voice signature</h1>
        <p className="ink-2">
          Four candidates (three drawn from the Continuum) and two references, each in the same composer on the same synthetic voice. Tone, form and motion each have to tell the states apart; the live
          region says them in words.
        </p>
      </header>
      <div className="jv-lab__rows">
        {OPTIONS.map((o) => (
          <section key={o.id} className="jv-lab__row" data-chosen={o.chosen ? "" : undefined} data-reference={o.reference ? "" : undefined} aria-label={`${o.tag} · ${o.name}`}>
            <div className="jv-lab__about">
              <p className="jv-lab__name">
                <span className="jv-lab__tag">{o.tag}</span> {o.name}
              </p>
              <p className="jv-lab__line">{o.line}</p>
              <p className="jv-lab__verdict">{o.verdict}</p>
            </div>
            <div className="jv-lab__cells">
              {COLS.map((c) => (
                <div key={c.phase} className="jv-lab__cell">
                  <span className="jv-lab__cellhead">{c.label}</span>
                  <LabComposer option={o.id} phase={c.phase} theme={resolved} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function useResolvedTheme(theme?: "light" | "dark"): "light" | "dark" {
  const [os, setOs] = React.useState<"light" | "dark">("light");
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setOs(mq.matches ? "dark" : "light");
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme ?? os;
}

function LabComposer({ option, phase, theme }: { option: Option; phase: LabPhase; theme: "light" | "dark" }) {
  const muted = phase === "muted";
  const inner = (
    <div className="jn-composer jv-composer jv-labcomp" data-variant="dock" data-voice={phase} data-glow={option === "glow" ? "" : undefined}>
      <div className="jn-field jv-field">
        <div className="jn-field__placeholder">Add to the conversation</div>
      </div>
      <div className="jn-crow jv-row">
        <span className="jib jn-crow__add" aria-hidden="true">
          <Icon name="plus" size={20} />
        </span>
        <span className="jn-crow__spacer jv-mid">
          {option === "string" ? (
            <span className="jv-mid__string">
              <VoiceString phase={phase} since={phase === "thinking" ? THINK_SINCE_STRING : 0} />
            </span>
          ) : option === "channel" ? (
            <span className="jv-mid__string">
              <VoiceChannel phase={phase} since={phase === "thinking" ? THINK_SINCE : 0} beats={phase === "thinking" ? [THINK_SINCE] : undefined} />
            </span>
          ) : option === "mark" ? (
            <MarkSignature phase={phase} />
          ) : option === "trace" ? (
            <TraceSignature phase={phase} />
          ) : option === "orb" ? (
            <OrbSignature phase={phase} />
          ) : null}
        </span>
        <span className="jv-controls">
          <span className="jib" aria-hidden="true" data-pressed={muted ? "" : undefined}>
            <Icon name={muted ? "mic-off" : "mic"} size={20} />
          </span>
          <span className="jib" aria-hidden="true">
            <Icon name="read-aloud" size={20} />
          </span>
        </span>
        <span className="jn-disc" data-mode="send" data-end="" aria-hidden="true">
          <span className="jn-disc__glyph">
            <Icon name="close" size={20} />
          </span>
        </span>
      </div>
    </div>
  );
  return option === "glow" ? <GlowReference phase={phase} theme={theme}>{inner}</GlowReference> : inner;
}

/* —————————————————————————— Today · the glow (the production component) —————————————————————————— */

function GlowReference({ phase, theme, children }: { phase: LabPhase; theme: "light" | "dark"; children: React.ReactNode }) {
  const clock = useClock();
  const level = useLevel();
  const tone = phase === "listening" ? "you" : phase === "answering" ? "juno" : phase === "thinking" ? "thinking" : "muted";
  const palette = junoVoicePalette(theme, tone);
  const who: Talker = phase === "answering" ? "alevr" : "you";
  const read = React.useCallback(() => (phase === "muted" || phase === "thinking" ? 0 : level(clock.now(), who)), [phase, level, clock, who]);
  return (
    <VoiceBeam
      level={read}
      processing={phase === "thinking"}
      theme={theme}
      colors={palette.colors}
      bandColors={palette.bandColors}
      strength={theme === "dark" ? 0.95 : 0.8}
      attack={0.06}
      release={0.18}
      idle={0.06}
      className="jv-glowref"
    >
      {children}
    </VoiceBeam>
  );
}

/* —————————————————————————— C · The mark —————————————————————————— */

const ORDER = [0, 1, 3, 2];

function MarkSignature({ phase }: { phase: LabPhase }) {
  const level = useLevel();
  const clock = useClock();
  const refs = React.useRef<(SVGPathElement | null)[]>([]);
  const starts = React.useMemo(() => passStarts([THINK_SINCE]), []);
  useTick(
    (t) => {
      const who: Talker = phase === "answering" ? "alevr" : "you";
      const ink = phase === "answering" ? "var(--vs-answer)" : "var(--vs-you)";
      const lv = phase === "listening" || phase === "answering" ? level(t, who) : 0;
      // One blade per syllable (the synthetic voice's rate), lit by the level.
      const lead = Math.floor((t / 1000) * 4.6) % 4;
      ORDER.forEach((blade, i) => {
        const el = refs.current[blade];
        if (!el) return;
        if (phase === "thinking") {
          const k = clock.reduced ? 0 : segmentTint(i, t, starts);
          el.style.fill = `color-mix(in oklab, var(--ink) ${Math.round((1 - k) * 100)}%, var(--presence))`;
          return;
        }
        if (phase === "muted") {
          el.style.fill = "var(--vs-rest)";
          return;
        }
        const k = Math.min(1, lv * 1.6) * (i === lead || clock.reduced ? 1 : 0.35);
        el.style.fill = `color-mix(in oklab, var(--vs-rest) ${Math.round((1 - k) * 100)}%, ${ink})`;
      });
    },
    [phase, level, starts, clock.reduced],
  );
  return (
    <span className="jv-mark-sig">
      <svg viewBox="0 0 100 100" width={24} height={24} aria-hidden="true" data-standin="">
        {CONTINUUM_BLADES.map((d, i) => (
          <path
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            d={d}
          />
        ))}
      </svg>
    </span>
  );
}

/* —————————————————————————— D · The trace —————————————————————————— */

const HISTORY = 2200;

function TraceSignature({ phase }: { phase: LabPhase }) {
  const svg = React.useRef<SVGSVGElement | null>(null);
  const path = React.useRef<SVGPathElement | null>(null);
  const level = useLevel();
  const clock = useClock();
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  const starts = React.useMemo(() => passStarts([THINK_SINCE]), []);
  useTick(
    (t) => {
      const p = path.current;
      if (!p || !w) return;
      const H = 34;
      const y0 = H / 2;
      const who: Talker = phase === "answering" ? "alevr" : "you";
      const live = phase === "listening" || phase === "answering";
      // The head sits at the speaker's anchor: yours by the add button, Alevr's by the disc.
      const dir = phase === "answering" ? -1 : 1;
      const head = dir === 1 ? 4 : w - 4;
      const L = w - 8;
      const N = 90;
      const top: string[] = [];
      const bot: string[] = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const x = head + dir * u * L;
        const lv = live ? level(t - u * HISTORY, who) : 0;
        const half = (0.45 + 4.2 * lv) * Math.pow(1 - u, 0.45);
        top.push(`${x.toFixed(1)} ${(y0 - half).toFixed(2)}`);
        bot.push(`${x.toFixed(1)} ${(y0 + half).toFixed(2)}`);
      }
      p.setAttribute("d", `M${top.join("L")}L${bot.reverse().join("L")}Z`);
      if (phase === "thinking") {
        const k = clock.reduced ? 0.6 : Math.max(...Array.from({ length: 8 }, (_, i) => segmentTint(i, t, starts)));
        const at = clock.reduced ? 0.5 : Math.min(1, Math.max(0, (t - starts[0] - PASS.tone) / (7 * PASS.stagger)));
        p.style.fill = `color-mix(in oklab, var(--vs-rest) ${Math.round((1 - k) * 100)}%, color-mix(in oklab, var(--vs-you) ${Math.round((1 - at) * 100)}%, var(--vs-answer)))`;
      } else p.style.fill = phase === "listening" ? "var(--vs-you)" : phase === "answering" ? "var(--vs-answer)" : "var(--vs-rest)";
    },
    [phase, w, level, starts, clock.reduced],
  );
  return (
    <svg ref={svg} className="jv-trace-sig" height={34} aria-hidden="true">
      <path ref={path} />
    </svg>
  );
}

/* —————————————————————————— Reference · the orb (generic) —————————————————————————— */

function OrbSignature({ phase }: { phase: LabPhase }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const level = useLevel();
  const clock = useClock();
  useTick(
    (t) => {
      const el = ref.current;
      if (!el) return;
      const who: Talker = phase === "answering" ? "alevr" : "you";
      const lv = phase === "listening" || phase === "answering" ? level(t, who) : phase === "thinking" ? 0.25 + 0.15 * Math.sin(t / 260) : 0;
      el.style.transform = clock.reduced ? "none" : `scale(${(1 + lv * 0.35).toFixed(3)})`;
    },
    [phase, level, clock.reduced],
  );
  return (
    <span className="jv-orb-sig">
      <span ref={ref} className="jv-orb" data-phase={phase} />
    </span>
  );
}
