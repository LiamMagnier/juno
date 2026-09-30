"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { ANSWER_CLOSE, ANSWER_INTRO, ANSWER_LIST, ANSWER_TABLE, MIRA, MIRA_PLAN, READS, SLACK_POST, type Segment } from "./fixtures";
import { Sentence } from "./composer";
import { Icon } from "./icons";
import { SlackMark } from "./marks";
import { R, T, useReduced } from "./motion";
import { face } from "./shell";

/* ————————————————————————— Juno's presence: the caret ————————————————————————— */

/*
 * Juno's presence is a caret in the presence colour, standing where the answer
 * will begin. While Juno thinks it breathes (opacity only, 1.4s); when words
 * arrive it rides at the end of them, steady; when the answer is done it fades.
 * One object carries the whole wait, so the eye never has to find a new thing.
 */
export function JunoCaret({ state }: { state: "thinking" | "streaming" | "voice" }) {
  return <span className="jn-jcaret" data-state={state} aria-hidden="true" />;
}

export function PresenceLine({ text }: { text: string }) {
  const reduced = useReduced();
  return (
    <div className="jn-presence" role="status" aria-live="polite">
      <JunoCaret state="thinking" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          className="jn-presence__text"
          initial={{ opacity: 0, y: reduced ? 0 : 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -3 }}
          transition={reduced ? R : { duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

/* ———————————————————————— The user's message ———————————————————————— */

export function UserMessage({ segments, layoutId, bgDelay = 0.12, animateIn = false }: { segments: Segment[]; layoutId?: string; bgDelay?: number; animateIn?: boolean }) {
  const reduced = useReduced();
  return (
    <div className="jn-umsg">
      <div className="jn-umsg__bubble">
        <motion.span
          className="jn-umsg__bg"
          aria-hidden="true"
          initial={animateIn ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={reduced ? R : { duration: 0.22, delay: bgDelay, ease: [0.2, 0, 0, 1] }}
        />
        <Sentence segments={segments} layoutId={layoutId} still />
      </div>
    </div>
  );
}

/* ———————————————————————— The answer, as blocks of words ———————————————————————— */

type Run = { t: string; b?: boolean };
type Block = { k: "h"; runs: Run[] } | { k: "p"; runs: Run[] } | { k: "li"; runs: Run[] } | { k: "table" };

function boldNumbers(text: string): Run[] {
  return text
    .split(/(€412,000|€438,000)/)
    .filter(Boolean)
    .map((t) => ({ t, b: t.startsWith("€4") }));
}

const BLOCKS: Block[] = [
  { k: "h", runs: [{ t: "Renewal risk this quarter" }] },
  { k: "p", runs: boldNumbers(ANSWER_INTRO) },
  ...ANSWER_LIST.map((it): Block => ({ k: "li", runs: [{ t: it.lead, b: true }, { t: ` ${it.rest}` }] })),
  { k: "table" },
  { k: "p", runs: [{ t: ANSWER_CLOSE }] },
];

function wordsOf(runs: Run[]): { w: string; b?: boolean }[] {
  return runs.flatMap((r) =>
    r.t
      .split(/(?<=\s)/)
      .filter(Boolean)
      .map((w) => ({ w, b: r.b })),
  );
}
const BLOCK_WORDS = BLOCKS.map((b) => (b.k === "table" ? 6 : wordsOf(b.runs).length));
export const ANSWER_WORDS = BLOCK_WORDS.reduce((a, b) => a + b, 0);

function Words({ runs, shown, caret }: { runs: Run[]; shown: number; caret?: boolean }) {
  const words = wordsOf(runs);
  if (shown >= words.length && !caret) {
    return <>{runs.map((r, i) => (r.b ? <strong key={i}>{r.t}</strong> : <React.Fragment key={i}>{r.t}</React.Fragment>))}</>;
  }
  // Streaming: each word fades in where it will stay (140ms). No slide, no blur, no bounce.
  return (
    <>
      {words.slice(0, shown).map((x, i) =>
        x.b ? (
          <strong key={i} className="jn-w">
            {x.w}
          </strong>
        ) : (
          <span key={i} className="jn-w">
            {x.w}
          </span>
        ),
      )}
      {caret ? <JunoCaret state="streaming" /> : null}
    </>
  );
}

export function Answer({ revealed = Infinity }: { revealed?: number }) {
  let budget = revealed;
  const streaming = revealed !== Infinity && revealed < ANSWER_WORDS;
  const items: React.ReactNode[] = [];
  const listItems: React.ReactNode[] = [];
  const flushList = (key: string) => {
    if (listItems.length) items.push(<ul key={key}>{listItems.splice(0)}</ul>);
  };
  BLOCKS.forEach((b, i) => {
    if (budget <= 0) return;
    const n = BLOCK_WORDS[i];
    const shown = Math.min(budget, n);
    budget -= n;
    const last = streaming && budget <= 0;
    if (b.k !== "li") flushList(`ul-${i}`);
    if (b.k === "h") items.push(<h3 key={i}><Words runs={b.runs} shown={shown} caret={last} /></h3>);
    if (b.k === "p") items.push(<p key={i}><Words runs={b.runs} shown={shown} caret={last} /></p>);
    if (b.k === "li") listItems.push(<li key={i}><Words runs={b.runs} shown={shown} caret={last} /></li>);
    if (b.k === "table")
      items.push(
        <div key={i} className={revealed === Infinity ? "jn-tablewrap" : "jn-tablewrap jn-w"}>
          <table className="jn-table">
            <thead>
              <tr>
                {ANSWER_TABLE.head.map((h, j) => (
                  <th key={h} className={j ? "r" : undefined} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ANSWER_TABLE.rows.map((row) => (
                <tr key={row[0]}>
                  {row.map((c, j) => (
                    <td key={j} className={j ? "r num" : undefined}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
  });
  flushList("ul-end");
  return <div className="jn-answer">{items}</div>;
}

/* ———————————————————— What Juno did, collapsed to one line ———————————————————— */

export function ActivityLine({ open: initialOpen = false, label = "Read 3 files and searched the web", items = READS }: { open?: boolean; label?: string; items?: { verb: string; object: string }[] }) {
  const [open, setOpen] = React.useState(initialOpen);
  const reduced = useReduced();
  return (
    <div className="jn-activity">
      <button type="button" className="jn-activity__line jicon-trigger" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="reads"
            className="jn-activity__list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? R : T.grow}
            style={{ overflow: "hidden" }}
          >
            {items.map((r) => (
              <li key={r.object}>
                <span className="ink-3">{r.verb}</span> <span className="jn-activity__obj">{r.object}</span>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function MessageActions() {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="jn-actions">
      <button type="button" className="jib jib--sm jicon-trigger" aria-label={copied ? "Copied" : "Copy"} onClick={() => setCopied(true)}>
        <Icon name={copied ? "check" : "copy"} size={16} state={copied ? "active" : "rest"} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="Try again">
        <Icon name="retry" size={16} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="More">
        <Icon name="more" size={16} />
      </button>
    </div>
  );
}

/* ———————————————————————— A live task inside the chat ———————————————————————— */

export function TaskCard({ planOpen: initialPlan = false, answered = false }: { planOpen?: boolean; answered?: boolean }) {
  const [plan, setPlan] = React.useState(initialPlan);
  const [choice, setChoice] = React.useState<string | null>(answered ? "Halvorsen AS" : null);
  const reduced = useReduced();
  const state = choice ? "working" : "waiting";
  return (
    <section className="jn-task" aria-label="Task: Mira is checking renewal usage">
      <div className="jn-task__head">
        <span className="jn-task__face">
          <CrewFace member={face(MIRA)} state={state} size={28} />
        </span>
        <div className="jn-task__main">
          <p className="jn-task__what">Mira is matching Stripe customers to the three accounts</p>
          <p className="jn-task__progress num">{choice ? `Checking ${choice}, step 2 of 4` : "Step 2 of 4, waiting on you for 4 minutes"}</p>
        </div>
        <button type="button" className="jb jb--ghost jb--sm jicon-trigger">
          <Icon name="stop" size={16} />
          Stop
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!choice ? (
          <motion.div
            key="need"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? R : T.grow}
            style={{ overflow: "hidden" }}
          >
            <div className="jn-task__need">
              <p className="jn-task__needlabel">Mira needs your answer</p>
              <p className="jn-task__question">Halvorsen has two Stripe customers. Which one holds the annual plan?</p>
              <div className="jn-task__options">
                {["Halvorsen AS", "Halvorsen Group", "Check both"].map((o) => (
                  <button key={o} type="button" className="jb jb--secondary jb--sm" onClick={() => setChoice(o)}>
                    {o}
                  </button>
                ))}
                <span className="jn-task__or">or reply below</span>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button type="button" className="jn-task__plan jicon-trigger" aria-expanded={plan} onClick={() => setPlan((p) => !p)}>
        <Icon name={plan ? "chevron-down" : "chevron-right"} size={16} />
        <span>Plan</span>
        <span className="ink-3 num">1 of 4 done</span>
      </button>
      <AnimatePresence initial={false}>
        {plan ? (
          <motion.ol
            key="plan"
            className="jn-plan"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? R : T.grow}
            style={{ overflow: "hidden" }}
          >
            {MIRA_PLAN.map((step) => (
              <li key={step.title} className="jn-plan__step" data-state={step.state}>
                <span className="jn-plan__mark">
                  <Icon name={step.state === "done" ? "check" : step.state === "active" ? "progress" : "circle"} size={16} state={step.state === "active" ? "active" : "rest"} />
                </span>
                {step.title}
              </li>
            ))}
          </motion.ol>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/* ———————————— An approval, docked on the composer where your hands are ———————————— */

export function Approval({ animate = false, onInstead }: { animate?: boolean; onInstead?: () => void }) {
  const reduced = useReduced();
  const [outcome, setOutcome] = React.useState<null | "denied" | "allowed" | "always">(null);
  const body = (
    <div className="jn-approve" role="group" aria-label="Approval: post the summary to #design in Slack">
      <div className="jn-approve__head">
        <SlackMark size={20} className="jn-approve__mark" />
        <div className="jn-approve__words">
          <p className="jn-approve__title">Post the summary to #design in Slack?</p>
          <p className="jn-approve__sub">Juno will post as you, once. Your Slack rule is to ask first.</p>
        </div>
      </div>
      <p className="jn-approve__body">{SLACK_POST}</p>
      <AnimatePresence mode="wait" initial={false}>
        {outcome ? (
          <motion.p key="done" className="jn-approve__outcome" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.fade}>
            <Icon name="check" size={16} state="active" />
            {outcome === "denied" ? "Not posted. Juno will carry on without it." : outcome === "always" ? "Posted to #design at 14:06. Slack posts no longer ask." : "Posted to #design at 14:06."}
            <button type="button" className="jb jb--link" onClick={() => setOutcome(null)}>
              Undo
            </button>
          </motion.p>
        ) : (
          <motion.div key="ask" className="jn-approve__actions" exit={{ opacity: 0 }} transition={reduced ? R : T.menuOut}>
            <button type="button" className="jb jb--secondary" onClick={() => setOutcome("denied")}>
              Deny
            </button>
            <button type="button" className="jb jb--primary" onClick={() => setOutcome("allowed")}>
              Allow once
            </button>
            <button type="button" className="jb jb--ghost" onClick={() => setOutcome("always")}>
              Always for Slack
            </button>
            <button type="button" className="jb jb--link jn-approve__instead" onClick={onInstead}>
              Tell Juno what to do instead
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
  if (!animate) return body;
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      transition={reduced ? R : { duration: 0.26, ease: [0.2, 0, 0, 1] }}
      style={{ overflow: "hidden" }}
    >
      {body}
    </motion.div>
  );
}
