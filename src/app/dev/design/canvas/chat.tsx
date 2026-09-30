"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { FileText, MoreHorizontal, Share2 } from "@/components/ui/icons";
import { DRAFT, MIRA, THREAD_TITLE, type Segment } from "./fixtures";
import { Face } from "./face";
import { SlackColor } from "./marks";
import { Composer, Sentence, type ComposerApi, type ComposerStill } from "./composer";
import { ActivityLine, Answer, ANSWER_WORDS, Approval, MessageActions, PresenceLine, TaskCard } from "./thread";
import { MobileBar } from "./shell";
import { EASE_OUT, T, useReduced } from "./motion-pref";

/*
 * Chat, from the empty canvas to a working thread, as ONE surface so the
 * first send is a continuous event rather than a page change:
 *
 *   home      the canvas (points), the greeting, three suggestions, the composer
 *   leaving   120ms: greeting, suggestions and points fade; the composer stays
 *   thread    the composer glides to the dock and the sentence rises out of it
 *             into the first message (shared elements, one curve, 320ms)
 *
 * Then Juno's presence (the point walking, plus what it is doing in words),
 * a calm word-by-word reveal, the task, and the approval on the composer.
 */

export type Stage = "thinking" | "streaming" | "done" | "task" | "approval";

const PRESENCE_WORDS = ["Reading Q3 Forecast.xlsx", "Checking Stripe subscriptions", "Comparing renewals with the forecast"];

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
}: {
  initialPhase?: "home" | "thread";
  initialStage?: Stage;
  initialSegs?: Segment[];
  composerStill?: ComposerStill;
  /** After send, run the thread's timeline (presence, stream, task, approval). */
  auto?: boolean;
  planOpen?: boolean;
  apiRef?: React.MutableRefObject<ComposerApi | null>;
  onPhase?: (p: string) => void;
  /** The element that scrolls (a stage); the page scrolls when omitted. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const reduced = useReduced();
  const [phase, setPhase] = React.useState<"home" | "leaving" | "thread">(initialPhase);
  const [sent, setSent] = React.useState<Segment[]>(initialPhase === "thread" ? DRAFT : []);
  const [stage, setStage] = React.useState<Stage>(initialPhase === "thread" ? initialStage : "thinking");
  const [presence, setPresence] = React.useState(0);
  const [revealed, setRevealed] = React.useState(initialPhase === "thread" ? Infinity : 0);

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
    const t = window.setTimeout(() => {
      setPhase("thread");
      setStage("thinking");
      setRevealed(0);
      setPresence(0);
      onPhase?.("thread");
    }, reduced ? 0 : 130);
    return () => window.clearTimeout(t);
  }, [phase, reduced, onPhase]);

  // The thread's timeline after a live send.
  React.useEffect(() => {
    if (phase !== "thread" || !auto || stage !== "thinking" || revealed !== 0) return;
    const timers = [
      window.setTimeout(() => setPresence(1), 1100),
      window.setTimeout(() => setPresence(2), 1900),
      window.setTimeout(() => setStage("streaming"), 2600),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [phase, auto, stage, revealed]);

  React.useEffect(() => {
    if (stage !== "streaming") return;
    if (revealed >= ANSWER_WORDS) {
      const t = window.setTimeout(() => setStage("done"), 250);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setRevealed((r) => r + 2), 42);
    return () => window.clearTimeout(t);
  }, [stage, revealed]);

  React.useEffect(() => {
    if (!auto) return;
    if (stage === "done") {
      const t = window.setTimeout(() => setStage("task"), 500);
      return () => window.clearTimeout(t);
    }
    if (stage === "task") {
      const t = window.setTimeout(() => setStage("approval"), 1400);
      return () => window.clearTimeout(t);
    }
  }, [stage, auto]);

  // Keep the newest thing in view while the thread grows.
  React.useEffect(() => {
    if (phase !== "thread" || initialPhase === "thread") return;
    const el = scrollRef?.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [phase, stage, revealed, initialPhase, scrollRef, reduced]);

  const home = phase === "home" || phase === "leaving";
  const past = (s: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);

  return (
    <LayoutGroup>
      <div className="cv-chat" data-phase={phase}>
        <motion.div
          className="cv-gridlayer"
          aria-hidden="true"
          initial={false}
          animate={{ opacity: home && phase !== "leaving" ? 1 : 0 }}
          transition={reduced ? T.instant : { duration: 0.28, ease: EASE_OUT }}
        />
        <MobileBar title={home ? "Juno" : THREAD_TITLE} thread={!home} clear={home} />
        {home ? (
          <div className="cv-top" data-clear="" aria-hidden="true" />
        ) : (
          <motion.header className="cv-top" initial={initialPhase === "thread" ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={T.fade}>
            <span className="cv-top__title">{THREAD_TITLE}</span>
            <span className="cv-top__actions">
              <button type="button" className="cv-ibtn" aria-label="Share">
                <Share2 className="cv-i" />
              </button>
              <button type="button" className="cv-ibtn" aria-label="More">
                <MoreHorizontal className="cv-i" />
              </button>
            </span>
          </motion.header>
        )}

        {home ? (
          <div className="cv-home">
            <motion.h1
              className="cv-greet"
              initial={false}
              animate={{ opacity: phase === "leaving" ? 0 : 1, y: phase === "leaving" && !reduced ? -6 : 0 }}
              transition={{ duration: 0.12, ease: EASE_OUT }}
            >
              What’s next, Liam?
            </motion.h1>
            <Composer
              initial={initialSegs}
              layoutId="cv-composer"
              sentenceLayoutId="cv-sentence"
              still={composerStill}
              onSend={onSend}
              apiRef={apiRef}
            />
            <motion.div
              className="cv-chips"
              initial={false}
              animate={{ opacity: phase === "leaving" ? 0 : 1 }}
              transition={{ duration: 0.1, ease: EASE_OUT }}
            >
              <Suggestions />
            </motion.div>
          </div>
        ) : (
          <>
            <div className="cv-thread">
              <div className="cv-sheet">
                <motion.div
                  className="cv-sheet__bg"
                  initial={initialPhase === "thread" ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={reduced ? T.instant : { duration: 0.24, delay: 0.14, ease: EASE_OUT }}
                />
                <Sentence segments={sent} layoutId="cv-sentence" />
              </div>
              <AnimatePresence mode="wait" initial={false}>
                {stage === "thinking" ? (
                  <motion.div key="presence" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, delay: 0 }}>
                    <PresenceLine text={PRESENCE_WORDS[presence]} />
                  </motion.div>
                ) : (
                  <motion.div key="activity" initial={initialPhase === "thread" ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
                    <ActivityLine />
                  </motion.div>
                )}
              </AnimatePresence>
              {stage !== "thinking" ? <Answer revealed={stage === "streaming" ? revealed : Infinity} /> : null}
              {past("done") ? (
                <motion.div initial={initialPhase === "thread" ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={T.fade}>
                  <MessageActions />
                </motion.div>
              ) : null}
              {past("task") ? (
                <motion.div
                  initial={initialPhase === "thread" ? false : { opacity: 0, y: reduced ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduced ? T.fade : { duration: 0.24, ease: EASE_OUT }}
                >
                  <TaskCard planOpen={planOpen} />
                </motion.div>
              ) : null}
            </div>
            <div className="cv-dock">
              <div className="cv-dock__fade" />
              <Composer
                layoutId="cv-composer"
                placeholder={past("approval") ? "Tell Juno what to do instead" : "Reply to Juno"}
                approval={past("approval") ? <Approval animate={initialPhase !== "thread"} /> : null}
              />
            </div>
          </>
        )}
      </div>
    </LayoutGroup>
  );
}

const ORDER: Stage[] = ["thinking", "streaming", "done", "task", "approval"];

/** Three suggestions derived from the person's own state (§5): who needs them, what just connected, what they touched today. */
export function Suggestions() {
  return (
    <>
      <button type="button" className="cv-chip" data-face-host="">
        <Face member={MIRA} presence="waiting" size={16} />
        Answer Mira on Halvorsen
      </button>
      <button type="button" className="cv-chip">
        <SlackColor className="cv-mark" />
        Catch up on #design
      </button>
      <button type="button" className="cv-chip" data-face-host="">
        <FileText className="cv-i" />
        Read Scout’s forecast notes
      </button>
    </>
  );
}

