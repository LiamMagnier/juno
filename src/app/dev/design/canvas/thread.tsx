"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronRight, Copy, MoreHorizontal, RefreshCw } from "@/components/ui/icons";
import {
  ANSWER_CLOSE,
  ANSWER_INTRO,
  ANSWER_LIST,
  ANSWER_TABLE,
  MIRA,
  MIRA_PLAN,
  READS,
  SLACK_POST,
} from "./fixtures";
import { Face } from "./face";
import { SlackColor } from "./marks";
import { Point } from "./point";
import { EASE_OUT, T, useReduced } from "./motion-pref";

/* ———————————————————————— The answer, as blocks of words ———————————————————————— */

type Run = { t: string; b?: boolean };
type Block =
  | { k: "h"; runs: Run[] }
  | { k: "p"; runs: Run[] }
  | { k: "li"; runs: Run[] }
  | { k: "table" };

function boldNumbers(text: string): Run[] {
  // The two totals are the sentence's point; set them in the second weight.
  return text.split(/(€412,000|€438,000)/).filter(Boolean).map((t) => ({ t, b: t.startsWith("€4") }));
}

const BLOCKS: Block[] = [
  { k: "h", runs: [{ t: "Renewal risk this quarter" }] },
  { k: "p", runs: boldNumbers(ANSWER_INTRO) },
  ...ANSWER_LIST.map((it): Block => ({ k: "li", runs: [{ t: it.lead, b: true }, { t: ` ${it.rest}` }] })),
  { k: "table" },
  { k: "p", runs: [{ t: ANSWER_CLOSE }] },
];

/** Words per block, so a reveal count can be spread over the blocks. */
function wordsOf(runs: Run[]): { w: string; b?: boolean }[] {
  return runs.flatMap((r) => r.t.split(/(?<=\s)/).filter(Boolean).map((w) => ({ w, b: r.b })));
}
const BLOCK_WORDS = BLOCKS.map((b) => (b.k === "table" ? 6 : wordsOf(b.runs).length));
export const ANSWER_WORDS = BLOCK_WORDS.reduce((a, b) => a + b, 0);

function Words({ runs, shown }: { runs: Run[]; shown: number }) {
  const words = wordsOf(runs);
  if (shown >= words.length) {
    return (
      <>
        {runs.map((r, i) => (r.b ? <strong key={i}>{r.t}</strong> : <React.Fragment key={i}>{r.t}</React.Fragment>))}
      </>
    );
  }
  // Streaming: each arriving word fades in where it will stay. No slide, no bounce.
  return (
    <>
      {words.slice(0, shown).map((x, i) =>
        x.b ? (
          <strong key={i} className="cv-w">
            {x.w}
          </strong>
        ) : (
          <span key={i} className="cv-w">
            {x.w}
          </span>
        ),
      )}
    </>
  );
}

export function Answer({ revealed = Infinity }: { revealed?: number }) {
  let budget = revealed;
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
    if (b.k !== "li") flushList(`ul-${i}`);
    if (b.k === "h") items.push(<h3 key={i}><Words runs={b.runs} shown={shown} /></h3>);
    if (b.k === "p") items.push(<p key={i}><Words runs={b.runs} shown={shown} /></p>);
    if (b.k === "li") listItems.push(<li key={i}><Words runs={b.runs} shown={shown} /></li>);
    if (b.k === "table")
      items.push(
        <table key={i} className={revealed === Infinity ? "cv-table" : "cv-table cv-w"}>
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
                  <td key={j} className={j === 3 ? "r gap" : j ? "r" : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
  });
  flushList("ul-end");
  return <div className="cv-answer">{items}</div>;
}

/* ———————————————————— What Juno did, collapsed to one line ———————————————————— */

export function ActivityLine({ open: initialOpen = false }: { open?: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  const reduced = useReduced();
  return (
    <>
      <button type="button" className="cv-activity" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Point size={14} />
        Read 3 files and searched the web
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={reduced ? T.instant : T.menuIn} style={{ display: "inline-flex" }}>
          <ChevronRight className="cv-i-sm" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="reads"
            className="cv-reads"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? T.instant : { duration: 0.2, ease: EASE_OUT }}
            style={{ overflow: "hidden" }}
          >
            {READS.map((r) => (
              <span key={r.object}>
                {r.verb} <b>{r.object}</b>
              </span>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** While Juno thinks: the signature walking, and in words what it is doing. */
export function PresenceLine({ text }: { text: string }) {
  return (
    <div className="cv-presence" role="status" aria-live="polite">
      <Point state="thinking" size={16} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={text} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {text}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function MessageActions() {
  return (
    <div className="cv-actions">
      <button type="button" className="cv-ibtn" aria-label="Copy">
        <Copy className="cv-i" />
      </button>
      <button type="button" className="cv-ibtn" aria-label="Try again">
        <RefreshCw className="cv-i" />
      </button>
      <button type="button" className="cv-ibtn" aria-label="More">
        <MoreHorizontal className="cv-i" />
      </button>
    </div>
  );
}

/* ———————————————————————— A live task inside the chat ———————————————————————— */

export function TaskCard({ planOpen: initialPlan = false, answered = false }: { planOpen?: boolean; answered?: boolean }) {
  const [plan, setPlan] = React.useState(initialPlan);
  const [choice, setChoice] = React.useState<string | null>(answered ? "Halvorsen AS" : null);
  const reduced = useReduced();
  const presence = choice ? "working" : "waiting";
  return (
    <section className="cv-task" aria-label="Task: Mira checking renewal usage" data-face-host="">
      <div className="cv-task__head">
        <Face member={MIRA} presence={presence} size={22} className="cv-task__face" />
        <div className="cv-task__main">
          <p className="cv-task__what">Mira is matching Stripe customers to the three accounts</p>
          <p className="cv-task__progress num">Step 2 of 4, started 4 minutes ago</p>
        </div>
        <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm">
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
            transition={reduced ? T.instant : { duration: 0.22, ease: EASE_OUT }}
            style={{ overflow: "hidden" }}
          >
            <div className="cv-task__need">
              <p className="cv-task__needlabel">Mira needs you</p>
              <p className="cv-task__question">Halvorsen has two Stripe customers. Which one holds the annual plan?</p>
              <div className="cv-task__options">
                {["Halvorsen AS", "Halvorsen Group", "Check both"].map((o) => (
                  <button key={o} type="button" className="cv-btn cv-btn--secondary cv-btn--sm" onClick={() => setChoice(o)}>
                    {o}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button type="button" className="cv-task__plan" aria-expanded={plan} onClick={() => setPlan((p) => !p)}>
        <ChevronRight className="cv-i-sm" />
        Plan
      </button>
      <AnimatePresence initial={false}>
        {plan ? (
          <motion.ol
            key="plan"
            className="cv-plan"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? T.instant : { duration: 0.2, ease: EASE_OUT }}
            style={{ listStyle: "none", padding: 0 }}
          >
            {MIRA_PLAN.map((step) => (
              <li key={step.title} className="cv-plan__step" data-state={step.state}>
                <span className="cv-plan__mark">
                  {step.state === "done" ? <Check className="cv-i-sm" /> : step.state === "active" ? <Point state="working" size={14} /> : <Point size={14} />}
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

export function Approval({ animate = false }: { animate?: boolean }) {
  const reduced = useReduced();
  const body = (
    <div className="cv-approve" role="group" aria-label="Approval: post to #design in Slack">
      <div className="cv-approve__head">
        <SlackColor className="cv-mark" />
        <p className="cv-approve__title">Post the summary to #design in Slack?</p>
        <span className="cv-approve__who">Asks before posting</span>
      </div>
      <p className="cv-approve__body">“{SLACK_POST}”</p>
      <div className="cv-approve__actions">
        <button type="button" className="cv-btn cv-btn--secondary">
          Deny
        </button>
        <button type="button" className="cv-btn cv-btn--primary">
          Allow once
        </button>
        <button type="button" className="cv-btn cv-btn--ghost">
          Always for Slack
        </button>
      </div>
    </div>
  );
  if (!animate) return body;
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      transition={reduced ? T.fade : { duration: 0.26, ease: EASE_OUT }}
      style={{ overflow: "hidden" }}
    >
      {body}
    </motion.div>
  );
}
