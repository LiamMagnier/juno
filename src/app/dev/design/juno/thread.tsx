"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { ANSWER_CLOSE, ANSWER_INTRO, ANSWER_LIST, ANSWER_TABLE, MIRA, MIRA_PLAN, READS, SLACK_POST, TRACE_SUMMARY, type Segment } from "./fixtures";
import { Sentence } from "./composer";
import { Icon } from "./icons";
import { SlackMark, StepMark } from "./marks";
import { R, SPRING, T, TIMING, useReduced } from "./motion";
import { face } from "./shell";

/* ———————————————————————— The live line (M1) ———————————————————————— */

/*
 * While Juno works before its first word, one line of text in the presence
 * colour says what it is doing, and after three seconds how long it has been.
 * The colour and the changing words are the whole signal: no caret, no dots,
 * no shimmer, no orb. A phase change cross-fades on fast; the first word of
 * the answer replaces the line in the same frame.
 */
export function LiveLine({ text, seconds, who, className }: { text: string; seconds?: number; who?: "mira"; className?: string }) {
  const reduced = useReduced();
  return (
    <div className={["jn-live", className].filter(Boolean).join(" ")} role="status" aria-live="polite">
      {who ? (
        <span className="jn-live__face">
          <CrewFace member={face(MIRA)} state="working" size={16} live={false} />
        </span>
      ) : null}
      <span className="jn-live__words">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={text} className="jn-live__text" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? T.instant : T.fast}>
            {text}
          </motion.span>
        </AnimatePresence>
      </span>
      {seconds !== undefined && seconds >= 3 ? <span className="jn-live__secs num">{seconds}s</span> : null}
    </div>
  );
}

/** Seconds since mount, ticking once a second (a number changing is information, not animation). */
export function useSeconds(running: boolean, start = 0) {
  const [s, setS] = React.useState(start);
  React.useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setS((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return s;
}

/* ———————————————————————— The person's message and its receipt ———————————————————————— */

export function UserMessage({ segments, receipt, animateIn = false }: { segments: Segment[]; receipt?: string | null; animateIn?: boolean }) {
  const reduced = useReduced();
  return (
    <div className="jn-umsg">
      <motion.div
        className="jn-umsg__bubble"
        initial={animateIn && !reduced ? { opacity: 0.6 } : false}
        animate={{ opacity: 1 }}
        transition={T.fast}
      >
        <Sentence segments={segments} still />
      </motion.div>
      <AnimatePresence initial={false}>
        {receipt ? (
          <motion.p key="receipt" className="jn-receipt" initial={animateIn ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={T.fast}>
            {receipt}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}


/* ———————————————————————— The answer, as blocks of words (M2, M3, M8) ———————————————————————— */

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

function Words({ runs, shown }: { runs: Run[]; shown: number }) {
  const words = wordsOf(runs);
  if (shown >= words.length) {
    return <>{runs.map((r, i) => (r.b ? <strong key={i}>{r.t}</strong> : <React.Fragment key={i}>{r.t}</React.Fragment>))}</>;
  }
  // Streaming: each word fades in where it will stay (160ms). No slide, no blur, no caret.
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
        <div key={i} className={revealed === Infinity ? "jn-tablewrap" : "jn-tablewrap jn-w"} role="region" aria-label="Table, 4 columns, 3 rows" tabIndex={0}>
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
  return (
    <div className="jn-answer" aria-busy={revealed !== Infinity && revealed < ANSWER_WORDS ? true : undefined}>
      {items}
    </div>
  );
}

/* ———————————————————— What Juno did: the work trace (M5) ———————————————————— */

export function Trace({ open: initialOpen = false, label = TRACE_SUMMARY, items = READS }: { open?: boolean; label?: string; items?: typeof READS }) {
  const [open, setOpen] = React.useState(initialOpen);
  const reduced = useReduced();
  return (
    <div className="jn-trace" role="group" aria-label="Juno’s steps">
      <button type="button" className="jn-trace__line jicon-trigger" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <span className="jn-trace__chev" data-open={open ? "" : undefined}>
          <Icon name="chevron-right" size={16} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="steps"
            className="jn-trace__list"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduced ? R : T.disclose}
            style={{ overflow: "hidden" }}
          >
            {items.map((r) => (
              <li key={r.object} className="jn-step">
                <span className="jn-step__mark">
                  <StepMark mark={r.mark} />
                </span>
                <span className="jn-step__text">
                  <span className="jn-step__verb">{r.verb}</span> <span className="jn-step__obj">{r.object}</span>
                  {r.where ? <span className="jn-step__where"> {r.where}</span> : null}
                </span>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ———————————————————— The action row (M10, M11, M12) ———————————————————— */

export function MessageActions() {
  const [copied, setCopied] = React.useState(false);
  const [vote, setVote] = React.useState<null | "good" | "bad">(null);
  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), TIMING.copiedHold);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="jn-actions" role="group" aria-label="Reply actions">
      <button type="button" className="jib jib--sm jicon-trigger" aria-label={copied ? "Copied" : "Copy"} onClick={() => setCopied(true)}>
        <Icon name={copied ? "check" : "copy"} size={16} state={copied ? "active" : "rest"} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="Try again">
        <Icon name="retry" size={16} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="Good response" aria-pressed={vote === "good"} onClick={() => setVote((v) => (v === "good" ? null : "good"))}>
        <Icon name="thumbs-up" size={16} state={vote === "good" ? "active" : "rest"} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="Bad response" aria-pressed={vote === "bad"} onClick={() => setVote((v) => (v === "bad" ? null : "bad"))}>
        <Icon name="thumbs-down" size={16} state={vote === "bad" ? "active" : "rest"} />
      </button>
      <button type="button" className="jib jib--sm jicon-trigger" aria-label="More">
        <Icon name="more" size={16} />
      </button>
    </div>
  );
}

/* ———————————————————————— A live task inside the chat (T1–T5, T10) ———————————————————————— */

const OPTIONS = [
  { value: "Halvorsen AS", line: "Annual plan, €96,000, renews 30 November" },
  { value: "Halvorsen Group", line: "Monthly since August, €6,033 a month" },
];

export const HANDOFF_ID = "jn-handoff";

export function TaskCard({
  planOpen: initialPlan = false,
  answered = null,
  choice: initialChoice = null,
  handoff = false,
}: {
  planOpen?: boolean;
  answered?: string | null;
  /** An option already chosen but not yet sent (a still of the selected state). */
  choice?: string | null;
  /** The live line that described the work becomes this card's title (T1). */
  handoff?: boolean;
}) {
  const reduced = useReduced();
  const [plan, setPlan] = React.useState(initialPlan);
  const [choice, setChoice] = React.useState<string | null>(initialChoice);
  const [sent, setSent] = React.useState<string | null>(answered);
  const [other, setOther] = React.useState(false);
  const waiting = !sent;
  return (
    <section className="jn-task" aria-label="Task: Mira is checking renewal usage for three accounts">
      <header className="jn-task__head">
        <span className="jn-task__face">
          <CrewFace member={face(MIRA)} state={waiting ? "waiting" : "working"} size={24} />
        </span>
        <div className="jn-task__main">
          <motion.p className="jn-task__what" layoutId={handoff && !reduced ? HANDOFF_ID : undefined} transition={SPRING.emphasized}>
            Mira is checking renewal usage for three accounts
          </motion.p>
          <p className="jn-task__progress num">
            {waiting ? (
              <>Stopped at step 2 of 4 for your answer</>
            ) : (
              <>
                <span className="jn-task__verb">Matching {sent} in Stripe</span>, step 2 of 4
              </>
            )}
          </p>
        </div>
        <span className="jn-task__ctl">
          <button type="button" className="jb jb--ghost jb--sm">
            Pause
          </button>
          <button type="button" className="jb jb--ghost jb--sm">
            Stop
          </button>
        </span>
      </header>

      <AnimatePresence initial={false} mode="popLayout">
        {waiting ? (
          <motion.div
            key="need"
            className="jn-task__need"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: reduced ? R : T.exit }}
            transition={reduced ? R : T.base}
          >
            <p className="jn-task__ask">
              <b className="jn-attn">Needs your answer:</b> Halvorsen has two Stripe customers. Which one holds the annual plan?
            </p>
            <div className="jn-q" role="radiogroup" aria-label="Which Halvorsen customer holds the annual plan?">
              {OPTIONS.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={choice === o.value}
                  className="jn-q__opt"
                  onClick={() => {
                    setChoice(o.value);
                    setOther(false);
                  }}
                >
                  <span className="jn-q__radio" aria-hidden="true" />
                  <span className="jn-q__text">
                    <span>{o.value}</span>
                    <span className="jn-q__line">{o.line}</span>
                  </span>
                  <span className="jkbd jn-q__key" aria-hidden="true">
                    {i + 1}
                  </span>
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={other}
                className="jn-q__opt jn-q__opt--other"
                onClick={() => {
                  setOther(true);
                  setChoice(null);
                }}
              >
                <span className="jn-q__radio" aria-hidden="true" />
                <span className="jn-q__text">
                  <span>Something else…</span>
                </span>
              </button>
            </div>
            <div className="jn-q__actions">
              <button type="button" className="jb jb--ghost jb--sm">
                Skip
              </button>
              <button type="button" className="jb jb--primary jb--sm" aria-disabled={!choice && !other} onClick={() => choice && setSent(choice)}>
                Continue
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.p key="answered" className="jn-task__answered" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.base}>
            You answered: <span className="jn-task__answer">{sent}</span>
            <button type="button" className="jb jb--link" onClick={() => setSent(null)}>
              Change
            </button>
          </motion.p>
        )}
      </AnimatePresence>

      <button type="button" className="jn-task__plan jicon-trigger" aria-expanded={plan} onClick={() => setPlan((p) => !p)}>
        <span className="jn-trace__chev" data-open={plan ? "" : undefined}>
          <Icon name="chevron-right" size={16} />
        </span>
        <span>Plan</span>
        <span className="num">1 of 4 steps done, 6 min</span>
      </button>
      <AnimatePresence initial={false}>
        {plan ? (
          <motion.ol
            key="plan"
            className="jn-plan"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduced ? R : T.disclose}
            style={{ overflow: "hidden" }}
          >
            {MIRA_PLAN.map((step) => (
              <li key={step.title} className="jn-plan__step" data-state={step.state}>
                <span className="jn-plan__mark">
                  <Icon name={step.state === "done" ? "check" : step.state === "active" ? "progress" : "circle"} size={16} state={step.state === "active" && !waiting ? "active" : "rest"} />
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

/* ———————————— The approval card (T6): deterministic, the button is the verb ———————————— */

export function Approval({ animate = false, menuOpen = false, onInstead }: { animate?: boolean; menuOpen?: boolean; onInstead?: () => void }) {
  const reduced = useReduced();
  const [outcome, setOutcome] = React.useState<null | "denied" | "posted" | "always">(null);
  const [armed, setArmed] = React.useState(!animate);
  const [menu, setMenu] = React.useState(menuOpen);
  const [redirect, setRedirect] = React.useState(false);

  // Arming: for 500ms after the card appears the verb ignores activation (no countdown is shown).
  React.useEffect(() => {
    if (armed) return;
    const t = window.setTimeout(() => setArmed(true), TIMING.approvalArm);
    return () => window.clearTimeout(t);
  }, [armed]);

  const card = (
    <section className="jn-approve" role="group" aria-labelledby="jn-approve-title" data-outcome={outcome ?? undefined}>
      <AnimatePresence mode="popLayout" initial={false}>
        {outcome ? (
          <motion.p
            key="receipt"
            className="jn-approve__receipt"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={reduced ? R : SPRING.reward}
          >
            <SlackMark size={16} />
            {outcome === "denied" ? (
              <span className="ink-3">Not posted. You said not now.</span>
            ) : (
              <span>
                Posted to #design <span className="ink-3 num">at 14:06</span>
                {outcome === "always" ? <span className="ink-3">. Juno posts to #design without asking from now on.</span> : null}
              </span>
            )}
            <button type="button" className="jb jb--link" onClick={() => setOutcome(null)}>
              Undo
            </button>
          </motion.p>
        ) : (
          <motion.div key="ask" exit={{ opacity: 0, transition: reduced ? R : T.exit }}>
            <header className="jn-approve__head">
              <SlackMark size={20} className="jn-approve__mark" />
              <p id="jn-approve-title" className="jn-approve__title">
                Juno wants to post to #design
              </p>
            </header>
            <div className="jn-approve__payload">
              <p className="jn-approve__channel">
                <span className="jn-approve__hash">#design</span> <span className="ink-3">in Northwind Slack, as you</span>
              </p>
              <p className="jn-approve__msg">{SLACK_POST}</p>
            </div>
            <p className="jn-approve__consequence">Visible to 42 people. Your Slack rule is to ask before posting.</p>
            {redirect ? (
              <div className="jn-approve__redirect">
                <label className="jfield">
                  <input autoFocus placeholder="Tell Juno what to do instead" aria-label="Tell Juno what to do instead" />
                </label>
                <button type="button" className="jb jb--ghost jb--sm" onClick={() => setRedirect(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="jn-approve__actions">
                <button type="button" className="jb jb--secondary" onClick={() => setOutcome("denied")}>
                  Not now
                </button>
                <span className="jsplit" data-armed={armed ? "" : undefined}>
                  <button type="button" className="jb jb--primary jsplit__main" aria-disabled={!armed} onClick={() => armed && setOutcome("posted")}>
                    Post to #design
                  </button>
                  <button
                    type="button"
                    className="jb jb--primary jsplit__caret jicon-trigger"
                    aria-label="More ways to post"
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    aria-disabled={!armed}
                    onClick={() => armed && setMenu((m) => !m)}
                  >
                    <Icon name="chevron-down" size={16} state={menu ? "active" : "rest"} />
                  </button>
                  <AnimatePresence>
                    {menu ? (
                      <motion.div
                        key="menu"
                        className="jn-pop jn-menu jsplit__menu"
                        role="menu"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, transition: reduced ? R : T.exit }}
                        transition={reduced ? R : T.base}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked="true"
                          className="jn-pop__row jn-pop__row--tall"
                          onClick={() => {
                            setMenu(false);
                            setOutcome("posted");
                          }}
                        >
                          <span className="jn-pop__stack">
                            <span>Post once</span>
                            <span className="jn-pop__line">Juno asks again next time</span>
                          </span>
                          <span className="jn-pop__check">
                            <Icon name="check" size={16} />
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked="false"
                          className="jn-pop__row jn-pop__row--tall"
                          onClick={() => {
                            setMenu(false);
                            setOutcome("always");
                          }}
                        >
                          <span className="jn-pop__stack">
                            <span>Always allow in #design</span>
                            <span className="jn-pop__line">Posts there without asking. Change it in Customize</span>
                          </span>
                        </button>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </span>
                <button
                  type="button"
                  className="jb jb--link jn-approve__instead"
                  onClick={() => {
                    setRedirect(true);
                    onInstead?.();
                  }}
                >
                  Tell Juno what to do instead
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
  if (!animate) return card;
  return (
    <motion.div initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? R : T.base}>
      {card}
    </motion.div>
  );
}

/* ———————————— The dock row (§2.1): needs you, when the card is out of view ———————————— */

export function NeedsYouRow({ onShow }: { onShow?: () => void }) {
  return (
    <div className="jn-dockrow" role="status">
      <CrewFace member={face(MIRA)} state="waiting" size={20} live={false} />
      <span className="jn-dockrow__text">
        Mira <span className="jn-attn">needs your answer</span> on the Halvorsen renewal
      </span>
      <button type="button" className="jb jb--ghost jb--sm" onClick={onShow}>
        Show
      </button>
    </div>
  );
}
