"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { ACCOUNT, DRAFT, MIRA, PRESENCE_WORDS, THREAD_TITLE, type Segment } from "./fixtures";
import { Composer, type ComposerApi, type ComposerStill } from "./composer";
import { Icon } from "./icons";
import { FileMark, SlackMark } from "./marks";
import { EASE_OUT, R, T, useReduced } from "./motion";
import { face, MobileBar, TopBar } from "./shell";
import { ActivityLine, Answer, ANSWER_WORDS, Approval, MessageActions, PresenceLine, TaskCard, UserMessage } from "./thread";

/*
 * Chat, from the empty home to a working thread, as ONE surface, so the first
 * send is a continuous event rather than a page change:
 *
 *   home      the greeting (serif), the composer, three suggestions
 *   leaving   120ms: greeting and suggestions fade and lift 4px; the composer stays
 *   thread    the composer glides to the dock while the sentence rises out of it
 *             into the first message (shared elements on one critically damped
 *             spring); the bubble's tone arrives a beat later, under the words
 *
 * Then Juno's caret stands where the answer will begin and breathes while one
 * line of state updates in place; words arrive and the caret rides them; the
 * task forms; the approval docks on the composer where your hands are.
 */

export type Stage = "thinking" | "streaming" | "done" | "task" | "approval";
const ORDER: Stage[] = ["thinking", "streaming", "done", "task", "approval"];

export function Greeting({ leaving }: { leaving?: boolean }) {
  const reduced = useReduced();
  return (
    <motion.h1
      className="t-greet jn-greet"
      initial={false}
      animate={{ opacity: leaving ? 0 : 1, y: leaving && !reduced ? -4 : 0 }}
      transition={{ duration: 0.12, ease: EASE_OUT }}
    >
      What’s next, {ACCOUNT.first}?
    </motion.h1>
  );
}

/** Three suggestions from the person's own state (§5): who needs them, what moved, what they touched today. */
export function Suggestions() {
  return (
    <div className="jn-suggest">
      <button type="button" className="jn-chip">
        <CrewFace member={face(MIRA)} state="waiting" size={16} />
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
}: {
  initialPhase?: "home" | "thread";
  initialStage?: Stage;
  initialSegs?: Segment[];
  composerStill?: ComposerStill;
  /** After a live send, run the thread's timeline (presence, stream, task, approval). */
  auto?: boolean;
  planOpen?: boolean;
  apiRef?: React.MutableRefObject<ComposerApi | null>;
  onPhase?: (p: string) => void;
  /** The element that scrolls (a motion stage); the page scrolls when omitted. */
  scrollRef?: React.RefObject<HTMLElement | null>;
  /** Freeze the thread at a stage (for stills). */
  stillStage?: { stage: Stage; revealed?: number; presence?: number };
}) {
  const reduced = useReduced();
  const [phase, setPhase] = React.useState<"home" | "leaving" | "thread">(initialPhase);
  const [sent, setSent] = React.useState<Segment[]>(initialPhase === "thread" ? DRAFT : []);
  const [stage, setStage] = React.useState<Stage>(stillStage?.stage ?? (initialPhase === "thread" ? initialStage : "thinking"));
  const [presence, setPresence] = React.useState(stillStage?.presence ?? 0);
  const [revealed, setRevealed] = React.useState(stillStage?.revealed ?? (initialPhase === "thread" ? Infinity : 0));
  const dockApi = React.useRef<ComposerApi | null>(null);

  const onSend = React.useCallback(
    (segs: Segment[]) => {
      setSent(segs);
      setPhase("leaving");
      onPhase?.("leaving");
    },
    [onPhase],
  );

  // leaving → thread
  React.useEffect(() => {
    if (phase !== "leaving") return;
    const t = window.setTimeout(
      () => {
        setPhase("thread");
        setStage("thinking");
        setRevealed(0);
        setPresence(0);
        onPhase?.("thread");
      },
      reduced ? 0 : 120,
    );
    return () => window.clearTimeout(t);
  }, [phase, reduced, onPhase]);

  // The thread's timeline after a live send.
  React.useEffect(() => {
    if (stillStage || phase !== "thread" || !auto || stage !== "thinking" || revealed !== 0) return;
    const timers = [
      window.setTimeout(() => setPresence(1), 1100),
      window.setTimeout(() => setPresence(2), 1900),
      window.setTimeout(() => setStage("streaming"), 2700),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phase, auto, stage, revealed, stillStage]);

  React.useEffect(() => {
    if (stillStage || stage !== "streaming") return;
    if (revealed >= ANSWER_WORDS) {
      const t = window.setTimeout(() => setStage("done"), 260);
      return () => window.clearTimeout(t);
    }
    // Calm pacing: two words every 46ms, a slightly longer breath at block ends is implicit in the markup.
    const t = window.setTimeout(() => setRevealed((r) => r + 2), 46);
    return () => window.clearTimeout(t);
  }, [stage, revealed, stillStage]);

  React.useEffect(() => {
    if (stillStage || !auto) return;
    if (stage === "done") {
      const t = window.setTimeout(() => setStage("task"), 520);
      return () => window.clearTimeout(t);
    }
    if (stage === "task") {
      const t = window.setTimeout(() => setStage("approval"), 1500);
      return () => window.clearTimeout(t);
    }
  }, [stage, auto, stillStage]);

  // Keep the newest thing in view while the thread grows.
  React.useEffect(() => {
    if (phase !== "thread" || initialPhase === "thread") return;
    const el = scrollRef?.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [phase, stage, revealed, initialPhase, scrollRef, reduced]);

  const home = phase === "home" || phase === "leaving";
  const past = (s: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);
  const live = initialPhase !== "thread";

  return (
    <LayoutGroup>
      <div className="jn-chat" data-phase={phase}>
        <MobileBar title={home ? undefined : THREAD_TITLE} />
        {home ? <div className="jn-top jn-top--clear" aria-hidden="true" /> : <TopBar title={THREAD_TITLE} />}

        {home ? (
          <div className="jn-home">
            <div className="jn-home__stack">
              <Greeting leaving={phase === "leaving"} />
              <Composer initial={initialSegs} layoutId="jn-composer" sentenceLayoutId="jn-sentence" still={composerStill} onSend={onSend} apiRef={apiRef} />
              <motion.div initial={false} animate={{ opacity: phase === "leaving" ? 0 : 1 }} transition={{ duration: 0.1, ease: EASE_OUT }}>
                <Suggestions />
              </motion.div>
            </div>
          </div>
        ) : (
          <>
            <div className="jn-thread">
              <UserMessage segments={sent} layoutId="jn-sentence" animateIn={live} />
              <AnimatePresence mode="wait" initial={false}>
                {stage === "thinking" ? (
                  <motion.div key="presence" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, delay: live ? 0.18 : 0 }}>
                    <PresenceLine text={PRESENCE_WORDS[presence]} />
                  </motion.div>
                ) : (
                  <motion.div key="activity" initial={live ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
                    <ActivityLine />
                  </motion.div>
                )}
              </AnimatePresence>
              {stage !== "thinking" ? <Answer revealed={stage === "streaming" ? revealed : Infinity} /> : null}
              {past("done") ? (
                <motion.div initial={live ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={reduced ? R : T.fade}>
                  <MessageActions />
                </motion.div>
              ) : null}
              {past("task") ? (
                <motion.div
                  initial={live ? { opacity: 0, y: reduced ? 0 : 8 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduced ? R : { duration: 0.24, ease: EASE_OUT }}
                >
                  <TaskCard planOpen={planOpen} />
                </motion.div>
              ) : null}
            </div>
            <div className="jn-dock">
              <Composer
                layoutId="jn-composer"
                variant="dock"
                apiRef={dockApi}
                busy={stage === "thinking" || stage === "streaming"}
                placeholder={past("approval") ? "Tell Juno what to do instead" : "Reply to Juno"}
                approval={past("approval") ? <Approval animate={live} onInstead={() => dockApi.current?.focus()} /> : null}
              />
              <p className="jn-dock__note">Juno can make mistakes. Check what matters.</p>
            </div>
          </>
        )}
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
