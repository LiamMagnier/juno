"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CrewMark } from "./crew-bridge";
import { ACCOUNT, DRAFT, MIRA, PRESENCE_WORDS, RECEIPT, THREAD_TITLE, type Segment } from "./fixtures";
import { Composer, type ComposerApi, type ComposerStill } from "./composer";
import { Icon } from "./icons";
import { GmailMark, SlackMark } from "./marks";
import { EASE_OUT, R, SPRING, T, useReduced } from "./motion";
import { face, MobileBar, panelOf, TopBar } from "./shell";
import { Answer, ANSWER_WORDS, Approval, HANDOFF_FACE_ID, HANDOFF_ID, LiveLine, MessageActions, NeedsYouRow, TaskCard, Trace, UserMessage } from "./thread";

/*
 * Chat, from the empty home to a working thread, as ONE surface, so the first
 * send is a continuous event rather than a page change (C12, C18, M1, M2, T1):
 *
 *   send      in the same frame the person's turn is drawn in its final place
 *             (a 120 ms settle from 0.6 opacity); the suggestions leave first
 *             (100 ms, out-soft) so the composer never crosses them; the
 *             greeting fades where it stood (160 ms, ease-in); the composer
 *             travels from the centre to the dock on the layout spring
 *             (0.36 s, no bounce), its position only: nothing in it stretches.
 *   wait      after 200 ms, the live line says what Juno is doing; after 3 s
 *             it counts seconds.
 *   answer    the first word replaces the line in the same frame; words fade in
 *             where they stay (160 ms each); the trace folds into one line.
 *             The view does not chase the stream: the person's message stays
 *             where they last saw it, and what lands below the fold is named
 *             in the dock ("2 things need you", with Show).
 *   hand-off  the line that says what Mira is doing (already set as a card
 *             title) moves into the task card's header on the emphasized
 *             spring, position only, and the card opens beneath it.
 *   approval  the approval card arrives (base, 6 px rise) and arms after 500 ms.
 */

export type Stage = "thinking" | "streaming" | "done" | "handoff" | "task" | "approval";
const ORDER: Stage[] = ["thinking", "streaming", "done", "handoff", "task", "approval"];

export function Greeting() {
  return <h1 className="t-greet jn-greet">What’s next, {ACCOUNT.first}?</h1>;
}

/**
 * Up to three suggestions from the person's own state (§3.3): what moved since
 * they looked, what they left half done, who wrote to them. Never a crew
 * member who is already asking in the sidebar: one ask, one place.
 */
export function Suggestions() {
  return (
    <div className="jn-suggest">
      <button type="button" className="jn-chip">
        <SlackMark size={16} />
        Catch up on #design
      </button>
      <button type="button" className="jn-chip">
        <Icon name="deck" size={16} className="jn-chip__glyph" />
        Finish the board deck
      </button>
      <button type="button" className="jn-chip">
        <GmailMark size={16} />
        Reply to Kari at Halvorsen
      </button>
    </div>
  );
}

type Ghost = { greet: React.CSSProperties; suggest: React.CSSProperties | null; composer?: React.CSSProperties; segs: Segment[] } | null;

/** How many of the thread's asks (a question, an approval) are out of view: the dock names them. */
function useNeedsOutOfView(enabled: boolean, chat: React.RefObject<HTMLElement | null>, scroller: () => HTMLElement | null, deps: unknown[]) {
  const [out, setOut] = React.useState(0);
  React.useEffect(() => {
    const root = scroller();
    const host = chat.current;
    if (!enabled || !root || !host) {
      setOut(0);
      return;
    }
    const seen = new Map<Element, boolean>();
    const count = () => setOut([...seen.values()].filter((v) => !v).length);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target, e.isIntersecting && e.intersectionRatio > 0.3);
        count();
      },
      { root, rootMargin: "0px 0px -150px 0px", threshold: [0, 0.3, 0.6, 1] },
    );
    const observe = () => {
      io.disconnect();
      seen.clear();
      host.querySelectorAll(".jn-task[data-waiting], .jn-approve:not([data-outcome])").forEach((el) => {
        seen.set(el, true);
        io.observe(el);
      });
      count();
    };
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(host, { subtree: true, attributes: true, attributeFilter: ["data-waiting", "data-outcome"] });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return out;
}

export function ChatSurface({
  initialPhase = "home",
  initialStage = "approval",
  initialSegs = [],
  composerStill,
  auto = true,
  planOpen = false,
  apiRef,
  onPhase,
  scrollRef,
  stillStage,
  approvalMenu = false,
  playThread = false,
}: {
  initialPhase?: "home" | "thread";
  initialStage?: Stage;
  initialSegs?: Segment[];
  composerStill?: ComposerStill;
  /** After a live send, run the thread's timeline (live line, stream, hand-off, approval). */
  auto?: boolean;
  planOpen?: boolean;
  apiRef?: React.MutableRefObject<ComposerApi | null>;
  onPhase?: (p: string) => void;
  /** The element that scrolls (a motion stage); the panel scrolls when omitted. */
  scrollRef?: React.RefObject<HTMLElement | null>;
  /** Freeze the thread at a stage (for stills). */
  stillStage?: { stage: Stage; revealed?: number; presence?: number; seconds?: number };
  approvalMenu?: boolean;
  /** Start in the thread and play its timeline from the send (the motion page). */
  playThread?: boolean;
}) {
  const reduced = useReduced();
  const [phase, setPhase] = React.useState<"home" | "thread">(initialPhase);
  const [sent, setSent] = React.useState<Segment[]>(initialPhase === "thread" ? DRAFT : []);
  const settled = initialPhase === "thread" && !playThread;
  const [stage, setStage] = React.useState<Stage>(stillStage?.stage ?? (settled ? initialStage : "thinking"));
  const [presence, setPresence] = React.useState(stillStage?.presence ?? 0);
  const [revealed, setRevealed] = React.useState(stillStage?.revealed ?? (settled ? Infinity : 0));
  const [lineShown, setLineShown] = React.useState(settled);
  const [seconds, setSeconds] = React.useState(stillStage?.seconds ?? 0);
  const [receipt, setReceipt] = React.useState(settled);
  const [ghost, setGhost] = React.useState<Ghost>(null);
  const [justSent, setJustSent] = React.useState(false);
  const [travel, setTravel] = React.useState(false);
  /* Stop (Revision 2: it was never wired here): the work stops in the frame the disc is pressed, what streamed
     stays where it is, nothing else arrives, and one row says what stopped with the way to carry on. */
  const [stopped, setStopped] = React.useState(false);
  const dockApi = React.useRef<ComposerApi | null>(null);
  const chatRef = React.useRef<HTMLDivElement | null>(null);
  const greetRef = React.useRef<HTMLDivElement | null>(null);
  const suggestRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<HTMLDivElement | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const live = initialPhase !== "thread" || playThread;
  const scroller = React.useCallback(() => scrollRef?.current ?? panelOf(chatRef.current), [scrollRef]);

  const onSend = React.useCallback(
    (segs: Segment[]) => {
      // Snapshot where the greeting (the heading itself, not its grid track) and the chips stood, so they leave from there.
      const c = chatRef.current?.getBoundingClientRect();
      const g = greetRef.current?.querySelector(".jn-greet")?.getBoundingClientRect();
      // A draft has already put the suggestions away (Revision 2), so they only leave with the send if they were still there.
      const sugg = suggestRef.current;
      const s = sugg && getComputedStyle(sugg).visibility !== "hidden" ? sugg.querySelector(".jn-suggest")?.getBoundingClientRect() : undefined;
      const k = composerRef.current?.querySelector(".jn-composer-wrap")?.getBoundingClientRect();
      if (c && g) {
        const at = (r: DOMRect): React.CSSProperties => ({ position: "absolute", left: r.left - c.left, top: r.top - c.top, width: r.width });
        setGhost({ greet: at(g), suggest: s ? at(s) : null, composer: reduced && k ? at(k) : undefined, segs });
      }
      setSent(segs);
      setPhase("thread");
      setJustSent(true);
      setTravel(true);
      setStage("thinking");
      setRevealed(0);
      setPresence(0);
      setSeconds(0);
      setLineShown(false);
      setReceipt(false);
      setStopped(false);
      onPhase?.("thread");
    },
    [onPhase, reduced],
  );

  // The ghost leaves on exit, then is gone.
  React.useEffect(() => {
    if (!ghost) return;
    const t = window.setTimeout(() => setGhost(null), 220);
    return () => window.clearTimeout(t);
  }, [ghost]);

  // The dock composer shares the home composer's layout identity only for the journey, so later changes
  // to its own height (the needs row arriving) never turn into a layout animation.
  React.useEffect(() => {
    if (!travel) return;
    const t = window.setTimeout(() => setTravel(false), 700);
    return () => window.clearTimeout(t);
  }, [travel]);

  // The thread's timeline after a live send.
  React.useEffect(() => {
    if (stillStage || stopped || phase !== "thread" || !live || !auto || stage !== "thinking" || revealed !== 0) return;
    const timers = [
      window.setTimeout(() => setLineShown(true), 200),
      window.setTimeout(() => setReceipt(true), 420),
      window.setTimeout(() => setPresence(1), 1300),
      window.setTimeout(() => setPresence(2), 2400),
      window.setTimeout(() => setSeconds(3), 3200),
      window.setTimeout(() => setStage("streaming"), 3700),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phase, auto, stage, revealed, stillStage, live, stopped]);

  React.useEffect(() => {
    if (stillStage || stopped || stage !== "streaming" || revealed === Infinity) return;
    if (revealed >= ANSWER_WORDS) {
      const t = window.setTimeout(() => setStage("done"), 200);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setRevealed((r) => r + 2), 46);
    return () => window.clearTimeout(t);
  }, [stage, revealed, stillStage, stopped]);

  React.useEffect(() => {
    if (stillStage || stopped || !auto || !live) return;
    const next: Partial<Record<Stage, [Stage, number]>> = { done: ["handoff", 700], handoff: ["task", 1300], task: ["approval", 1500] };
    const n = next[stage];
    if (!n) return;
    const t = window.setTimeout(() => setStage(n[0]), n[1]);
    return () => window.clearTimeout(t);
  }, [stage, auto, stillStage, live, stopped]);

  // On send the person's message is the top of the view, and the view stays there: no chasing the stream.
  React.useEffect(() => {
    if (phase !== "thread" || !live) return;
    const el = scroller();
    if (el) el.scrollTop = 0;
  }, [phase, live, scroller]);

  const home = phase === "home";
  const past = (s: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);
  const needsOut = useNeedsOutOfView(!home && (past("task") || settled), chatRef, scroller, [stage, phase]);
  const showNeeds = React.useCallback(() => {
    const el = chatRef.current?.querySelector(".jn-task[data-waiting], .jn-approve:not([data-outcome])");
    el?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [reduced]);

  // The thread fades in under a reduced send instead of the composer travelling (a 160 ms cross-fade, §1.7).
  const threadIn = reduced && justSent ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: R } : {};

  return (
    <LayoutGroup>
      <div className="jn-chat" data-phase={phase} ref={chatRef}>
        <MobileBar title={home ? undefined : THREAD_TITLE} />
        {home ? <div className="jn-top jn-top--clear" aria-hidden="true" /> : <TopBar title={THREAD_TITLE} />}

        {home ? (
          <div className="jn-home">
            <div className="jn-home__stack">
              {/* On a phone there is no sidebar to carry Mira's ask, so the home says it once, above the greeting (Revision 2). */}
              <a href="#" className="jn-home__attn">
                <CrewMark member={face(MIRA)} state="waiting" size={20} />
                <span>
                  Mira <span className="jn-attn">needs your answer</span>
                </span>
                <Icon name="chevron-right" size={16} />
              </a>
              <div ref={greetRef} className="jn-home__greet">
                <Greeting />
              </div>
              <div ref={composerRef} className="jn-home__composer">
                <Composer initial={initialSegs} layoutId="jn-composer" still={composerStill} onSend={onSend} apiRef={apiRef} fieldId="jn-message" />
              </div>
              <div ref={suggestRef} className="jn-home__suggest">
                <Suggestions />
              </div>
            </div>
          </div>
        ) : (
          <>
            <motion.div className="jn-thread" role="log" aria-relevant="additions" {...threadIn}>
              <UserMessage segments={sent} receipt={receipt ? RECEIPT : null} animateIn={live} />
              {stage === "thinking" ? (
                stopped ? null : lineShown ? <LiveLine text={PRESENCE_WORDS[presence]} seconds={seconds} /> : <div className="jn-live jn-live--slot" aria-hidden="true" />
              ) : (
                <Trace />
              )}
              {stage !== "thinking" ? <Answer revealed={stage === "streaming" ? revealed : Infinity} /> : null}
              {stopped ? (
                <div className="jn-stopped" role="status">
                  <span>{stage === "thinking" ? "Stopped. Nothing was read or posted." : "Stopped. Nothing was posted."}</span>
                  <button
                    type="button"
                    className="jb jb--link"
                    onClick={() => {
                      setStopped(false);
                      dockApi.current?.focus(false);
                    }}
                  >
                    Continue
                  </button>
                </div>
              ) : null}
              {past("done") ? (
                <motion.div initial={live ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={reduced ? R : T.fast}>
                  <MessageActions />
                </motion.div>
              ) : null}
              {stage === "handoff" ? (
                <div className="jn-handoff" role="status">
                  <motion.span className="jn-live__face" layoutId={reduced ? undefined : HANDOFF_FACE_ID} layout="position" transition={SPRING.emphasized}>
                    <CrewMark member={face(MIRA)} state="working" size={24} />
                  </motion.span>
                  <motion.p className="jn-handoff__line" layoutId={reduced ? undefined : HANDOFF_ID} layout="position" transition={SPRING.emphasized}>
                    Mira is checking renewal usage for three accounts
                  </motion.p>
                </div>
              ) : null}
              {past("task") ? (
                <TaskReveal live={live} reduced={reduced}>
                  <TaskCard planOpen={planOpen} handoff={live} />
                </TaskReveal>
              ) : null}
              {past("approval") ? (
                <div className="jn-thread__card">
                  <Approval animate={live} menuOpen={approvalMenu} onInstead={() => dockApi.current?.focus()} />
                </div>
              ) : null}
              <div className="jn-thread__end" ref={endRef} aria-hidden="true" />
            </motion.div>
            <motion.div className="jn-dock" {...threadIn}>
              <JumpToLatest end={endRef} scroller={scroller} streaming={stage === "streaming" && !stopped} onJumped={() => dockApi.current?.focus()} />
              <Composer
                layoutId={travel ? "jn-composer" : undefined}
                variant="dock"
                apiRef={dockApi}
                busy={!stopped && (stage === "thinking" || stage === "streaming")}
                onStop={() => setStopped(true)}
                placeholder="Ask a follow-up"
                label="Message Alevr"
                fieldId="jn-message"
                dockRow={
                  <AnimatePresence initial={false}>
                    {needsOut > 0 ? (
                      <motion.div
                        key="needs"
                        className="jn-dockrow-wrap"
                        initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0, transition: T.exit }}
                        transition={reduced ? R : { duration: 0.24, ease: EASE_OUT }}
                        style={{ overflow: "hidden" }}
                      >
                        <NeedsYouRow count={needsOut} onShow={showNeeds} />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                }
              />
              <p className="jn-dock__note">Alevr can make mistakes. Check what matters.</p>
            </motion.div>
          </>
        )}

        {/* The home leaves from where it stood: the chips first (100 ms), the greeting on exit (160 ms, ease-in). */}
        <AnimatePresence>
          {ghost ? (
            <motion.div key="ghost" className="jn-ghost" aria-hidden="true" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <motion.div style={ghost.greet} initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={reduced ? R : T.exit}>
                <Greeting />
              </motion.div>
              {ghost.suggest ? (
                <motion.div style={ghost.suggest} className="jn-ghost__suggest" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={reduced ? R : { duration: 0.1, ease: EASE_OUT }}>
                  <Suggestions />
                </motion.div>
              ) : null}
              {ghost.composer ? (
                <motion.div style={ghost.composer} initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={R}>
                  <Composer initial={ghost.segs} />
                </motion.div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

/**
 * The task card opens beneath the title that just moved into its header: its
 * box is revealed from the header down (a clip on base), so the card grows out
 * of the line instead of fading in around it. Reduced: a fade.
 */
function TaskReveal({ live, reduced, children }: { live: boolean; reduced: boolean; children: React.ReactNode }) {
  if (!live) return <div className="jn-thread__card">{children}</div>;
  return (
    <motion.div
      className="jn-thread__card"
      initial={reduced ? { opacity: 0 } : { clipPath: "inset(0% 0% 78% 0% round 12px)" }}
      animate={reduced ? { opacity: 1 } : { clipPath: "inset(0% 0% 0% 0% round 12px)" }}
      transition={reduced ? R : { duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Jump to latest (INTERACTION_SPEC M19): a 32 px round button centred on the
 * composer's top edge, shown when the end of the thread is more than 120 px
 * below the view (an IntersectionObserver on the thread's last line, no scroll
 * listener). Its arrow takes the presence ink while new words stream below the
 * fold; no count, no dot. Under two viewports away it scrolls smoothly on
 * `slow`; further, it jumps to one viewport above the end and smooths the
 * rest. Reduced motion: instant. Afterwards focus goes to the composer.
 * Appear and leave: 120 ms opacity with scale 0.96 to 1.
 */
function JumpToLatest({
  end,
  scroller,
  streaming,
  onJumped,
}: {
  end: React.RefObject<HTMLElement | null>;
  scroller: () => HTMLElement | null;
  streaming: boolean;
  onJumped?: () => void;
}) {
  const reduced = useReduced();
  const [away, setAway] = React.useState(false);
  React.useEffect(() => {
    const root = scroller();
    const el = end.current;
    if (!root || !el) return;
    const io = new IntersectionObserver(([e]) => setAway(!e.isIntersecting), { root, rootMargin: "0px 0px 120px 0px", threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [end, scroller]);
  const jump = () => {
    const root = scroller();
    if (!root) return;
    const target = root.scrollHeight - root.clientHeight;
    const far = target - root.scrollTop > root.clientHeight * 2;
    if (reduced) root.scrollTop = target;
    else {
      if (far) root.scrollTop = target - root.clientHeight;
      root.scrollTo({ top: target, behavior: "smooth" });
    }
    onJumped?.();
  };
  return (
    <AnimatePresence>
      {away ? (
        <motion.button
          key="jump"
          type="button"
          className="jn-jump jicon-trigger jicon-quiet jtip"
          data-live={streaming ? "" : undefined}
          aria-label="Jump to latest"
          data-tip="Jump to latest"
          data-kbd="⌘↓"
          aria-keyshortcuts="Meta+ArrowDown"
          initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          transition={T.fast}
          onClick={jump}
        >
          <Icon name="arrow-down" size={16} />
        </motion.button>
      ) : null}
    </AnimatePresence>
  );
}

export function HomeHint() {
  return (
    <span className="jn-hint">
      <Icon name="at" size={16} /> to add context
    </span>
  );
}
