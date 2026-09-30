"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Pencil, RotateCcw, Share2, ThumbsUp } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Face } from "./face";
import { ANSWER_TABLE, MIRA, MIRA_PLAN, SLACK_POST } from "./fixtures";
import { Lens, PresenceLine } from "./lens";
import { SlackColor } from "./marks";
import { Token, type Seg } from "./composer";
import { DUR, EASE_OUT } from "./tokens";

/*
 * The conversation. Reading type at 15.5/25 on a 68ch measure; the answer has
 * no bubble and no avatar (Juno is the page); the person's message is a quiet
 * filled block on the right that keeps its tokens. A task and an approval are
 * the only cards, because they are live objects you act on.
 */

export function UserMessage({ segs, className, style }: { segs: Seg[]; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("in-user-msg", className)} style={style} data-user-msg="">
      {segs.map((s, i) =>
        s.t === "text" ? (
          <span key={i} className="whitespace-pre-wrap">
            {s.v}
          </span>
        ) : (
          <Token key={s.key} id={s.id} size="sm" />
        ),
      )}
    </div>
  );
}

export function ToolLine({ open = false }: { open?: boolean }) {
  return (
    <button type="button" className="in-tool-line" aria-expanded={open}>
      {open ? <ChevronDown size={14} motion="none" /> : <ChevronRight size={14} motion="none" />}
      <span>Read 3 files and searched the web</span>
      <span className="in-mono in-fs-115">14s</span>
    </button>
  );
}

export function AnswerBody() {
  return (
    <div className="in-answer">
      <h3>Renewal risk this quarter</h3>
      <p>
        Stripe shows <strong>€412,000</strong> of the <strong>€438,000</strong> the forecast expects from renewals. Three accounts make up the gap:
      </p>
      <ul>
        <li>
          <strong>Halvorsen</strong> moved to monthly billing in August and has not renewed the annual plan.
        </li>
        <li>
          <strong>Brightline Studio</strong> dropped two seats on 12 September.
        </li>
        <li>
          <strong>Oakridge Health</strong> has an unpaid invoice from July.
        </li>
      </ul>
      <table className="in-table">
        <thead>
          <tr>
            <th>Account</th>
            <th data-num="">Forecast</th>
            <th data-num="">Stripe</th>
            <th data-num="">Gap</th>
          </tr>
        </thead>
        <tbody>
          {ANSWER_TABLE.map((r) => (
            <tr key={r.account}>
              <td>{r.account}</td>
              <td data-num="">{r.forecast}</td>
              <td data-num="">{r.stripe}</td>
              <td data-num="">{r.gap}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4">
        I&apos;ve asked Mira to check usage on all three and flag the ones worth a call. The source is the <a href="#stripe">September subscriptions export</a>.
      </p>
    </div>
  );
}

export function MessageActions() {
  return (
    <div className="in-actions" aria-label="Message actions">
      {[
        { icon: Copy, label: "Copy" },
        { icon: ThumbsUp, label: "Good answer" },
        { icon: RotateCcw, label: "Try again" },
        { icon: Share2, label: "Share" },
      ].map(({ icon: Icon, label }) => (
        <button key={label} type="button" className="in-iconbtn" data-size="sm" aria-label={label}>
          <Icon size={15} motion="none" />
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The live task: what it is doing, what needs you, progress, plan (§9)
 * ------------------------------------------------------------------------- */

export function TaskCard({ answered: answeredProp, planOpen: planOpenProp = false }: { answered?: string; planOpen?: boolean }) {
  const reduce = useReducedMotion();
  const [answered, setAnswered] = React.useState<string | undefined>(answeredProp);
  const [planOpen, setPlanOpen] = React.useState(planOpenProp);
  const done = MIRA_PLAN.filter((p) => p.state === "done").length;
  return (
    <section className="in-card" aria-label="Task: Mira is checking renewal risk">
      <div className="in-card__row flex items-start gap-3">
        <Face face={MIRA.face} presence={answered ? "working" : "waiting"} size={24} name="Mira" className="mt-px" />
        <div className="min-w-0 flex-1">
          <p className="in-fs-145 leading-[22px]">Mira is checking usage for the three accounts</p>
          <p className="mt-0.5 in-t-small in-ink-3">
            Task in this chat · started <span className="in-mono">10:42</span>
          </p>
        </div>
        <button type="button" className="in-btn -mr-1.5 -mt-1" data-variant="ghost" data-size="sm">
          Stop
        </button>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {!answered ? (
          <motion.div
            key="ask"
            className="in-card__row"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : DUR.panel, ease: EASE_OUT }}
          >
            <p className="in-fs-145 leading-[22px]">
              <span className="in-amber in-medium">Needs you </span>
              Oakridge Health owes €600 from July. Flag it for a call, or leave it to the invoice reminder?
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="in-btn" data-variant="secondary" onClick={() => setAnswered("Flag it")}>
                Flag it for a call
              </button>
              <button type="button" className="in-btn" data-variant="secondary" onClick={() => setAnswered("Leave it")}>
                Leave it to the reminder
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="answered"
            className="in-card__row"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : DUR.panel, ease: EASE_OUT }}
          >
            <p className="in-t-ui in-ink-2">
              You answered <span className="in-ink">{answered}</span>. Mira carried on.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="in-card__row">
        <div className="flex items-center gap-3">
          <span className="in-steps" aria-hidden="true">
            {MIRA_PLAN.map((p, i) => (
              <i key={i} data-state={p.state} />
            ))}
          </span>
          <p className="min-w-0 flex-1 truncate in-t-ui">
            <span className="in-mono in-fs-12 in-ink-3">
              {done + 1}/{MIRA_PLAN.length}
            </span>{" "}
            <span className="in-ink-2">Matching Stripe customers to accounts</span>
          </p>
          <button type="button" className="in-disclosure" aria-expanded={planOpen} onClick={() => setPlanOpen((o) => !o)}>
            Plan
            <ChevronDown size={12} motion="none" style={{ transform: planOpen ? "rotate(180deg)" : undefined, transition: "transform 180ms cubic-bezier(0.2,0.8,0.2,1)" }} />
          </button>
        </div>
        <AnimatePresence initial={false}>
          {planOpen ? (
            <motion.ol
              className="mt-2 overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduce ? 0 : DUR.panel, ease: EASE_OUT }}
            >
              {MIRA_PLAN.map((p, i) => (
                <li key={p.title} className="flex items-center gap-3 py-1 in-t-ui">
                  <span className="in-mono w-4 text-right in-fs-115 in-ink-3">{i + 1}</span>
                  <span className={cn(p.state === "done" ? "in-ink-3 line-through decoration-[var(--in-ink-4)]" : p.state === "active" ? "in-ink" : "in-ink-2")}>{p.title}</span>
                </li>
              ))}
            </motion.ol>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * The approval: Deny first, Allow once, Always for Slack, or say what instead
 * ------------------------------------------------------------------------- */

export function Approval({ decided: decidedProp }: { decided?: string }) {
  const reduce = useReducedMotion();
  const [decided, setDecided] = React.useState<string | undefined>(decidedProp);
  return (
    <section className="in-card" aria-label="Approval: post to Slack">
      <div className="in-card__row">
        <div className="flex items-center gap-2.5">
          <SlackColor size={16} />
          <p className="in-fs-145 leading-[22px]">
            Post the summary to <span className="in-medium">#design</span> in Slack?
          </p>
        </div>
        <div className="in-well mt-3 px-3.5 py-3 in-fs-14 leading-[22px] in-ink-2">{SLACK_POST}</div>
      </div>
      <div className="in-card__row">
        <AnimatePresence initial={false} mode="wait">
          {decided ? (
            <motion.p
              key="done"
              className="in-t-ui in-ink-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : DUR.panel }}
            >
              {decided}
            </motion.p>
          ) : (
            <motion.div
              key="ask"
              className="flex flex-wrap items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : DUR.panel }}
            >
              <button type="button" className="in-btn" data-variant="secondary" onClick={() => setDecided("Denied. Nothing was posted.")}>
                Deny
              </button>
              <button type="button" className="in-btn" data-variant="solid" onClick={() => setDecided("Posted to #design at 10:47.")}>
                Allow once
              </button>
              <button type="button" className="in-btn" data-variant="ghost" onClick={() => setDecided("Posted. Slack posts will not ask again.")}>
                Always for Slack
              </button>
              <span className="flex-1" />
              <button type="button" className="in-btn" data-variant="ghost">
                <Pencil size={14} motion="none" />
                Tell Juno what to do instead
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

export function ThreadHeader({ title, compact }: { title: string; compact?: boolean }) {
  return (
    <header className="in-thread-head">
      <p className="min-w-0 flex-1 truncate in-fs-135">{title}</p>
      {!compact ? (
        <>
          <button type="button" className="in-btn" data-variant="ghost" data-size="sm">
            <Share2 size={14} motion="none" />
            Share
          </button>
          <button type="button" className="in-iconbtn" data-size="sm" aria-label="More">
            <MoreHorizontal size={16} motion="none" />
          </button>
        </>
      ) : null}
    </header>
  );
}

/* ---------------------------------------------------------------------------
 * Streaming: calm. New words arrive by opacity only (220ms), in reading order,
 * a few at a time; nothing bounces, slides or blurs.
 * ------------------------------------------------------------------------- */

export function StreamingText({ text, playing, onDone, wordsPerTick = 2, tickMs = 70 }: { text: string; playing: boolean; onDone?: () => void; wordsPerTick?: number; tickMs?: number }) {
  const words = React.useMemo(() => text.split(/(\s+)/), [text]);
  const [shown, setShown] = React.useState(playing ? 0 : words.length);
  const reduce = useReducedMotion();
  React.useEffect(() => {
    if (!playing) return;
    setShown(0);
    let n = 0;
    const id = window.setInterval(() => {
      n += wordsPerTick * 2;
      setShown(Math.min(n, words.length));
      if (n >= words.length) {
        window.clearInterval(id);
        onDone?.();
      }
    }, reduce ? 20 : tickMs);
    return () => window.clearInterval(id);
  }, [playing, words.length, wordsPerTick, tickMs, onDone, reduce]);
  return (
    <>
      {words.slice(0, shown).map((w, i) => (
        <span key={i} className={reduce ? undefined : "in-stream-word"}>
          {w}
        </span>
      ))}
    </>
  );
}

export function ThinkingRow({ state = "thinking", label = "Thinking" }: { state?: "thinking" | "working"; label?: string }) {
  return <PresenceLine state={state}>{label}</PresenceLine>;
}

export { Lens };
