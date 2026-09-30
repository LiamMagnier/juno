"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { ACCOUNT, DRAFT, MIRA, PRESENCE_WORDS, RECEIPT, THREAD_TITLE, type Segment } from "./fixtures";
import { Composer, type ComposerApi, type ComposerStill } from "./composer";
import { Icon } from "./icons";
import { FileMark, SlackMark } from "./marks";
import { R, SPRING, T, useReduced } from "./motion";
import { face, MobileBar, TopBar } from "./shell";
import { Answer, ANSWER_WORDS, Approval, HANDOFF_ID, LiveLine, MessageActions, NeedsYouRow, TaskCard, Trace, UserMessage } from "./thread";

/*
 * Chat, from the empty home to a working thread, as ONE surface, so the first
 * send is a continuous event rather than a page change (C12, C18, M1, M2, T1):
 *
 *   send      in the same frame the person's turn is drawn in its final place
 *             (a 120 ms settle from 0.6 opacity); the greeting and suggestions
 *             leave on exit (160 ms, ease-in); the composer travels from the
 *             centre to the dock on the layout spring (0.36 s, no bounce).
 *   wait      after 200 ms, the live line in the presence colour says what Juno
 *             is doing; after 3 s it counts seconds.
 *   answer    the first word replaces the line in the same frame; words fade in
 *             where they stay (160 ms each); the trace folds into one line.
 *   hand-off  the line that says what Mira is doing becomes the task card's
 *             title (emphasized spring), and the card opens beneath it.
 *   approval  the approval card arrives (base, 6 px rise) and arms after 500 ms.
 */

export type Stage = "thinking" | "streaming" | "done" | "handoff" | "task" | "approval";
const ORDER: Stage[] = ["thinking", "streaming", "done", "handoff", "task", "approval"];

export function Greeting() {
  return <h1 className="t-greet jn-greet">What’s next, {ACCOUNT.first}?</h1>;
}

/** Up to three suggestions from the person's own state (§3.3): who needs them, what moved, what they touched today. */
export function Suggestions() {
  return (
    <div className="jn-suggest">
      <button type="button" className="jn-chip">
        <CrewFace member={face(MIRA)} state="waiting" size={16} live={false} />
        Answer Mira on Halvorsen
      </button>
      <button type="button" className="jn-chip">
        <SlackMark size={15} />
        Catch up on #design
      </button>
      <button type="button" className="jn-chip">
        <FileMark name="Board deck, October.pdf" size={16} />
        Finish the board deck
      </button>
    </div>
  );
}

type Ghost = { greet: React.CSSProperties; suggest: React.CSSProperties } | null;

export function ChatSurface({
  initialPhase = "home",
  initialStage = "approval",
  initialSegs = DRAFT,
  composerStill,
  auto = true,
  planOpen = false,
  apiRef,
  onPhase,
  scrollRef,
  stillStage,
  dockNeeds = false,
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
  /** The element that scrolls (a motion stage); the page scrolls when omitted. */
  scrollRef?: React.RefObject<HTMLElement | null>;
  /** Freeze the thread at a stage (for stills). */
  stillStage?: { stage: Stage; revealed?: number; presence?: number; seconds?: number };
  /** Show the dock's needs-you row (the task card is out of view). */
  dockNeeds?: boolean;
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
  const dockApi = React.useRef<ComposerApi | null>(null);
  const chatRef = React.useRef<HTMLDivElement | null>(null);
  const greetRef = React.useRef<HTMLDivElement | null>(null);
  const suggestRef = React.useRef<HTMLDivElement | null>(null);
  const live = initialPhase !== "thread" || playThread;

  const onSend = React.useCallback(
    (segs: Segment[]) => {
      // Snapshot where the greeting and suggestions stood, so they can leave from there while the thread takes the page.
      const c = chatRef.current?.getBoundingClientRect();
      const g = greetRef.current?.getBoundingClientRect();
      const s = suggestRef.current?.getBoundingClientRect();
      if (c && g && s) {
        const at = (r: DOMRect): React.CSSProperties => ({ position: "absolute", left: r.left - c.left, top: r.top - c.top, width: r.width });
        setGhost({ greet: at(g), suggest: at(s) });
      }
      setSent(segs);
      setPhase("thread");
      setStage("thinking");
      setRevealed(0);
      setPresence(0);
      setSeconds(0);
      setLineShown(false);
      setReceipt(false);
      onPhase?.("thread");
    },
    [onPhase],
  );

  // The ghost leaves on exit, then is gone.
  React.useEffect(() => {
    if (!ghost) return;
    const t = window.setTimeout(() => setGhost(null), 200);
    return () => window.clearTimeout(t);
  }, [ghost]);

  // The thread's timeline after a live send.
  React.useEffect(() => {
    if (stillStage || phase !== "thread" || !live || !auto || stage !== "thinking" || revealed !== 0) return;
    const timers = [
      window.setTimeout(() => setLineShown(true), 200),
      window.setTimeout(() => setReceipt(true), 420),
      window.setTimeout(() => setPresence(1), 1300),
      window.setTimeout(() => setPresence(2), 2400),
      window.setTimeout(() => setSeconds(3), 3200),
      window.setTimeout(() => setStage("streaming"), 3700),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phase, auto, stage, revealed, stillStage, live]);

  React.useEffect(() => {
    if (stillStage || stage !== "streaming" || revealed === Infinity) return;
    if (revealed >= ANSWER_WORDS) {
      const t = window.setTimeout(() => setStage("done"), 200);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setRevealed((r) => r + 2), 46);
    return () => window.clearTimeout(t);
  }, [stage, revealed, stillStage]);

  React.useEffect(() => {
    if (stillStage || !auto || !live) return;
    const next: Partial<Record<Stage, [Stage, number]>> = { done: ["handoff", 700], handoff: ["task", 1300], task: ["approval", 1500] };
    const n = next[stage];
    if (!n) return;
    const t = window.setTimeout(() => setStage(n[0]), n[1]);
    return () => window.clearTimeout(t);
  }, [stage, auto, stillStage, live]);

  // Keep the newest thing in view while a live thread grows.
  React.useEffect(() => {
    if (phase !== "thread" || !live) return;
    const el = scrollRef?.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [phase, stage, revealed, live, scrollRef, reduced]);

  const home = phase === "home";
  const past = (s: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);

  return (
    <LayoutGroup>
      <div className="jn-chat" data-phase={phase} ref={chatRef}>
        <MobileBar title={home ? undefined : THREAD_TITLE} />
        {home ? <div className="jn-top jn-top--clear" aria-hidden="true" /> : <TopBar title={THREAD_TITLE} />}

        {home ? (
          <div className="jn-home">
            <div className="jn-home__stack">
              <div ref={greetRef} className="jn-home__greet">
                <Greeting />
              </div>
              <Composer initial={initialSegs} layoutId="jn-composer" still={composerStill} onSend={onSend} apiRef={apiRef} />
              <div ref={suggestRef} className="jn-home__suggest">
                <Suggestions />
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="jn-thread" role="log" aria-relevant="additions">
              <UserMessage segments={sent} receipt={receipt ? RECEIPT : null} animateIn={live} />
              {stage === "thinking" ? (
                lineShown ? <LiveLine text={PRESENCE_WORDS[presence]} seconds={seconds} /> : <div className="jn-live jn-live--slot" aria-hidden="true" />
              ) : (
                <Trace />
              )}
              {stage !== "thinking" ? <Answer revealed={stage === "streaming" ? revealed : Infinity} /> : null}
              {past("done") ? (
                <motion.div initial={live ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={reduced ? R : T.fast}>
                  <MessageActions />
                </motion.div>
              ) : null}
              {stage === "handoff" ? (
                <div className="jn-handoff">
                  <span className="jn-live__face">
                    <CrewFace member={face(MIRA)} state="working" size={16} live={false} />
                  </span>
                  <motion.p className="jn-live jn-handoff__line" layoutId={reduced ? undefined : HANDOFF_ID} transition={SPRING.emphasized} role="status">
                    Mira is checking renewal usage for three accounts
                  </motion.p>
                </div>
              ) : null}
              {past("task") ? (
                <motion.div
                  initial={live ? { opacity: 0 } : false}
                  animate={{ opacity: 1 }}
                  transition={reduced ? R : { duration: 0.22, ease: [0.33, 1, 0.68, 1] }}
                  className="jn-thread__card"
                >
                  <TaskCard planOpen={planOpen} handoff={live} />
                </motion.div>
              ) : null}
              {past("approval") ? (
                <div className="jn-thread__card">
                  <Approval animate={live} menuOpen={approvalMenu} onInstead={() => dockApi.current?.focus()} />
                </div>
              ) : null}
            </div>
            <div className="jn-dock">
              <Composer
                layoutId="jn-composer"
                variant="dock"
                apiRef={dockApi}
                busy={stage === "thinking" || stage === "streaming"}
                placeholder="Reply…"
                label="Message Juno"
                dockRow={dockNeeds ? <NeedsYouRow /> : null}
              />
              <p className="jn-dock__note">Juno can make mistakes. Check what matters.</p>
            </div>
          </>
        )}

        {/* The greeting and suggestions leave from where they stood (exit: 160 ms, ease-in). */}
        <AnimatePresence>
          {ghost ? (
            <motion.div key="ghost" className="jn-ghost" aria-hidden="true" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={reduced ? R : T.exit}>
              <div style={ghost.greet}>
                <Greeting />
              </div>
              <div style={ghost.suggest}>
                <Suggestions />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

export function HomeHint() {
  return (
    <span className="jn-hint">
      <Icon name="at" size={16} /> to add context
    </span>
  );
}
