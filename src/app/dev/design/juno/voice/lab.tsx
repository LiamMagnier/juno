"use client";

import * as React from "react";
import { Icon } from "../icons";
import { useClock, useLevel, useTick } from "./clock";
import type { Talker } from "./signal";
import { VoiceString, type StringPhase } from "./voice-string";

/*
 * The signature lab: three ways for the composer to carry a voice, each in
 * the same composer, on the same audio, in the four states that matter most
 * (you speaking, Juno thinking, Juno speaking, muted). The verdict under each
 * column is the critique that picked the string; the clips in
 * scratchpad/design-v3/voice/motion show them moving.
 *
 *   A · The string   one hairline across the voice row, fixed at both ends
 *   B · The field    a comb of hairlines in the same slot, heights following the voice
 *   C · The edge     the composer's own bottom hairline displaced by the voice
 */

type LabPhase = Extract<StringPhase, "listening" | "thinking" | "answering" | "muted">;

/** The lab's still is frozen at 3920 ms (both voices loud); thinking starts 575 ms before, so its crest is mid-row. */
const THINK_SINCE = 3920 - 575;
const ROWS: { phase: LabPhase; label: string; sub: string }[] = [
  { phase: "listening", label: "You speaking", sub: "ember, toward Juno" },
  { phase: "thinking", label: "Juno thinking", sub: "your words carried across" },
  { phase: "answering", label: "Juno speaking", sub: "ultramarine, toward you" },
  { phase: "muted", label: "Muted", sub: "grey, still" },
];

const OPTIONS = [
  {
    id: "string",
    name: "A · The string",
    line: "One 1.5 px hairline strung across the voice row, fixed at both ends.",
    verdict:
      "Chosen. The system’s own material (the hairline) doing the one thing it never does elsewhere: move. Silence is a straight still line, so motion is always sound. Direction says who is talking to whom; the form says the rest (dashed, broken, a single crest). It owns the empty middle of the row, costs no height, and reads at 390 px.",
    chosen: true,
  },
  {
    id: "field",
    name: "B · The field",
    line: "A comb of hairlines in the same slot, heights following the voice.",
    verdict:
      "Rejected. Reads at once as audio, but as every recorder’s visualiser: Voice Memos, WhatsApp, the stock waveform. Forty bars are a meter, which the owner ruled out, and they repeat the disc’s five-bar glyph at a larger, louder scale. At rest it is a row of dots.",
    chosen: false,
  },
  {
    id: "edge",
    name: "C · The edge",
    line: "The composer’s own bottom hairline, displaced by the voice.",
    verdict:
      "Rejected. The purest idea (the composer is the voice) and the worst in use: a wobbling outline reads as a rendering fault on the one object D-030 defines by a crisp edge; the signal sits at the bottom, away from the eye and on the keyboard’s edge on a phone; and its thinking crest is the border beam the owner removed.",
    chosen: false,
  },
] as const;

export function VoiceLab() {
  return (
    <main className="jv-lab">
      <header className="jv-lab__head">
        <h1 className="t-display">The voice signature</h1>
        <p className="ink-2">Three signatures in the same composer, on the same synthetic voice. Tone, form and motion each have to tell the states apart on their own.</p>
      </header>
      <div className="jv-lab__grid" role="table" aria-label="Signature options by state">
        <div className="jv-lab__corner" role="columnheader" />
        {OPTIONS.map((o) => (
          <div key={o.id} className="jv-lab__col" role="columnheader" data-chosen={o.chosen ? "" : undefined}>
            <span className="jv-lab__name">{o.name}</span>
            <span className="jv-lab__line">{o.line}</span>
          </div>
        ))}
        {ROWS.map((r) => (
          <React.Fragment key={r.phase}>
            <div className="jv-lab__rowhead" role="rowheader">
              <span>{r.label}</span>
              <span className="ink-3">{r.sub}</span>
            </div>
            {OPTIONS.map((o) => (
              <div key={o.id} className="jv-lab__cell" role="cell">
                <LabComposer option={o.id} phase={r.phase} />
              </div>
            ))}
          </React.Fragment>
        ))}
        <div className="jv-lab__rowhead" role="rowheader">
          <span>Verdict</span>
        </div>
        {OPTIONS.map((o) => (
          <p key={o.id} className="jv-lab__verdict" data-chosen={o.chosen ? "" : undefined} role="cell">
            {o.verdict}
          </p>
        ))}
      </div>
    </main>
  );
}

function LabComposer({ option, phase }: { option: "string" | "field" | "edge"; phase: LabPhase }) {
  const muted = phase === "muted";
  return (
    <div className="jn-composer jv-composer jv-labcomp" data-variant="dock" data-edge={option === "edge" ? "" : undefined} data-voice={phase}>
      {option === "edge" ? <EdgeSignature phase={phase} /> : null}
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
              <VoiceString phase={phase} since={phase === "thinking" ? THINK_SINCE : 0} />
            </span>
          ) : option === "field" ? (
            <FieldSignature phase={phase} />
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
        <span className="jn-disc" data-mode="send" aria-hidden="true">
          <span className="jn-disc__glyph">
            <Icon name="close" size={20} />
          </span>
        </span>
      </div>
    </div>
  );
}

/* —————————————————————————— B · The field —————————————————————————— */

function FieldSignature({ phase }: { phase: LabPhase }) {
  const ref = React.useRef<SVGPathElement | null>(null);
  const svg = React.useRef<SVGSVGElement | null>(null);
  const level = useLevel();
  const clock = useClock();
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useTick(
    (t) => {
      const p = ref.current;
      if (!p || !w) return;
      const H = 34;
      const y0 = H / 2;
      const pitch = 6;
      const n = Math.floor((w - 4) / pitch);
      const who: Talker = phase === "answering" ? "juno" : "you";
      const lv = phase === "muted" || phase === "thinking" ? 0 : level(t, who);
      const dir = phase === "answering" ? -1 : 1;
      let d = "";
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const x = 2 + i * pitch;
        const env = Math.pow(Math.sin(Math.PI * u), 0.8);
        let h = 3;
        if (lv > 0) h += 22 * lv * env * (0.55 + 0.45 * Math.sin(2 * Math.PI * (u * 3.1 - dir * (t / 1000) * 1.1)) * (clock.reduced ? 0 : 1));
        if (phase === "thinking" && !clock.reduced) {
          const c = ((((t - THINK_SINCE) % 1500) / 1150) * (w + 60)) - 30;
          h += 7 * Math.exp(-(((x - c) / 22) ** 2));
        }
        d += `M${x} ${(y0 - h / 2).toFixed(2)}L${x} ${(y0 + h / 2).toFixed(2)}`;
      }
      p.setAttribute("d", d);
    },
    [phase, w, level],
  );
  return (
    <svg ref={svg} className="jv-field-sig" data-tone={phase === "listening" ? "you" : phase === "answering" ? "juno" : phase === "thinking" ? "mix" : "quiet"} height={34} aria-hidden="true">
      <path ref={ref} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

/* —————————————————————————— C · The edge —————————————————————————— */

function EdgeSignature({ phase }: { phase: LabPhase }) {
  const box = React.useRef<SVGSVGElement | null>(null);
  const edge = React.useRef<SVGPathElement | null>(null);
  const outline = React.useRef<SVGPathElement | null>(null);
  const level = useLevel();
  const clock = useClock();
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useTick(
    (t) => {
      const { w, h } = size;
      if (!w || !edge.current || !outline.current) return;
      const r = 22;
      const y = h - 0.5;
      outline.current.setAttribute(
        "d",
        `M${r} ${y}A${r} ${r} 0 0 1 0.5 ${h - r}L0.5 ${r}A${r} ${r} 0 0 1 ${r} 0.5L${w - r} 0.5A${r} ${r} 0 0 1 ${w - 0.5} ${r}L${w - 0.5} ${h - r}A${r} ${r} 0 0 1 ${w - r} ${y}`,
      );
      const who: Talker = phase === "answering" ? "juno" : "you";
      const lv = phase === "muted" || phase === "thinking" ? 0 : level(t, who);
      const dir = phase === "answering" ? -1 : 1;
      const L = w - 2 * r;
      let d = "";
      for (let i = 0; i <= 90; i++) {
        const u = i / 90;
        const x = r + u * L;
        let dy = 0;
        if (lv > 0) dy = clock.reduced ? 5 * lv * Math.sin(Math.PI * u) : 6 * lv * Math.pow(Math.sin(Math.PI * u), 1.5) * Math.abs(Math.sin(2 * Math.PI * (u * 2.2 - dir * (t / 1000) * 0.9)));
        if (phase === "thinking" && !clock.reduced) {
          const c = (((t - THINK_SINCE) % 1500) / 1150) * (L + 80) - 40;
          dy += 3 * Math.exp(-(((u * L - c) / 24) ** 2));
        }
        d += `${i ? "L" : "M"}${x.toFixed(2)} ${(y + dy).toFixed(2)}`;
      }
      edge.current.setAttribute("d", d);
    },
    [phase, size, level],
  );
  return (
    <svg ref={box} className="jv-edge-sig" width={size.w} height={size.h + 10} aria-hidden="true">
      <path ref={outline} fill="none" stroke="var(--line-2)" strokeWidth={1} />
      <path
        ref={edge}
        className="jv-edge-sig__line"
        data-tone={phase === "listening" ? "you" : phase === "answering" ? "juno" : phase === "thinking" ? "mix" : "quiet"}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
