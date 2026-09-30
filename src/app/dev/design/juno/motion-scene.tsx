"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CrewFace, type CrewState } from "./crew/face";
import { CREW, DRAFT, MIRA, type Segment } from "./fixtures";
import { ChatSurface } from "./chat";
import { Composer, type ComposerApi } from "./composer";
import { Icon } from "./icons";
import { ICON_USAGE } from "./icon-usage";
import { R, SPRING, T, useReduced } from "./motion";
import { face } from "./shell";
import { Approval, HANDOFF_ID, TaskCard } from "./thread";

/*
 * Motion, one moment at a time. Each plays on its own and replays on demand;
 * `?m=<id>` plays one moment large, for recording. The line under each title
 * is its timing, from INTERACTION_SPEC §1.
 */

type Step = [number, () => void];

/** Run a timeline once per mount. Cleared on unmount, so Replay (a remount) always starts clean. */
function useTimeline(build: () => Step[]) {
  React.useEffect(() => {
    const steps = build();
    const timers = steps.map(([at, fn]) => window.setTimeout(fn, at));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // The timeline is fixed per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/* ———————————————————————— 1 · Composer focus ———————————————————————— */

function FocusMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [700, () => api.current?.focus(false)],
    [2000, () => api.current?.blur()],
    [2700, () => api.current?.focus(true)],
    [3200, () => void api.current?.type("Draft the renewal email", 45)],
    [5600, () => api.current?.blur()],
  ]);
  return (
    <div className="jn-mstage jn-mstage--center">
      <Composer initial={[]} apiRef={api} />
      <p className="jn-mstage__cap">Pointer focus darkens the hairline. Keyboard focus adds the ring. The disc turns from voice to send as words arrive.</p>
    </div>
  );
}

/* ———————————————————————— 2 · @ palette and a token settling ———————————————————————— */

function PaletteMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [500, () => api.current?.focus(true)],
    [800, () => void api.current?.type("Compare ", 55)],
    [1400, () => void api.current?.type("@", 0)],
    [2000, () => void api.current?.type("fo", 140)],
    [2700, () => api.current?.key("Enter")],
    [3400, () => void api.current?.type("with ", 55)],
    [3900, () => void api.current?.type("@", 0)],
    [4500, () => void api.current?.type("str", 130)],
    [5200, () => api.current?.key("Enter")],
  ]);
  return (
    <div className="jn-mstage jn-mstage--top">
      <Composer initial={[]} apiRef={api} />
      <p className="jn-mstage__cap">The palette opens in the same frame as the key (F0). Enter puts the thing in the sentence; its fill relaxes from the highlight tone in 220 ms. Nothing flies.</p>
    </div>
  );
}

/* ———————————————————————— 3 · An app token’s panel ———————————————————————— */

function PanelMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [800, () => api.current?.openPanel("stripe")],
    [3200, () => api.current?.openPanel(null)],
    [3900, () => api.current?.openPanel("slack")],
    [6200, () => api.current?.openPanel(null)],
  ]);
  const segs: Segment[] = [
    { t: "text", v: "Compare " },
    { t: "token", id: "forecast" },
    { t: "text", v: " with " },
    { t: "token", id: "stripe" },
    { t: "text", v: " and post it in " },
    { t: "token", id: "slack" },
  ];
  return (
    <div className="jn-mstage jn-mstage--top">
      <Composer initial={segs} apiRef={api} still={{ pointerFocused: true }} />
      <p className="jn-mstage__cap">A click on a token grows its panel out of the token: 220 ms from 0.96, origin at the token. It closes on exit, 160 ms, ease-in.</p>
    </div>
  );
}

/* ———————————————————————— 4 · The first send, home to thread ———————————————————————— */

function SendMoment({ tall }: { tall?: boolean }) {
  const api = React.useRef<ComposerApi | null>(null);
  const scroll = React.useRef<HTMLDivElement | null>(null);
  useTimeline(() => [
    [900, () => api.current?.focus(true)],
    [1500, () => api.current?.send()],
  ]);
  return (
    <div className={tall ? "jn-mframe jn-mframe--tall" : "jn-mframe"} ref={scroll}>
      <ChatSurface initialPhase="home" initialSegs={DRAFT} apiRef={api} scrollRef={scroll} />
    </div>
  );
}

/* ———————————————————————— 5 · Waiting, then the answer ———————————————————————— */

function WaitMoment({ tall }: { tall?: boolean }) {
  const scroll = React.useRef<HTMLDivElement | null>(null);
  return (
    <div className={tall ? "jn-mframe jn-mframe--tall" : "jn-mframe"} ref={scroll}>
      <ChatSurface initialPhase="thread" playThread scrollRef={scroll} />
    </div>
  );
}

/* ———————————————————————— 6 · The hand-off ———————————————————————— */

function HandoffMoment() {
  const reduced = useReduced();
  const [card, setCard] = React.useState(false);
  useTimeline(() => [[1400, () => setCard(true)]]);
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread">
      <LayoutGroup>
        <p className="jn-mstage__prose">I’ve asked Mira to check usage on all three and flag the ones worth a call.</p>
        {!card ? (
          <div className="jn-handoff">
            <span className="jn-live__face">
              <CrewFace member={face(MIRA)} state="working" size={16} live={false} />
            </span>
            <motion.p className="jn-live jn-handoff__line" layoutId={reduced ? undefined : HANDOFF_ID} transition={SPRING.emphasized}>
              Mira is checking renewal usage for three accounts
            </motion.p>
          </div>
        ) : (
          <motion.div className="jn-thread__card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.base}>
            <TaskCard handoff />
          </motion.div>
        )}
      </LayoutGroup>
      <p className="jn-mstage__cap">The line that says what Mira is doing becomes the card’s title on the emphasized spring (0.36 s, bounce 0.1); the card opens beneath it.</p>
    </div>
  );
}

/* ———————————————————————— 7 · Approval arrives, arms, lands ———————————————————————— */

function ApprovalMoment() {
  const [shown, setShown] = React.useState(false);
  const host = React.useRef<HTMLDivElement | null>(null);
  useTimeline(() => [
    [600, () => setShown(true)],
    [2600, () => (host.current?.querySelector(".jsplit__main") as HTMLButtonElement | null)?.click()],
  ]);
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread" ref={host}>
      <AnimatePresence>{shown ? <Approval key="a" animate /> : null}</AnimatePresence>
      <p className="jn-mstage__cap">It arrives on base with a 6 px rise and ignores presses for 500 ms (drawn at half ink). Allowed, it collapses to a receipt that settles on the reward spring.</p>
    </div>
  );
}

/* ———————————————————————— 8 · A menu from its trigger ———————————————————————— */

function MenuMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [700, () => api.current?.openModel(true)],
    [2600, () => api.current?.openModel(false)],
    [3300, () => api.current?.openModel(true)],
    [5200, () => api.current?.openModel(false)],
  ]);
  return (
    <div className="jn-mstage jn-mstage--bottom">
      <Composer initial={DRAFT} apiRef={api} />
      <p className="jn-mstage__cap">Opened with a pointer: 220 ms from the label, from 0.96. Closed: 160 ms, opacity-led, ease-in. Opened from the keyboard: instant.</p>
    </div>
  );
}

/* ———————————————————————— 9 · Crew presence ———————————————————————— */

const PRESENCE_SEQ: { state: CrewState; words: string }[] = [
  { state: "available", words: "Free" },
  { state: "thinking", words: "Mira is thinking" },
  { state: "working", words: "Mira is matching Stripe customers" },
  { state: "waiting", words: "Mira needs your answer" },
  { state: "working", words: "Mira is carrying on" },
  { state: "available", words: "Finished, a moment ago" },
];

function CrewMoment() {
  const [i, setI] = React.useState(0);
  useTimeline(() => PRESENCE_SEQ.map((_, k): Step => [600 + k * 1500, () => setI(k)]));
  const now = PRESENCE_SEQ[i];
  return (
    <div className="jn-mstage jn-mstage--center">
      <div className="jn-mcrew">
        <CrewFace member={face(MIRA)} state={now.state} size={96} facing="front" />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p key={now.words} className="jn-mcrew__words" data-state={now.state} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T.fast}>
            {now.words}
          </motion.p>
        </AnimatePresence>
      </div>
      <div className="jn-mcrew__row">
        {CREW.map((m) => (
          <CrewFace key={m.id} member={face(m)} state={m.state} size={32} />
        ))}
      </div>
      <p className="jn-mstage__cap">State changes morph on the standard spring and cross-fade their words; turning toward you when it needs you plays once. Nothing moves on a timer.</p>
    </div>
  );
}

/* ———————————————————————— 10 · Icons ———————————————————————— */

function IconsMoment() {
  const names = ICON_USAGE.flatMap((g) => g.names).slice(0, 36);
  const [active, setActive] = React.useState<string | null>(null);
  useTimeline(() => names.map((n, k): Step => [500 + k * 220, () => setActive(n)]).concat([[500 + names.length * 220, () => setActive(null)]]));
  return (
    <div className="jn-mstage jn-mstage--center">
      <div className="jn-micons">
        {names.map((n) => (
          <button key={n} type="button" className="jib jicon-trigger" aria-label={n} data-force={active === n ? "hover" : undefined}>
            <Icon name={n} size={20} state={active === n ? "active" : "rest"} />
          </button>
        ))}
      </div>
      <p className="jn-mstage__cap">Each icon answers hover, press and its own state with a small motion of its own. Hover the grid.</p>
    </div>
  );
}

/* ———————————————————————— The page ———————————————————————— */

const MOMENTS: { id: string; title: string; spec: string; C: React.ComponentType<{ tall?: boolean }>; tall?: boolean }[] = [
  { id: "focus", title: "Composer focus", spec: "hairline 120 ms · ring opacity 120 ms · disc glyph swap 120 ms, scale 0.8 to 1", C: FocusMoment },
  { id: "palette", title: "@ palette and a token landing", spec: "palette F0, same frame · token fill settles over 220 ms, out-soft", C: PaletteMoment },
  { id: "panel", title: "An app’s panel from its token", spec: "in 220 ms from 0.96, out-soft · out 160 ms, ease-in", C: PanelMoment },
  { id: "send", title: "The first send, home to thread", spec: "turn same frame · greeting exits 160 ms · composer to the dock on the layout spring, 0.36 s, no bounce", C: SendMoment, tall: true },
  { id: "wait", title: "Waiting, then a calm answer", spec: "live line after 200 ms · phases hold 1 s · seconds after 3 s · words fade 160 ms", C: WaitMoment, tall: true },
  { id: "handoff", title: "The hand-off", spec: "live line to card title on the emphasized spring, 0.36 s, bounce 0.1", C: HandoffMoment },
  { id: "approval", title: "Approval: arrive, arm, land", spec: "arrive 220 ms, 6 px rise · arm 500 ms · receipt on the reward spring", C: ApprovalMoment },
  { id: "menu", title: "A menu opens and closes", spec: "open 220 ms from the trigger · close 160 ms ease-in · keyboard instant", C: MenuMoment },
  { id: "crew", title: "Crew presence", spec: "pose on the standard spring · words cross-fade 120 ms · attention turn once", C: CrewMoment },
  { id: "icons", title: "Icons on hover and state", spec: "each icon’s own motion, 120 to 240 ms, reduced to a cross-fade", C: IconsMoment },
];

function MomentCard({ m, large }: { m: (typeof MOMENTS)[number]; large?: boolean }) {
  const [run, setRun] = React.useState(0);
  const C = m.C;
  return (
    <section className="jn-moment" data-large={large ? "" : undefined} data-tall={m.tall ? "" : undefined} aria-labelledby={`m-${m.id}`}>
      <header className="jn-moment__head">
        <div>
          <h2 id={`m-${m.id}`} className="jn-moment__title">
            {m.title}
          </h2>
          <p className="jn-moment__spec">{m.spec}</p>
        </div>
        <button type="button" className="jb jb--secondary jb--sm jicon-trigger" onClick={() => setRun((r) => r + 1)} data-replay="">
          <Icon name="retry" size={16} />
          Replay
        </button>
      </header>
      <div className="jn-moment__stage">
        <C key={run} tall={large || m.tall} />
      </div>
    </section>
  );
}

export function MotionScene({ only }: { only?: string }) {
  const single = MOMENTS.find((m) => m.id === only);
  if (single) {
    return (
      <main className="jn-motion jn-motion--single">
        <MomentCard m={single} large />
      </main>
    );
  }
  return (
    <main className="jn-motion">
      <header className="jn-sys__head">
        <h1 className="t-title">Motion</h1>
        <p className="jn-page__lede">Causality and continuity only. Chrome answers in 120 to 220 ms; the one spatial move, the first send, takes 360 ms on a spring with no bounce. Anything started from the keyboard does not move. Nothing idles.</p>
      </header>
      <div className="jn-motion__grid">
        {MOMENTS.map((m) => (
          <MomentCard key={m.id} m={m} />
        ))}
      </div>
    </main>
  );
}
