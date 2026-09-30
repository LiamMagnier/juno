"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { RotateCcw } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Composer, DRAFT, type ComposerHandle, type Seg } from "./composer";
import { Face } from "./face";
import { CREW, MIRA, PRESENCE_LABEL, PRESENCE_ORDER, type Presence } from "./fixtures";
import { Lens, PresenceLine } from "./lens";
import { StreamingText, ToolLine, UserMessage } from "./thread";
import { DUR, EASE_OUT } from "./tokens";

/*
 * THE MOTION PAGE: every moment of Instrument's motion language, each playing
 * on a loop with its spec and a Replay button. `?moment=<id>` shows one
 * moment alone at recording size.
 *
 * Every moment drives the REAL components through their handles (the
 * composer's typeChar / press / openModel), so what is recorded is what ships.
 */

type Wait = (ms: number) => Promise<void>;

/** Runs a script once per mount; cancelled cleanly on unmount (and on replay). */
function useScript(script: (wait: Wait) => Promise<void>, onDone: () => void) {
  const scriptRef = React.useRef(script);
  const doneRef = React.useRef(onDone);
  React.useEffect(() => {
    scriptRef.current = script;
    doneRef.current = onDone;
  });
  React.useEffect(() => {
    let alive = true;
    const timers: number[] = [];
    const wait: Wait = (ms) =>
      new Promise<void>((resolve, reject) => {
        timers.push(window.setTimeout(() => (alive ? resolve() : reject(new Error("cancelled"))), ms));
      });
    scriptRef.current(wait)
      .then(() => {
        if (alive) doneRef.current();
      })
      .catch(() => {});
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
}

async function typeInto(api: React.RefObject<ComposerHandle | null>, text: string, wait: Wait, speed = 52) {
  for (const c of text) {
    api.current?.typeChar(c);
    await wait(speed + ((c.charCodeAt(0) * 7) % 30));
  }
}

const MOMENTS = [
  { id: "focus", title: "Composer focus", spec: "Tonal only. The hairline goes from 7% to 14% and the shadow deepens, 180ms ease-out; the placeholder dims to 70%. Nothing moves." },
  { id: "palette", title: "@ palette and token", spec: "The palette is anchored to the caret: 140ms, a 4px drop and 0.98 to 1 from the caret corner. Choosing flies the row's mark into the token (FLIP, 220ms ease-out); the chip resolves around it 60ms later (160ms). Exit 100ms." },
  { id: "app", title: "App panel from its token", spec: "It emerges from the token: 180ms, origin at the chip, 0.98 to 1. Connecting swaps the status line by crossfade (120ms), and the token's amber flag goes with it." },
  { id: "send", title: "Send: home to thread", spec: "The message leaves the composer and rises into place (FLIP 280ms ease-out, its fill fades in); the composer docks (layout, 240ms ease-out); the greeting fades (140ms); the key disarms to the lens." },
  { id: "stream", title: "Thinking, working, streaming", spec: "The lens weighs while thinking (a 3.2s phrase), ticks while working (30° steps every 600ms, 3° overshoot) and settles when done (520ms). Words arrive by opacity only, 220ms each, two at a time." },
  { id: "menu", title: "Menu open and close", spec: "It rises from its control in 140ms ease-out, 0.98 to 1 and 4px, and closes faster than it opens: 100ms ease-in." },
  { id: "crew", title: "Crew presence", spec: "Events only: a blink on appearing and on every change; waiting calls twice, then holds the pose; working settles, reads three times, then holds. No idle loop runs forever." },
  { id: "tonal", title: "Hover and press", spec: "Hover is a tonal step (120ms ease-out); press is a second, darker step. No lift, no scale, no icon nudge." },
  { id: "key", title: "The key arms", spec: "With a draft the needle swings to twelve (260ms, one small overshoot) and becomes the arrow while the window lights. Emptying the field disarms it. In voice, the needle follows the level." },
] as const;

type MomentId = (typeof MOMENTS)[number]["id"];

/* ---------------------------------------------------------------------------
 * Moments
 * ------------------------------------------------------------------------- */

function FocusMoment({ onDone }: { onDone: () => void }) {
  const api = React.useRef<ComposerHandle | null>(null);
  useScript(async (wait) => {
    await wait(900);
    api.current?.focus();
    await wait(900);
    await typeInto(api, "Draft the renewal note for Dana", wait);
    await wait(1400);
    api.current?.blur();
    await wait(1200);
  }, onDone);
  return (
    <div className="w-[620px]">
      <Composer handleRef={api} />
    </div>
  );
}

function PaletteMoment({ onDone }: { onDone: () => void }) {
  const api = React.useRef<ComposerHandle | null>(null);
  useScript(async (wait) => {
    await wait(600);
    api.current?.focus();
    await typeInto(api, "Compare ", wait);
    api.current?.typeChar("@");
    await wait(900);
    await typeInto(api, "q3", wait, 140);
    await wait(700);
    api.current?.press("Enter");
    await wait(700);
    await typeInto(api, "with ", wait);
    api.current?.typeChar("@");
    await wait(500);
    await typeInto(api, "str", wait, 140);
    await wait(600);
    api.current?.press("Enter");
    await wait(600);
    await typeInto(api, "and ask ", wait);
    api.current?.typeChar("@");
    await wait(500);
    await typeInto(api, "mi", wait, 140);
    await wait(600);
    api.current?.press("Enter");
    await wait(500);
    await typeInto(api, "to flag renewal risk", wait);
    await wait(1800);
  }, onDone);
  return (
    <div className="w-[680px] pb-[300px]">
      <Composer handleRef={api} />
    </div>
  );
}

function AppMoment({ onDone }: { onDone: () => void }) {
  const api = React.useRef<ComposerHandle | null>(null);
  useScript(async (wait) => {
    await wait(600);
    api.current?.focus();
    await typeInto(api, "Post the summary to #design in ", wait);
    api.current?.typeChar("@");
    await wait(500);
    await typeInto(api, "sla", wait, 140);
    await wait(600);
    api.current?.press("Enter");
    await wait(2200);
    api.current?.connect("slack");
    await wait(2200);
    api.current?.closePanels();
    await wait(1200);
  }, onDone);
  return (
    <div className="w-[640px] pb-[240px]">
      <Composer handleRef={api} />
    </div>
  );
}

function SendMoment({ onDone }: { onDone: () => void }) {
  const reduce = useReducedMotion();
  const api = React.useRef<ComposerHandle | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const from = React.useRef<DOMRect | null>(null);
  const [phase, setPhase] = React.useState<"home" | "thread">("home");
  const [sent, setSent] = React.useState<Seg[] | null>(null);
  const [presence, setPresence] = React.useState<"none" | "thinking" | "working" | "done">("none");
  const [streaming, setStreaming] = React.useState(false);

  const send = React.useCallback((segs: Seg[]) => {
    const draft = stageRef.current?.querySelector("[data-draft]");
    from.current = draft?.getBoundingClientRect() ?? null;
    setSent(segs);
    setPhase("thread");
    api.current?.setSegs([]);
  }, []);

  // FLIP the sent message from the composer's text to its place in the thread.
  React.useLayoutEffect(() => {
    if (phase !== "thread" || !from.current) return;
    const msg = stageRef.current?.querySelector<HTMLElement>("[data-user-msg]");
    if (!msg) return;
    const to = msg.getBoundingClientRect();
    const f = from.current;
    from.current = null;
    if (reduce) {
      msg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      return;
    }
    const dx = f.left - (to.left + 14);
    const dy = f.top - (to.top + 10);
    msg.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, backgroundColor: "transparent" },
        { transform: "translate(0, 0)", backgroundColor: "var(--in-fill)" },
      ],
      { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }, [phase, reduce]);

  useScript(async (wait) => {
    await wait(1000);
    api.current?.focus();
    await wait(500);
    api.current?.press("Enter");
    await wait(520);
    setPresence("thinking");
    await wait(1700);
    setPresence("working");
    await wait(1500);
    setPresence("done");
    setStreaming(true);
    await wait(3600);
  }, onDone);

  return (
    <div ref={stageRef} className="relative flex h-[520px] w-[860px] flex-col overflow-hidden in-r-12" style={{ background: "var(--in-panel)", boxShadow: "0 0 0 1px var(--in-hairline)" }}>
      <LayoutGroup>
        <div className={cn("flex min-h-0 flex-1 flex-col", phase === "home" ? "justify-center" : "justify-start")}>
          <AnimatePresence initial={false}>
            {phase === "home" ? (
              <motion.h1 key="greet" className="in-t-display mx-auto mb-7 w-[640px] pl-0.5" exit={{ opacity: 0, transition: { duration: 0.14 } }}>
                Good afternoon, Liam
              </motion.h1>
            ) : null}
          </AnimatePresence>
          {phase === "thread" && sent ? (
            <div className="mx-auto flex w-[640px] flex-col pt-7">
              <UserMessage segs={sent} />
              <div className="mt-6 min-h-[28px]">
                <AnimatePresence mode="wait" initial={false}>
                  {presence === "thinking" ? (
                    <motion.div key="t" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.tonal }}>
                      <PresenceLine state="thinking">Thinking</PresenceLine>
                    </motion.div>
                  ) : presence === "working" ? (
                    <motion.div key="w" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.tonal }}>
                      <PresenceLine state="working">Reading Q3 Forecast.xlsx and Stripe</PresenceLine>
                    </motion.div>
                  ) : presence === "done" ? (
                    <motion.div key="d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: DUR.tonal }}>
                      <ToolLine />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              {streaming ? (
                <p className="in-answer mt-2">
                  <StreamingText playing text="Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap, and Halvorsen is most of it: they moved to monthly billing in August and have not renewed the annual plan." />
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <motion.div layout transition={{ duration: reduce ? 0 : DUR.dock, ease: EASE_OUT }} className={cn("mx-auto w-[640px]", phase === "home" ? "mb-[120px]" : "mb-4")}>
          <Composer handleRef={api} initial={DRAFT} size={phase === "home" ? "hero" : "docked"} placeholder="Reply to Juno" onSend={send} />
        </motion.div>
      </LayoutGroup>
    </div>
  );
}

function StreamMoment({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = React.useState<"thinking" | "working" | "settle" | "stream">("thinking");
  useScript(async (wait) => {
    await wait(2600);
    setPhase("working");
    await wait(2600);
    setPhase("settle");
    await wait(600);
    setPhase("stream");
    await wait(5200);
  }, onDone);
  return (
    <div className="w-[640px]">
      <UserMessage segs={DRAFT} />
      <div className="mt-6 flex items-center gap-4">
        <Lens size={32} state={phase === "stream" ? "rest" : phase} />
        <span className="in-t-ui in-ink-2">
          {phase === "thinking" ? "Thinking" : phase === "working" ? "Reading Q3 Forecast.xlsx and Stripe" : phase === "settle" ? "Done" : "Answering"}
        </span>
      </div>
      <div className="mt-4 min-h-[180px]">
        {phase === "stream" ? (
          <p className="in-answer">
            <StreamingText playing text="Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap. Halvorsen moved to monthly billing in August and has not renewed the annual plan; Brightline Studio dropped two seats on 12 September; Oakridge Health has an unpaid invoice from July." />
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MenuMoment({ onDone }: { onDone: () => void }) {
  const api = React.useRef<ComposerHandle | null>(null);
  useScript(async (wait) => {
    await wait(900);
    api.current?.openModel(true);
    await wait(2200);
    api.current?.openModel(false);
    await wait(1100);
    api.current?.openModel(true);
    await wait(1600);
    api.current?.openModel(false);
    await wait(900);
  }, onDone);
  return (
    <div className="w-[620px] pb-[380px]">
      <Composer handleRef={api} initial={DRAFT} />
    </div>
  );
}

function CrewMoment({ onDone }: { onDone: () => void }) {
  const [i, setI] = React.useState(0);
  useScript(async (wait) => {
    for (let n = 1; n < PRESENCE_ORDER.length; n++) {
      await wait(n === 4 ? 7000 : 2600);
      setI(n);
    }
    await wait(2600);
  }, onDone);
  const p: Presence = PRESENCE_ORDER[i];
  return (
    <div className="flex items-center gap-16">
      <div className="flex flex-col items-center gap-4">
        <Face face={MIRA.face} presence={p} size={96} name="Mira" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={p} className={p === "waiting" ? "in-t-ui in-amber" : "in-t-ui in-ink-2"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.tonal }}>
            {PRESENCE_LABEL[p]}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="w-[240px] in-r-12 p-2" style={{ background: "var(--in-chassis)" }}>
        {CREW.slice(0, 4).map((m, n) => (
          <div key={m.id} className="in-row">
            <span className="in-row__icon">
              <Face face={m.face} presence={n === 0 ? p : m.presence} size={18} />
            </span>
            <span className="in-row__label">{m.name}</span>
            {n === 0 && p === "waiting" ? <span className="in-row__trail in-amber">Needs you</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function TonalMoment({ onDone }: { onDone: () => void }) {
  const [force, setForce] = React.useState<{ i: number; f: "hover" | "press" } | null>(null);
  useScript(async (wait) => {
    const steps: [number, "hover" | "press", number][] = [
      [0, "hover", 700],
      [1, "hover", 700],
      [2, "hover", 700],
      [2, "press", 260],
      [2, "hover", 700],
      [4, "hover", 800],
      [4, "press", 220],
      [4, "hover", 700],
      [5, "hover", 800],
      [5, "press", 220],
      [5, "hover", 700],
    ];
    for (const [i, f, ms] of steps) {
      setForce({ i, f });
      await wait(ms);
    }
    setForce(null);
    await wait(900);
  }, onDone);
  const f = (i: number) => (force?.i === i ? force.f : undefined);
  return (
    <div className="flex items-start gap-14">
      <div className="w-[240px] in-r-12 p-2" style={{ background: "var(--in-chassis)" }}>
        {["New chat", "Search", "Projects", "Library"].map((l, i) => (
          <div key={l} className="in-row" data-force={f(i)}>
            <span className="in-row__label">{l}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col items-start gap-3">
        <button type="button" className="in-btn" data-variant="secondary" data-force={f(4)}>
          Deny
        </button>
        <button type="button" className="in-btn" data-variant="solid" data-force={f(5)}>
          Allow once
        </button>
      </div>
    </div>
  );
}

function KeyMoment({ onDone }: { onDone: () => void }) {
  const api = React.useRef<ComposerHandle | null>(null);
  const [level, setLevel] = React.useState(0);
  const [voice, setVoice] = React.useState(false);
  useScript(async (wait) => {
    await wait(900);
    api.current?.focus();
    await typeInto(api, "Summarise", wait, 70);
    await wait(900);
    for (let n = 0; n < 9; n++) {
      api.current?.press("Backspace");
      await wait(45);
    }
    await wait(900);
    api.current?.blur();
    setVoice(true);
    const levels = [0.1, 0.5, 0.8, 0.35, 0.6, 0.95, 0.4, 0.2, 0.7, 0.5, 0.15, 0.6, 0.3, 0.05, 0];
    for (const l of levels) {
      setLevel(l);
      await wait(140);
    }
    setVoice(false);
    await wait(1000);
  }, onDone);
  return (
    <div className="flex items-center gap-12">
      <div className="w-[520px]">
        <Composer handleRef={api} />
      </div>
      <div className="flex flex-col items-center gap-3">
        <Lens size={64} state={voice ? "listening" : "rest"} level={level} />
        <span className="in-t-small in-ink-3">{voice ? "Listening" : "Rest"}</span>
      </div>
    </div>
  );
}

const RENDER: Record<MomentId, (p: { onDone: () => void }) => React.JSX.Element> = {
  focus: FocusMoment,
  palette: PaletteMoment,
  app: AppMoment,
  send: SendMoment,
  stream: StreamMoment,
  menu: MenuMoment,
  crew: CrewMoment,
  tonal: TonalMoment,
  key: KeyMoment,
};

function Moment({ id, index, solo }: { id: MomentId; index: number; solo?: boolean }) {
  const meta = MOMENTS.find((m) => m.id === id)!;
  const [run, setRun] = React.useState(0);
  const loop = React.useRef<number | null>(null);
  const Body = RENDER[id];
  const onDone = React.useCallback(() => {
    loop.current = window.setTimeout(() => setRun((r) => r + 1), 900);
  }, []);
  React.useEffect(
    () => () => {
      if (loop.current) window.clearTimeout(loop.current);
    },
    [],
  );
  return (
    <section className={cn("flex flex-col", solo ? "min-h-dvh" : "border-t pt-8")} style={{ borderColor: "var(--in-hairline)" }} aria-label={meta.title} data-moment={id}>
      <header className={cn("flex items-start justify-between gap-6", solo ? "px-10 pt-8" : "")}>
        <div>
          <h2 className="flex items-baseline gap-3 in-fs-15 font-medium leading-[22px]">
            <span className="in-mono in-fs-115 in-ink-3">{String(index + 1).padStart(2, "0")}</span>
            {meta.title}
          </h2>
          <p className="mt-1 max-w-[80ch] in-t-small in-ink-3">{meta.spec}</p>
        </div>
        <button
          type="button"
          className="in-btn shrink-0"
          data-variant="secondary"
          data-size="sm"
          onClick={() => {
            if (loop.current) window.clearTimeout(loop.current);
            setRun((r) => r + 1);
          }}
        >
          <RotateCcw size={14} motion="none" />
          Replay
        </button>
      </header>
      <div className={cn("grid flex-1 place-items-center", solo ? "px-10 pb-10" : "min-h-[440px] py-8")}>
        <Body key={run} onDone={onDone} />
      </div>
    </section>
  );
}

export function MotionScene({ moment }: { moment?: string }) {
  const soloIndex = MOMENTS.findIndex((m) => m.id === moment);
  return (
    <div className="in-panel !m-0 !rounded-none !shadow-none" style={{ minHeight: "100dvh" }}>
      {soloIndex >= 0 ? (
        <Moment id={MOMENTS[soloIndex].id} index={soloIndex} solo />
      ) : (
        <div className="in-sheet">
          <header className="pb-8">
            <h1 className="in-t-display">Motion</h1>
            <p className="mt-3 max-w-[70ch] in-fs-155 leading-[25px] in-ink-2">
              Motion explains cause and continuity. Chrome moves in 120 to 240ms on one ease-out curve; only direct manipulation and presence get a spring. Every moment has a reduced form: a crossfade, or nothing.
            </p>
          </header>
          <div className="flex flex-col gap-8">
            {MOMENTS.map((m, i) => (
              <Moment key={m.id} id={m.id} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
