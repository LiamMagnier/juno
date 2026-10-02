"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CrewFace, type CrewState } from "./crew/face";
import { CODE_STEPS, CREW, DRAFT, MIRA, STATUS_FACE, THREAD_TITLE, type AgentStatus, type CrewRow, type Segment } from "./fixtures";
import { ChatSurface } from "./chat";
import { Composer, type ComposerApi } from "./composer";
import { Icon } from "./icons";
import { ICON_USAGE } from "./icon-usage";
import { R, SPRING, T, useReduced } from "./motion";
import { CrewRowItem, face, TopBar } from "./shell";
import { ThinkingMark, type ThinkingState } from "./brand";
import { Step } from "./code";
import { FileMark } from "./marks";
import { smoothed } from "./voice/signal";
import { CrewMark, MemberPeek, Reaction, useMemberTheme } from "./crew-bridge";
import { Answer, Approval, HANDOFF_FACE_ID, HANDOFF_ID, LiveLine, MessageActions, TaskCard, Trace, UserMessage } from "./thread";

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
            <motion.span className="jn-live__face" layoutId={reduced ? undefined : HANDOFF_FACE_ID} layout="position" transition={SPRING.emphasized}>
              <CrewMark member={face(MIRA)} state="working" size={24} />
            </motion.span>
            <motion.p className="jn-handoff__line" layoutId={reduced ? undefined : HANDOFF_ID} layout="position" transition={SPRING.emphasized}>
              Mira is checking renewal usage for three accounts
            </motion.p>
          </div>
        ) : (
          <motion.div
            className="jn-thread__card"
            initial={reduced ? { opacity: 0 } : { clipPath: "inset(0% 0% 78% 0% round 12px)" }}
            animate={reduced ? { opacity: 1 } : { clipPath: "inset(0% 0% 0% 0% round 12px)" }}
            transition={reduced ? R : { duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
          >
            <TaskCard handoff />
          </motion.div>
        )}
      </LayoutGroup>
      <p className="jn-mstage__cap">The line is already set as a card title, so it only moves: into the card’s header on the emphasized spring (0.36 s, bounce 0.1), position only, nothing scales. The card opens beneath it, revealed from the header down over 360 ms.</p>
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
      <p className="jn-mstage__cap">It arrives on base with a 6 px rise and ignores presses for 500 ms (drawn at half ink). Allowed, its height eases down to the one-line receipt over 220 ms while the ask fades out and the receipt settles on the reward spring.</p>
    </div>
  );
}

/* ———————————————————————— 8 · A menu from its trigger ———————————————————————— */

function MenuMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [700, () => api.current?.openModel(true)],
    [2600, () => api.current?.openModel(false)],
    [3400, () => api.current?.openModel(true, true)],
    [5000, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    [5800, () => api.current?.openPlus(true)],
    [7300, () => api.current?.openPlus(false)],
  ]);
  return (
    <div className="jn-mstage jn-mstage--bottom">
      <Composer initial={DRAFT} apiRef={api} variant="dock" />
      <p className="jn-mstage__cap">
        Every layer opens outside the composer, never over the words. With a pointer: grows from its control in 220 ms from 0.96, its opacity in the first 80 ms so the text behind never reads through. From the keyboard: in the same frame, with focus on the chosen model; Escape closes it and focus returns. The + menu follows the same rules.
      </p>
    </div>
  );
}

/* ———————————————————————— 9 · Orbit: an agent's attention and state ———————————————————————— */

const ORBIT_SEQ: { status: AgentStatus; words: string }[] = [
  { status: "ready", words: "Ready" },
  { status: "thinking", words: "Mira is thinking" },
  { status: "working", words: "Mira is matching Stripe customers" },
  { status: "needs", words: "Mira needs your answer" },
  { status: "working", words: "Mira is carrying on" },
  { status: "finished", words: "Finished: 3 accounts checked" },
];

function OrbitMoment() {
  const [i, setI] = React.useState(0);
  const reduced = useReduced();
  useTimeline(() => ORBIT_SEQ.map((_, k): Step => [600 + k * 1500, () => setI(k)]));
  const now = ORBIT_SEQ[i];
  const mira: CrewRow = { ...MIRA, status: now.status, state: STATUS_FACE[now.status] };
  return (
    <div className="jn-mstage jn-mstage--center">
      <div className="jn-morbit">
        <div className="jn-mcrew">
          <CrewFace member={face(MIRA)} state={STATUS_FACE[now.status]} size={96} facing="front" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p key={now.words} className="jn-mcrew__words" data-status={now.status} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
              {now.words}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className="jn-side jn-morbit__rows" aria-label="Orbit rows">
          <CrewRowItem m={mira} />
          {CREW.slice(1, 4).map((m) => (
            <CrewRowItem key={m.id} m={m} />
          ))}
        </div>
      </div>
      <p className="jn-mstage__cap">The state is words, cross-fading in place (120 ms) in the row and under the face; only Needs your answer takes the amber. The pose follows on the standard spring. No motion stands for consent.</p>
    </div>
  );
}

/* ———————————————————————— 10 · A member's own thread (D-032) ———————————————————————— */

const MEMBER_SEQ: { at: number; state: CrewState; words?: string }[] = [
  { at: 0, state: "thinking" },
  { at: 1700, state: "working", words: "Reading seat usage…" },
  { at: 5200, state: "available", words: "Ready" },
];

function MemberMoment({ tall }: { tall?: boolean }) {
  const reduced = useReduced();
  const member = face(MIRA);
  const theme = useMemberTheme(member);
  const [typing, setTyping] = React.useState(0);
  const [k, setK] = React.useState(0);
  const [thanked, setThanked] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [cheer, setCheer] = React.useState(0);
  useTimeline(() => [
    ...MEMBER_SEQ.map((s, i): Step => [600 + s.at, () => setK(i)]),
    [3000, () => setTyping(1)],
    ...Array.from("Thanks Mira, that saves me a morning.").map((_, i, all): Step => [3000 + i * 28, () => setDraft(all.slice(0, i + 1).join(""))]),
    [4200, () => {
      setDraft("");
      setThanked(true);
    }],
    [4550, () => setCheer(1)],
  ]);
  const now = MEMBER_SEQ[k];
  return (
    <div className={tall ? "jn-mframe jn-mframe--tall jn-mframe--member" : "jn-mframe jn-mframe--member"} style={theme.style} data-member-theme={theme.family}>
      <div className="jn-mthread jn-mthread--moment">
        <header className="jn-mhead">
          <div className="jn-mhead__peek">
            <MemberPeek member={member} state={now.state} words={now.words} arrive typing={typing} cheer={cheer} />
          </div>
        </header>
        <div className="jn-thread jn-member">
          <div className="jn-cmsg">
            <p className="jn-cmsg__who">
              <CrewMark member={member} state="available" size={20} />
              <b>Mira</b> <span className="ink-3 num">13:52</span>
            </p>
            <div className="jn-cmsg__body">
              <p>Brightline and Oakridge look fine. Halvorsen AS holds the annual plan, so that is the one call worth making this week.</p>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {thanked ? (
              <motion.div key="t" className="jn-umsg" initial={false} animate={{ opacity: 1 }} transition={reduced ? R : T.instant}>
                <div className="jn-umsg__bubble">
                  <Reaction member={member} />
                  <span className="jn-sentence">Thanks Mira, that saves me a morning.</span>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div className="jn-dock">
          <div className="jn-composer" data-variant="dock">
            <div className="jn-field">
              {draft ? <div className="jn-sentence">{draft}</div> : <div className="jn-field__placeholder"><span>Message Mira…</span></div>}
            </div>
            <div className="jn-crow">
              <span className="jib"><Icon name="plus" size={20} /></span>
              <span className="jn-crow__spacer" />
              <span className="jn-disc" data-mode={draft ? "send" : "voice"} aria-hidden="true">
                <span className="jn-disc__glyph"><Icon name={draft ? "send" : "voice"} size={20} /></span>
              </span>
            </div>
          </div>
        </div>
        <p className="jn-mstage__cap jn-mstage__cap--frame">Mira arrives over her thread on the character spring, says what she is doing in words, and blinks when you start typing to her. Your messages take a tint of her colour and the send disc wears it. Thank her and she is glad once: a happy bounce over the thread and her face on your message, then stillness.</p>
      </div>
    </div>
  );
}

/* ———————————————————————— 11 · Icons ———————————————————————— */

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

/* ———————————————————————— 12 · Material and scroll edges ———————————————————————— */

/** Glide a scroller to a position over a fixed time (the recording needs a steady, readable pace). */
function glideScroll(el: HTMLElement | null, to: number, ms: number, reduced: boolean) {
  if (!el) return;
  if (reduced) {
    el.scrollTop = to;
    return;
  }
  const from = el.scrollTop;
  const t0 = performance.now();
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    el.scrollTop = from + (to - from) * ease(k);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function MaterialMoment({ tall }: { tall?: boolean }) {
  const api = React.useRef<ComposerApi | null>(null);
  const scroll = React.useRef<HTMLDivElement | null>(null);
  const reduced = useReduced();
  useTimeline(() => [
    [100, () => scroll.current && (scroll.current.scrollTop = 0)],
    [700, () => glideScroll(scroll.current, scroll.current ? scroll.current.scrollHeight : 0, 2800, reduced)],
    [4000, () => api.current?.focus(true)],
    [4300, () => void api.current?.type("@", 0)],
    [4900, () => api.current?.key("ArrowDown")],
    [5300, () => api.current?.key("ArrowDown")],
    [6100, () => api.current?.key("Escape")],
    [6250, () => api.current?.key("Backspace")],
    [6400, () => api.current?.blur()],
    [6800, () => api.current?.openModel(true)],
    [8600, () => api.current?.openModel(false)],
  ]);
  return (
    <div className={tall ? "jn-mframe jn-mframe--tall jn-mframe--material" : "jn-mframe jn-mframe--material"} ref={scroll}>
      <div className="jn-chat">
        <TopBar title={THREAD_TITLE} />
        <div className="jn-thread">
          <UserMessage segments={DRAFT} />
          <Trace />
          <Answer />
          <MessageActions />
          <div className="jn-thread__card">
            <TaskCard />
          </div>
        </div>
        <div className="jn-dock">
          <Composer variant="dock" apiRef={api} placeholder="Ask a follow-up" label="Message Alevr" />
        </div>
      </div>
    </div>
  );
}


/* ———————————————————————— 13 · Thinking: the Continuum beside the truthful phase ———————————————————————— */

const THINK_SEQ: { at: number; words: string; state: ThinkingState }[] = [
  { at: 0, words: "Thinking", state: "active" },
  { at: 1300, words: "Reading Q3 Forecast.xlsx", state: "active" },
  { at: 2200, words: "Searching Stripe subscriptions", state: "active" },
  { at: 2500, words: "Searching Stripe subscriptions, 3 found", state: "active" },
  { at: 4400, words: "Waiting for your answer", state: "waiting" },
  { at: 6300, words: "Comparing renewals with the forecast", state: "active" },
  { at: 8300, words: "Finished, read 3 sources", state: "done" },
];

function ThinkingMoment() {
  const [k, setK] = React.useState(0);
  useTimeline(() => THINK_SEQ.map((e, i): Step => [500 + e.at, () => setK(i)]));
  const now = THINK_SEQ[k];
  // Every real event while live asks for a pass; the mark coalesces them (at most one every 1.6 s).
  const events = THINK_SEQ.slice(0, k + 1).filter((e) => e.state === "active").length;
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread">
      <div className="jn-mthink">
        <div className="jn-mthink__row">
          <UserMessage segments={DRAFT} />
          <LiveLine text={now.words} state={now.state} seconds={k >= 2 && now.state === "active" ? 3 + k : undefined} />
        </div>
        <div className="jn-mthink__big" aria-hidden="true">
          <ThinkingMark size={150} state={now.state} pulse={events} />
        </div>
      </div>
      <p className="jn-mstage__cap">The mark never moves: a tone passes through its paths once per real event (events inside 1.6 s share a pass), the last path holds it while live. Waiting is still; finishing settles once.</p>
    </div>
  );
}

/* ———————————————————————— 14 · A token leaving ———————————————————————— */

function TokenRemoveMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  useTimeline(() => [
    [700, () => api.current?.focus(true)],
    [1300, () => api.current?.key("Backspace")],
    [2300, () => api.current?.key("Backspace")],
    [3300, () => api.current?.openPanel("stripe")],
    [4900, () => api.current?.removeToken("stripe")],
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
      <Composer initial={segs} apiRef={api} />
      <p className="jn-mstage__cap">Backspace selects a token, a second removes it in the same frame. From its panel, Remove from message lets it yield in place: 160 ms, ease-in, its room closing. The app stays connected.</p>
    </div>
  );
}

/* ———————————————————————— 15 · Stop ———————————————————————— */

function StopMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  const host = React.useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [phase, setPhase] = React.useState(0);
  useTimeline(() => [
    [900, () => setPhase(1)],
    [2300, () => (host.current?.querySelector('.jn-disc[data-mode="stop"]') as HTMLButtonElement | null)?.click()],
    [3400, () => api.current?.focus(true)],
    [3700, () => void api.current?.type("Only check Halvorsen", 50)],
  ]);
  return (
    <div className="jn-mstage jn-mstage--bottom jn-mstage--thread" ref={host}>
      <div className="jn-mstop">
        <UserMessage segments={DRAFT} />
        {busy ? (
          <LiveLine text={phase ? "Searching Stripe subscriptions" : "Reading Q3 Forecast.xlsx"} seconds={phase ? 4 : undefined} />
        ) : (
          <p className="jn-stopped">
            <span>Stopped. Nothing was posted.</span>
            <button type="button" className="jb jb--link">
              Continue
            </button>
          </p>
        )}
      </div>
      <Composer variant="dock" busy={busy} apiRef={api} placeholder="Ask a follow-up" onStop={() => setBusy(false)} />
      <p className="jn-mstage__cap">While Alevr works the disc is Stop. The work stops in the frame it is pressed; the disc turns back in 120 ms, and the row says what stopped and what did not happen.</p>
    </div>
  );
}

/* ———————————————————————— 16 · Dictation ———————————————————————— */

/** Five input levels from the voice envelope at a time (the product reads the microphone's analyser). */
function levelsAt(ms: number): number[] {
  return [0, 70, 140, 210, 280].map((d, i) => Math.min(1, smoothed(ms - d, "you") * (0.8 + 0.1 * (i % 3))));
}

function DictateMoment() {
  const api = React.useRef<ComposerApi | null>(null);
  const [on, setOn] = React.useState(false);
  const [levels, setLevels] = React.useState<number[] | null>(null);
  const start = React.useRef(0);
  React.useEffect(() => {
    if (!on) {
      setLevels(null);
      return;
    }
    start.current = performance.now();
    let raf = 0;
    const tick = () => {
      setLevels(levelsAt(performance.now() - start.current + 3000));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  useTimeline(() => [
    [700, () => setOn(true)],
    [1100, () => void api.current?.type("Draft the renewal email to Kari at Halvorsen", 62)],
    [4600, () => setOn(false)],
  ]);
  return (
    <div className="jn-mstage jn-mstage--center">
      <Composer initial={[]} apiRef={api} dictation={levels} onDictate={() => setOn((o) => !o)} still={{ pointerFocused: true }} />
      <p className="jn-mstage__cap">Dictating, the mic draws the input level in its own place and the words land as they are recognised; press again to stop. Here the level is a recorded envelope; the product reads the microphone.</p>
    </div>
  );
}

/* ———————————————————————— 17 · Copy and save ———————————————————————— */

function SaveRow() {
  const [saved, setSaved] = React.useState(false);
  const reduced = useReduced();
  return (
    <div className="jn-msave">
      <a href="#" className="jn-attach">
        <FileMark name="Q3 renewal risk.md" size={20} />
        <span className="jn-attach__text">
          <span>Q3 renewal risk, summary</span>
          <span className="ink-3">Document, 2 pages</span>
        </span>
      </a>
      <button type="button" className="jb jb--secondary jb--sm jicon-trigger jn-msave__btn" data-saved={saved ? "" : undefined} aria-pressed={saved} onClick={() => setSaved(true)}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={saved ? "s" : "u"} className="jn-msave__label" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
            <Icon name={saved ? "check" : "library"} size={16} state={saved ? "active" : "rest"} />
            {saved ? "Saved to Library" : "Save to Library"}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}

function CopySaveMoment() {
  const host = React.useRef<HTMLDivElement | null>(null);
  useTimeline(() => [
    [900, () => (host.current?.querySelector('.jn-actions [aria-label="Copy"]') as HTMLButtonElement | null)?.click()],
    [3600, () => (host.current?.querySelector(".jn-msave__btn") as HTMLButtonElement | null)?.click()],
  ]);
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread" ref={host}>
      <p className="jn-mstage__prose">I’ve asked Mira to check usage on all three and flag the ones worth a call.</p>
      <MessageActions />
      <SaveRow />
      <p className="jn-mstage__cap">Confirmation is local and true: Copy draws its check once and returns after 1.5 s; Save to Library becomes Saved to Library once stored, and stays. No toast for something you are watching.</p>
    </div>
  );
}

/* ———————————————————————— 18 · Code: a tool, the diff, verification ———————————————————————— */

function VerifyMoment() {
  const [n, setN] = React.useState(0);
  const [tests, setTests] = React.useState<null | number>(null);
  const [passed, setPassed] = React.useState(false);
  const reduced = useReduced();
  useTimeline(() => [
    ...CODE_STEPS.slice(0, 4).map((_, i): Step => [500 + i * 700, () => setN(i + 1)]),
    [3500, () => setTests(12)],
    [4300, () => setTests(41)],
    [5200, () => setTests(97)],
    [6100, () => setTests(128)],
    [6400, () => setPassed(true)],
  ]);
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread jn-mverify">
      <div className="jn-mverify__head">
        <span className="jn-mverify__title">Sync worker drops cursors on retry</span>
        <button type="button" className="jb jb--secondary jb--sm jicon-trigger" aria-disabled={!passed} data-ready={passed ? "true" : "false"}>
          <Icon name="pull-request" size={16} />
          Open pull request
        </button>
      </div>
      <ol className="jn-steps">
        {CODE_STEPS.slice(0, n).map((st) => (
          <motion.div key={st.object + st.verb} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.fast}>
            <Step {...st} />
          </motion.div>
        ))}
        {passed ? (
          <motion.div initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.fast}>
            <Step verb="Ran" object="npm test -- sync" extra="128 passed" state="done" />
          </motion.div>
        ) : null}
      </ol>
      {tests !== null && !passed ? <LiveLine className="jn-codelive" text="Running the sync suite" detail={`${tests} of 128 tests`} seconds={Math.round(tests / 3)} /> : null}
      <p className="jn-mstage__cap">Each step lands when the tool reports it (120 ms, in place) and the count is the runner’s own. Open pull request becomes available only after the tests pass, on a tonal step. Nothing celebrates.</p>
    </div>
  );
}

/* ———————————————————————— 19 · Error, retry, blocked ———————————————————————— */

function RecoverMoment() {
  const [step, setStep] = React.useState<"error" | "retry" | "done">("error");
  const [ines, setInes] = React.useState<"blocked" | "working">("blocked");
  const host = React.useRef<HTMLDivElement | null>(null);
  useTimeline(() => [
    [1400, () => (host.current?.querySelector(".jn-mrecover__retry") as HTMLButtonElement | null)?.click()],
    [3700, () => setStep("done")],
    [4900, () => (host.current?.querySelector(".jn-mrecover__reconnect") as HTMLButtonElement | null)?.click()],
  ]);
  const inesRow = CREW.find((m) => m.id === "ines") ?? CREW[0];
  const row: CrewRow = ines === "blocked" ? inesRow : { ...inesRow, status: "working", state: "working", long: "Working: reading 12 new applications" };
  return (
    <div className="jn-mstage jn-mstage--top jn-mstage--thread" ref={host}>
      <div className="jn-mrecover">
        {step === "error" ? (
          <div className="jn-live" data-state="error" role="status">
            <span className="jn-live__glyph" aria-hidden="true">
              <ThinkingMark size={20} state="error" />
            </span>
            <span className="jn-live__text">Couldn’t reach Stripe. The request timed out after 30 s.</span>
            <button type="button" className="jb jb--link jn-mrecover__retry" onClick={() => setStep("retry")}>
              Try again
            </button>
          </div>
        ) : (
          <LiveLine text={step === "retry" ? "Searching Stripe subscriptions" : "Finished, read 3 sources"} state={step === "retry" ? "active" : "done"} />
        )}
        <div className="jn-crewstate">
          <CrewMark member={face(row)} state={row.state} size={24} />
          <span className="jn-crewstate__main">
            <span className="jn-crewstate__name">{row.name}</span>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={row.long} className="jn-crewstate__line" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={T.fast}>
                {row.long}
              </motion.span>
            </AnimatePresence>
          </span>
          {ines === "blocked" ? (
            <button type="button" className="jb jb--secondary jb--sm jn-mrecover__reconnect" onClick={() => setInes("working")}>
              Reconnect Greenhouse
            </button>
          ) : null}
        </div>
      </div>
      <p className="jn-mstage__cap">An error is still: the mark in the third ink, the words say what failed, one verb leads forward. Blocked is the same for an agent: the reason and Reconnect. Recovery changes the words.</p>
    </div>
  );
}

/* ———————————————————————— The page ———————————————————————— */

const MOMENTS: { id: string; title: string; spec: string; C: React.ComponentType<{ tall?: boolean }>; tall?: boolean }[] = [
  { id: "focus", title: "Composer focus", spec: "hairline 120 ms · ring opacity 120 ms · disc glyph swap 120 ms, scale 0.8 to 1", C: FocusMoment },
  { id: "palette", title: "@ palette and a token landing", spec: "palette F0, same frame · token fill settles over 220 ms, out-soft", C: PaletteMoment },
  { id: "panel", title: "An app’s panel from its token", spec: "in 220 ms from 0.96, out-soft · out 160 ms, ease-in", C: PanelMoment },
  { id: "send", title: "The first send, home to thread", spec: "turn same frame · chips leave 100 ms · greeting fades 160 ms · composer to the dock on the layout spring, 0.36 s, position only", C: SendMoment, tall: true },
  { id: "wait", title: "Waiting, then a calm answer", spec: "live line after 200 ms · phases hold 1 s · seconds after 3 s · words fade 160 ms", C: WaitMoment, tall: true },
  { id: "handoff", title: "The hand-off", spec: "line to card title on the emphasized spring, position only · card revealed from its header, 360 ms", C: HandoffMoment },
  { id: "approval", title: "Approval: arrive, arm, land", spec: "arrive 220 ms, 6 px rise · arm 500 ms · height to the receipt 220 ms · receipt on the reward spring", C: ApprovalMoment },
  { id: "menu", title: "Menus open and close", spec: "pointer: 220 ms from the trigger, opacity in 80 ms · keyboard: same frame, focus inside · close 160 ms ease-in", C: MenuMoment },
  { id: "orbit", title: "Orbit: an agent’s attention and state", spec: "words cross-fade 120 ms in its row and under its face · pose on the standard spring · turn toward you once", C: OrbitMoment },
  { id: "member", title: "An agent’s own thread", spec: "arrival on the character spring, 0.56 s, bounce 0.15 · words 120 ms · blink on typing · reaction lands once", C: MemberMoment, tall: true },
  { id: "icons", title: "Icons on hover and state", spec: "each icon’s own motion, 120 to 240 ms, reduced to a cross-fade", C: IconsMoment },
  { id: "material", title: "Material and scroll edges", spec: "content blurs under the header and the dock · palette and menu on the material · the material itself never animates", C: MaterialMoment, tall: true },
  { id: "thinking", title: "Thinking: the Continuum handoff", spec: "one blade at a time: rise 120 ms, fall 220 ms, next blade 120 ms later · one pass per real event, absorbed inside 1.6 s (backs off to 6.4 s) · still when waiting · settles once, 560 ms", C: ThinkingMoment },
  { id: "token-remove", title: "A token leaving", spec: "keyboard: select, then gone in the same frame · pointer: yields in place, 160 ms ease-in", C: TokenRemoveMoment },
  { id: "stop", title: "Stop", spec: "stops in the frame it is pressed · disc glyph 120 ms · the row says what stopped", C: StopMoment },
  { id: "dictate", title: "Dictation", spec: "the mic draws the live input level · presence colour while on · words land as recognised", C: DictateMoment },
  { id: "copy-save", title: "Copy and save", spec: "check drawn once, 1.5 s hold · Saved to Library stays · no toast for a watched action", C: CopySaveMoment },
  { id: "verify", title: "Code: steps, tests, ready", spec: "steps fade in where they land, 120 ms · real counts · pull request available only after the pass", C: VerifyMoment },
  { id: "recover", title: "Error, retry, blocked", spec: "still mark and words · one verb forward · recovery changes the words", C: RecoverMoment },
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
        {/* Each run gets its own layout namespace, so a replay starts in place instead of
            animating from where the previous run's shared elements ended. */}
        <LayoutGroup id={`${m.id}-${run}`} key={run}>
          <C tall={large || m.tall} />
        </LayoutGroup>
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
        <p className="jn-page__lede">Causality and continuity only, on the V3 timings: press 70, fast 120, exit 160, base 220, slow 360, emphasis 560 ms. The one spatial move, the first send, takes 360 ms on a spring with no bounce. Anything started from the keyboard does not move. Thinking is the Continuum handing a tone through its paths beside true words. The only thing allowed to idle is an agent over its own thread, and only while you can see it. Every moment has its reduced form.</p>
      </header>
      <div className="jn-motion__grid">
        {MOMENTS.map((m) => (
          <MomentCard key={m.id} m={m} />
        ))}
      </div>
    </main>
  );
}
