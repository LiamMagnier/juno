"use client";

/**
 * The aura bench.
 *
 * WHY IT EXISTS. The aura is a motion feature whose whole vocabulary is state:
 * ten of them, six accents, two themes and a reduced-motion variant. Reviewing
 * a change to it by starting a real voice call — which is what the alternative
 * is — exercises four of those and costs a microphone permission each time.
 * This page drives the bus directly, so every state is one press away and none
 * of them need a network.
 *
 * The body copy and the mock composer at the bottom are not filler: the one
 * judgement this layer keeps having to make is whether the light stays out of
 * the way of the text underneath it, and that cannot be judged on an empty
 * screen.
 *
 * The source and stream controls are gone with the sources they drove: the
 * light is voice's alone now (see the header of `lib/aura.ts`), so there is
 * one presence and no token cadence to simulate.
 *
 * It also hangs the bus on `window.__aura` so an automated pass can step
 * through the states without clicking; the route 404s outside development
 * (page.tsx), so nothing of that reaches production.
 */

import * as React from "react";
import { AmbientAura } from "@/components/ambient/ambient-aura";
import { attachAuraLevel, setAuraState, type AuraState } from "@/lib/aura";
import { cn } from "@/lib/utils";

const STATES: readonly AuraState[] = [
  "idle",
  "connecting",
  "listening",
  "user",
  "muted",
  "thinking",
  "tool",
  "answering",
  "done",
  "error",
];

const ACCENTS = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;

const CONTROL =
  "rounded-control border border-border bg-card px-2 py-1 text-foreground transition-colors hover:bg-accent";
const ON = "border-primary bg-secondary";

export function AuraPreview() {
  const [state, setState] = React.useState<AuraState>("idle");
  const [accent, setAccent] = React.useState<(typeof ACCENTS)[number]>("coral");
  const [dark, setDark] = React.useState(false);
  const [level, setLevel] = React.useState(0);

  // The stand-in for a microphone. Same shape the call and the dictation panel
  // hand over, so the level states can be driven without one.
  const levelRef = React.useRef(0);
  levelRef.current = level;

  React.useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  React.useEffect(() => {
    setAuraState("voice", state);
  }, [state]);

  React.useEffect(() => {
    attachAuraLevel(levelRef);
    return () => attachAuraLevel(null);
  }, []);

  // The hook an automated pass drives. Dev-only by construction: this route
  // does not exist in a production build.
  React.useEffect(() => {
    (window as unknown as { __aura?: unknown }).__aura = {
      setAuraState,
      attachAuraLevel,
      setLevel: (v: number) => setLevel(v),
      setState: (s: AuraState) => setState(s),
      setAccent: (a: (typeof ACCENTS)[number]) => setAccent(a),
      setDark: (d: boolean) => setDark(d),
    };
  }, []);

  return (
    <div className="relative flex min-h-dvh flex-col bg-background text-foreground">
      <AmbientAura />

      <div className="fixed left-4 top-4 z-toolbar flex max-w-[22rem] flex-wrap items-center gap-1.5 font-mono text-label">
        {STATES.map((s) => (
          <button key={s} type="button" onClick={() => setState(s)} className={cn(CONTROL, state === s && ON)}>
            {s}
          </button>
        ))}

        <span className="w-full" />

        <button type="button" onClick={() => setDark((d) => !d)} className={CONTROL}>
          {dark ? "dark" : "light"}
        </button>

        <span className="w-full" />

        {ACCENTS.map((a) => (
          <button key={a} type="button" onClick={() => setAccent(a)} className={cn(CONTROL, accent === a && ON)}>
            {a}
          </button>
        ))}

        <label className="mt-1 flex w-full items-center gap-2 text-label text-muted-foreground">
          level
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="h-1 flex-1 accent-primary"
            aria-label="Microphone level"
          />
          <span className="tabular-nums">{level.toFixed(2)}</span>
        </label>
      </div>

      {/* `relative z-[1]`, exactly as the app shell wraps its content. Without
          it this harness LIES: the aura is `position: absolute; z-index: 0`,
          and a positioned z-index-0 box paints ABOVE unpositioned in-flow
          content in the same stacking context (CSS 2.1 appendix E, step 8 vs
          step 4). So a bench built to answer "does the light stay out of the
          way of the text" was rendering the light over the text, and every
          reading of it was a reading of the wrong stack. */}
      <div className="relative z-[1] mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-6 px-4 pb-8 pt-24">
        <div className="space-y-3">
          <h1 className="font-sans text-heading">Reading, with the light on</h1>
          <p className="text-ui leading-relaxed text-foreground">
            This paragraph is here to be read while the aura is at full strength. An ambient light that
            is always on has one obligation the voice-only version never had: it must never compete
            with the text it is announcing. Presence drops the whole layer to 62% for anything that is
            not a live call, and the worst case to check is amber on light paper, answering, with the
            cadence drive saturated.
          </p>
          <p className="text-ui leading-relaxed text-muted-foreground">
            The second thing to look for is the hairline below. It is load-bearing for WCAG 1.4.11 and
            it sits inside the band, so if the wash is too strong the edge of the field is the first
            thing to go.
          </p>
        </div>

        <div className="composer-surface flex flex-col gap-2 rounded-composer p-3">
          <div className="text-ui text-muted-foreground">Message Juno…</div>
          <div className="flex items-center justify-between">
            <div className="h-8 w-8 rounded-control border border-border" />
            <div className="h-8 w-8 rounded-full bg-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
