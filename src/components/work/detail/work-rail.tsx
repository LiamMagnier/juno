"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { WorkStatus } from "@/lib/work/domain";
import { statusSentence } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * The shape of the run-detail rail, and the rules that decide what is in it.
 *
 * The rail used to render eight panels unconditionally, each under an identical
 * mono heading, each with a one-to-three-line sentence explaining why it was
 * empty. A fourteen-second failed run therefore produced eight headings and six
 * paragraphs of apology, and because every panel had the same weight, none of
 * them had any: the reader could not tell which of the eight answered the
 * question they had actually come with.
 *
 * Three changes, and this file holds the machinery for all three.
 *
 * 1. A panel is omitted when it has nothing in it. An absent panel says "there
 *    is nothing here" faster and more honestly than a sentence saying so, and it
 *    costs the reader no scrolling. The exceptions are deliberate and named in
 *    the table below: an empty Activity panel on a live run means "waiting for
 *    the first step", which is worth reading, and an empty Actions-performed
 *    panel on a failed run means "nothing was left behind", which is the first
 *    thing anybody wants to know before pressing Try again.
 *
 * 2. Panels have weight. `primary` is the one or two panels this run state is
 *    actually about; `standard` is supporting; `quiet` collapses to a single row
 *    the reader can open. Weight is carried by the heading's colour and by
 *    whether the panel is open, not by borders or cards — this is a reading
 *    surface, and the depth kit belongs to chrome and controls.
 *
 * 3. Weight follows the run's state. What matters while a task is running is not
 *    what matters after it has failed, and neither is what matters on a draft
 *    that has never been started. `RAIL_POLICY` is that judgement written down in
 *    one place rather than scattered through five branches of JSX, so the whole
 *    hierarchy can be read — and argued with — at a glance.
 */

// ---------------------------------------------------------------------------
// What state the run is in, as the rail sees it
// ---------------------------------------------------------------------------

/**
 * The five states the rail arranges itself for.
 *
 * `attention` is separated from `live` even though a task waiting on a person is
 * technically still live, because the two want opposite things: a live run wants
 * the plan and the feed, and a run parked on a question wants the question and
 * nothing competing with it.
 *
 * `failed` covers every unhappy terminal state, not just the `failed` status —
 * cancelled, interrupted, out of budget and timed out all leave the same reader
 * with the same question, which is what went wrong and whether retrying is safe.
 */
export type RunPhase = "draft" | "attention" | "live" | "failed" | "done";

export function deriveRunPhase(input: {
  /** False for a task that has never been dispatched. */
  hasRun: boolean;
  /** True while the session's status is non-terminal. */
  live: boolean;
  /** An open question or an undecided approval — anything blocking on a person. */
  needsYou: boolean;
  /** The run's own terminal reason, once it has one. */
  terminalReason: string | null;
}): RunPhase {
  if (!input.hasRun) return "draft";
  if (input.needsYou) return "attention";
  if (input.live) return "live";
  // A run that ended without recording a reason is not a success. `interrupted`
  // exists precisely because a lease can expire with nothing written, and
  // treating that silence as "done" would show a green rail over a run that may
  // have stopped halfway through changing something.
  return input.terminalReason === "completed" ? "done" : "failed";
}

// ---------------------------------------------------------------------------
// The policy table
// ---------------------------------------------------------------------------

export type PanelTone = "primary" | "standard" | "quiet";

export interface PanelPolicy {
  tone: PanelTone;
  /** Whether the panel starts open. Quiet panels usually do not. */
  open: boolean;
  /**
   * Render the panel even with nothing in it.
   *
   * True only where the empty state is itself the answer — "waiting for the
   * first step" on a live run, "nothing was changed" on a failed one. Everywhere
   * else an empty panel is omitted, because a heading over a sentence about
   * emptiness is the thing this rail was rebuilt to stop printing.
   */
  whenEmpty: boolean;
  /** False removes the panel from this phase entirely, filled or not. */
  shown: boolean;
}

export type PanelName =
  | "plan"
  | "activity"
  | "approvals"
  | "references"
  | "documents"
  | "toolbox"
  | "performed"
  | "settings"
  | "attempts";

const HIDDEN: PanelPolicy = { tone: "quiet", open: false, whenEmpty: false, shown: false };
const PRIMARY: PanelPolicy = { tone: "primary", open: true, whenEmpty: false, shown: true };
const STANDARD: PanelPolicy = { tone: "standard", open: true, whenEmpty: false, shown: true };
const QUIET: PanelPolicy = { tone: "quiet", open: false, whenEmpty: true, shown: true };

/**
 * Which panels matter, and how much, in each state a run can be in.
 *
 * Read it as a table rather than as code. Every cell is a claim about what the
 * reader wants at that moment, and the claims are meant to be disagreed with in
 * one place instead of hunted for in nine.
 *
 * Two entries are worth their comment on the spot:
 *
 *  - `documents` and `toolbox` are the only panels whose emptiness this page
 *    cannot know. Both fetch their own data — the artifact list and the account's
 *    skills and connectors — so "omit when empty" is not available to them and
 *    `quiet` is what they get instead: one collapsed row, opened on demand, which
 *    costs a line rather than a paragraph. `documents` is promoted on a finished
 *    run because what a task made is the whole point of having finished it.
 *  - `settings` is quiet almost everywhere and open on a failure, because that
 *    panel holds the budget bars and the degradation notes, and a run that
 *    stopped at its ceiling is explained there and nowhere else.
 */
export const RAIL_POLICY: Record<RunPhase, Record<PanelName, PanelPolicy>> = {
  draft: {
    // Nothing has happened, so nothing can be reported. The rail shows what the
    // task WILL run as and what it may reach for, which are the two things
    // somebody checks before pressing Start.
    plan: HIDDEN,
    activity: HIDDEN,
    approvals: HIDDEN,
    references: HIDDEN,
    documents: HIDDEN,
    toolbox: { tone: "standard", open: true, whenEmpty: true, shown: true },
    performed: HIDDEN,
    settings: { tone: "primary", open: true, whenEmpty: true, shown: true },
    attempts: HIDDEN,
  },
  attention: {
    // Something is blocking on the reader. The plan says what the decision is
    // for; the feed says how it got here. Everything else waits.
    plan: PRIMARY,
    activity: { tone: "primary", open: true, whenEmpty: true, shown: true },
    approvals: PRIMARY,
    references: STANDARD,
    documents: QUIET,
    toolbox: QUIET,
    performed: STANDARD,
    settings: QUIET,
    attempts: STANDARD,
  },
  live: {
    plan: PRIMARY,
    activity: { tone: "primary", open: true, whenEmpty: true, shown: true },
    approvals: STANDARD,
    references: STANDARD,
    documents: QUIET,
    toolbox: QUIET,
    performed: STANDARD,
    settings: QUIET,
    attempts: STANDARD,
  },
  failed: {
    // A failure is a diagnosis, not a dead end. What it got through, what it
    // left behind and what it ran as are the three questions, and the last of
    // those lives in the settings panel with the budget bars.
    plan: { tone: "standard", open: true, whenEmpty: false, shown: true },
    activity: { tone: "primary", open: true, whenEmpty: true, shown: true },
    approvals: STANDARD,
    references: STANDARD,
    documents: QUIET,
    toolbox: QUIET,
    performed: { tone: "primary", open: true, whenEmpty: true, shown: true },
    settings: { tone: "standard", open: true, whenEmpty: true, shown: true },
    attempts: PRIMARY,
  },
  done: {
    // It worked. What it produced outranks how it produced it, and the feed
    // becomes a record to open rather than a thing to watch.
    plan: QUIET,
    activity: QUIET,
    approvals: QUIET,
    references: STANDARD,
    documents: { tone: "primary", open: true, whenEmpty: true, shown: true },
    toolbox: QUIET,
    performed: STANDARD,
    settings: QUIET,
    attempts: STANDARD,
  },
};

/** Whether a panel with this policy, holding this much, is rendered at all. */
export function panelVisible(policy: PanelPolicy, filled: boolean): boolean {
  return policy.shown && (filled || policy.whenEmpty);
}

/**
 * A policy as the props `RailPanel` takes.
 *
 * The one rule folded in here rather than repeated at nine call sites: a quiet
 * panel is a disclosure. That is what "quiet" means on this rail — not a
 * lighter heading over the same paragraph, but a panel that has to be asked for.
 */
export function panelProps(policy: PanelPolicy, count?: number | null) {
  return {
    tone: policy.tone,
    collapsible: policy.tone === "quiet",
    defaultOpen: policy.open,
    count: count ?? null,
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type GroupName = "outcome" | "progress" | "produced" | "setup";

/**
 * Which groups the rail shows and in what order.
 *
 * The order is the argument. A finished task leads with what it made; a failed
 * one leads with what happened; a live one leads with what it is doing. Same
 * panels, different first paragraph — which is the difference between a rail
 * that answers the reader's question and a rail that files it alphabetically.
 */
export const RAIL_GROUPS: Record<RunPhase, readonly GroupName[]> = {
  draft: ["setup"],
  attention: ["progress", "produced", "setup"],
  live: ["progress", "produced", "setup"],
  failed: ["outcome", "progress", "produced", "setup"],
  done: ["produced", "progress", "setup"],
};

const GROUP_TITLE: Record<GroupName, string> = {
  outcome: "What happened",
  progress: "Progress",
  produced: "What it produced",
  setup: "How it ran",
};

/** `setup` is the one group whose title is a tense rather than a fact. */
export function groupTitle(name: GroupName, phase: RunPhase): string {
  if (name === "setup" && phase === "draft") return "How it will run";
  if (name === "setup" && (phase === "live" || phase === "attention")) return "How it is running";
  return GROUP_TITLE[name];
}

export function RailGroup({
  title,
  children,
}: {
  title: string;
  /** Null children are expected: a group whose panels are all empty renders nothing. */
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  // `toArray` drops null, undefined and booleans and flattens nested arrays, so
  // this counts panels that will actually render rather than expressions that
  // were written. A group whose every panel was omitted must not leave its
  // heading and its rule behind — that is the same empty-heading problem one
  // level up.
  const filled = React.Children.toArray(children).length > 0;
  if (!filled) return null;

  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="mb-3.5 border-b border-border/60 pb-2 font-mono text-label text-foreground/80"
      >
        {title}
      </h2>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One panel
// ---------------------------------------------------------------------------

const HEADING_TONE: Record<PanelTone, string> = {
  primary: "text-foreground",
  standard: "text-muted-foreground",
  quiet: "text-muted-foreground/70",
};

/**
 * One panel in the rail.
 *
 * A quiet panel is a disclosure rather than a heading with a paragraph under it:
 * closed it costs one row, and the count beside its name is what tells the
 * reader whether opening it is worth doing. That is the whole mechanism by which
 * a panel earns its space — it has to say how much it holds before it is allowed
 * to hold the screen.
 *
 * The heading level is `h3` under the group's `h2` under the page's `h1`, so the
 * rail is navigable by headings rather than being a flat run of same-level
 * labels that a screen-reader user has to read through in order.
 */
export function RailPanel({
  title,
  tone = "standard",
  count = null,
  collapsible = false,
  defaultOpen = true,
  id,
  children,
}: {
  title: string;
  tone?: PanelTone;
  /** Shown beside the title, so a closed panel still says how much is behind it. */
  count?: number | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Set where something needs to link to this panel. */
  id?: string;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  const contentId = React.useId();
  const [open, setOpen] = React.useState(defaultOpen);

  /*
   * The default changes underneath the reader, and their own choice must survive
   * it.
   *
   * A run finishing moves the rail from `live` to `done`, which closes the
   * Activity panel and opens Documents. That is right for a reader who has not
   * touched anything — and wrong for one who opened Documents thirty seconds
   * ago to watch it fill, only to have the panel they were reading collapse the
   * instant the run ended. So the phase's default is applied until the reader
   * overrules it, and never again after.
   */
  const touched = React.useRef(false);
  React.useEffect(() => {
    if (touched.current) return;
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const label = (
    <>
      <span className={cn("font-mono text-[11px] tracking-[0.1em]", HEADING_TONE[tone])}>
        {title}
      </span>
      {count !== null && count > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">{count}</span>
      )}
    </>
  );

  if (!collapsible) {
    return (
      <section id={id} aria-labelledby={headingId}>
        <h3 id={headingId} className="mb-2.5 flex items-baseline gap-2">
          {label}
        </h3>
        {children}
      </section>
    );
  }

  return (
    <section id={id} aria-labelledby={headingId}>
      <h3 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => {
            touched.current = true;
            setOpen((current) => !current);
          }}
          className="group flex w-full items-baseline gap-2 rounded py-0.5 text-left transition-colors duration-base ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 translate-y-[1px] text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:text-muted-foreground",
              open && "rotate-90"
            )}
            aria-hidden="true"
          />
          {label}
        </button>
      </h3>
      {/* Kept mounted only while open. Documents and the toolbox both fetch on
          mount, and a rail that opened four requests nobody asked for on every
          page load is the cost this collapse exists to avoid. */}
      <div id={contentId} hidden={!open} className={cn(open && "mt-2.5")}>
        {open && children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Telling a screen reader what changed
// ---------------------------------------------------------------------------

/**
 * The run's state, announced once per change and never per event.
 *
 * The obvious thing to do — mark the activity feed as a live region — is the
 * wrong thing. That feed gains a row every second or so while a run is going,
 * and each row would be read out over whatever the user was in the middle of; a
 * screen-reader user would be handed a page that is literally impossible to read
 * while the task they are trying to follow is running. `role="log"` has the same
 * problem with better provenance.
 *
 * So the feed is not a live region, and this is: one polite, atomic sentence
 * that changes only when the run's STATUS changes. Started, asked you something,
 * waiting on approval, finished, failed — the five moments where a reader
 * genuinely wants interrupting, and nothing between them. It reuses
 * `statusSentence`, so what is announced is word for word what is printed beside
 * the status pill; two wordings for one state would leave the two readers of
 * this page describing it differently to each other.
 *
 * Nothing is rendered on the first paint. A live region that is created with
 * text already in it is announced by some screen readers and not others, and the
 * announcement it would make is "this page has loaded", which the reader can
 * see. Filling it one effect later makes every announcement a genuine change.
 */
export function WorkRunAnnouncer({
  status,
  detail,
}: {
  status: WorkStatus;
  /** The run's terminal detail, when it has one — the specific half of the news. */
  detail: string | null;
}) {
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    const sentence = statusSentence(status);
    setMessage(detail === null ? sentence : `${sentence} ${detail}`);
  }, [status, detail]);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}
