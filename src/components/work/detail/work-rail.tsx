"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { WorkStatus } from "@/lib/work/domain";
import { statusSentence } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * The shape of the run-detail rail, and the rules that decide what is in it.
 *
 * The rail used to render eight panels under four headings — Plan, Activity,
 * Approvals, Files and sources, Documents, Skills and apps, Actions performed,
 * Run settings — grouped as "What happened / Where it got to / Progress / What
 * it produced / How it ran". Every one of those is a true label and none of them
 * is a question anybody arrives with. A reader opens this page wanting three
 * things, in this order: how far did it get, what did it make, and what could it
 * see. Eight headings is what you build when you file the answers by their
 * source instead of by the question.
 *
 * So the rail is now three named sections and a footnote:
 *
 *   Progress   the plan as a checklist being crossed off, with the feed and the
 *              decisions underneath it rather than beside it.
 *   Outputs N  what the run actually produced, counted in the heading so a
 *              closed section still answers "did it make anything".
 *   Context    what it could see and reach — the pages it read, the skills it
 *              may apply, the apps the account has linked.
 *   How it ran the model, the target, the attempt and the budget bars. Reference
 *              rather than narrative, so it sits last and closed.
 *
 * Three rules hold the thing together, and this file holds the machinery for all
 * three.
 *
 * 1. Every section is a disclosure with a chevron, and the reader's choice is
 *    remembered for the rest of the browser session. Somebody who closes
 *    Progress on one task has said something about how they read this page, not
 *    about that task, and re-opening it on the next one is the rail overruling
 *    them once per navigation.
 *
 * 2. A section with nothing in it is a heading and nothing else. Not a sentence
 *    apologising for the emptiness — that was six paragraphs of apology on a
 *    fourteen-second failed run, and it is the single thing this rewrite exists
 *    to stop printing. The one exception is a finished run that produced no
 *    files, where "it made nothing" is the answer rather than the absence of
 *    one, and that line is written where it is known: in the Outputs section.
 *
 * 3. Order is fixed; only openness moves. The old rail reordered its groups per
 *    phase, which meant the reader learned a layout that then changed under
 *    them the moment a run finished. Progress, Outputs, Context, How it ran —
 *    always, in that order — and `RAIL_POLICY` decides which of them arrive
 *    open.
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

export type RailSectionName = "progress" | "outputs" | "context" | "setup";

/** The reading order, and it does not vary. See rule 3 at the top of the file. */
export const RAIL_ORDER: readonly RailSectionName[] = ["progress", "outputs", "context", "setup"];

export interface SectionPolicy {
  /** False removes the section from this phase entirely, filled or not. */
  shown: boolean;
  /** Whether it arrives open. A reader's own choice, once made, outranks this. */
  open: boolean;
}

/**
 * Which sections a run in each state gets, and which of them arrive open.
 *
 * Read it as a table rather than as code. Every cell is a claim about what the
 * reader wants at that moment, and the claims are meant to be disagreed with in
 * one place instead of hunted for through four branches of JSX.
 *
 * Two of the claims are worth their comment on the spot:
 *
 *  - Context arrives closed everywhere except on a draft, and the reason is
 *    mechanical as well as editorial: the skills and apps it holds are fetched
 *    when the section opens, so a rail that opened it by default would spend two
 *    requests per page load on a list most readers never look at. On a draft it
 *    is the point — what this task may reach is exactly what somebody checks
 *    before pressing Start.
 *  - Outputs arrives open in every phase that has it, even when the count is
 *    zero. An open section holding nothing costs one line and a heading; a
 *    closed one asks the reader to click to discover there was nothing to click
 *    for.
 */
export const RAIL_POLICY: Record<RunPhase, Record<RailSectionName, SectionPolicy>> = {
  draft: {
    // Nothing has happened, so nothing can be reported. What is worth showing is
    // what the task WILL run as and what it may reach for.
    progress: { shown: false, open: false },
    outputs: { shown: false, open: false },
    context: { shown: true, open: true },
    setup: { shown: true, open: true },
  },
  attention: {
    progress: { shown: true, open: true },
    outputs: { shown: true, open: true },
    context: { shown: true, open: false },
    setup: { shown: true, open: false },
  },
  live: {
    progress: { shown: true, open: true },
    outputs: { shown: true, open: true },
    context: { shown: true, open: false },
    setup: { shown: true, open: false },
  },
  failed: {
    progress: { shown: true, open: true },
    outputs: { shown: true, open: true },
    context: { shown: true, open: false },
    // Opened by the page when the run recorded a degradation — see the note at
    // its call site. A run that stopped at its ceiling is explained by the
    // budget bars in here and nowhere else.
    setup: { shown: true, open: false },
  },
  done: {
    progress: { shown: true, open: true },
    outputs: { shown: true, open: true },
    context: { shown: true, open: false },
    setup: { shown: true, open: false },
  },
};

const SECTION_TITLE: Record<RailSectionName, string> = {
  progress: "Progress",
  outputs: "Outputs",
  context: "Context",
  setup: "How it ran",
};

/** `setup` is the one title that is a tense rather than a fact. */
export function sectionTitle(name: RailSectionName, phase: RunPhase): string {
  if (name !== "setup") return SECTION_TITLE[name];
  if (phase === "draft") return "How it will run";
  if (phase === "live" || phase === "attention") return "How it is running";
  return SECTION_TITLE.setup;
}

// ---------------------------------------------------------------------------
// Remembering which sections the reader keeps open
// ---------------------------------------------------------------------------

const DISCLOSURE_PREFIX = "juno.work.rail.";

/**
 * Session storage rather than local storage, and deliberately.
 *
 * How somebody reads this page is a mood, not a setting. A reader who collapses
 * Progress while chasing a failure wants it collapsed for the next four tasks
 * they open in that sitting; they do not want to come back next week to a rail
 * they configured once and forgot about. `sessionStorage` expires exactly when
 * that sitting does.
 *
 * Both accessors swallow their errors. Safari's private mode and a sandboxed
 * frame throw on access rather than returning null, and a rail that cannot
 * remember is a rail that opens on its defaults — which is where it was before
 * any of this existed.
 */
function readDisclosure(key: string): boolean | null {
  try {
    const raw = window.sessionStorage.getItem(DISCLOSURE_PREFIX + key);
    return raw === null ? null : raw === "open";
  } catch {
    return null;
  }
}

function writeDisclosure(key: string, open: boolean): void {
  try {
    window.sessionStorage.setItem(DISCLOSURE_PREFIX + key, open ? "open" : "closed");
  } catch {
    // Nothing to recover: the next render simply falls back to the default.
  }
}

/**
 * One disclosure's open state, with three inputs and a strict order of
 * precedence between them.
 *
 * 1. The reader's own click, this render onwards. Always wins.
 * 2. What they clicked earlier in this browser session, read back from storage.
 * 3. The phase's default.
 *
 * The reason 1 and 2 have to outrank 3 is a bug that was live in the old rail: a
 * run finishing moves the page from `live` to `done`, which flipped panels open
 * and shut underneath a reader who had opened one thirty seconds earlier to
 * watch it fill. The default is a starting position, not a standing instruction.
 *
 * And a default that changes while the page is open may OPEN a disclosure and
 * may never close one. Both directions have a case: a run recording a
 * degradation should open How it ran, because that is where the explanation
 * lands; a plan arriving on a run that did not have one should NOT close the
 * activity feed the reader has been watching for the last two minutes. Allowing
 * only the opening direction gets both, and it is the same principle as the
 * paragraph above — nothing the rail decides on its own takes something away
 * from the reader.
 *
 * Storage is read in an effect rather than during render on purpose. This
 * component is server-rendered, `sessionStorage` does not exist there, and a
 * first paint that disagreed with the server's would be exactly the hydration
 * mismatch this codebase keeps warning about. The cost is that a remembered
 * section can flash its default for one frame; the alternative is a React
 * hydration error on every load of the page.
 */
function useRailDisclosure(key: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = React.useState(defaultOpen);
  const chosen = React.useRef(false);

  // Declared before the default-tracking effect below so it runs first on mount:
  // a remembered value marks the disclosure as chosen, which is what stops the
  // phase default from immediately overwriting it.
  React.useEffect(() => {
    const stored = readDisclosure(key);
    if (stored === null) return;
    chosen.current = true;
    setOpen(stored);
  }, [key]);

  React.useEffect(() => {
    if (chosen.current) return;
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const toggle = React.useCallback(() => {
    chosen.current = true;
    setOpen((current) => {
      const next = !current;
      writeDisclosure(key, next);
      return next;
    });
  }, [key]);

  return [open, toggle];
}

// ---------------------------------------------------------------------------
// One section
// ---------------------------------------------------------------------------

/**
 * One of the rail's four sections.
 *
 * The heading is an `h2` under the page's `h1`, and the disclosures nested
 * inside it are `h3`s — so the rail is navigable by heading rather than being a
 * flat run of same-level labels a screen-reader user has to read through in
 * order to find the one they want.
 *
 * `meta` is the count, or the tally, or whatever short mono fact makes a closed
 * section still worth having: "Outputs 3" answers its own question without being
 * opened, and that is the whole mechanism by which a section earns its space —
 * it has to say how much it holds before it is allowed to hold the screen. The
 * count therefore sits on `caption` at full muted-foreground rather than at 10px
 * and 60% alpha, which measured about 3.3:1 on a pure-black ground — the least
 * legible text in the rail, doing the most load-bearing job in it.
 *
 * Children are unmounted while closed, not merely hidden. Context fetches the
 * account's skills and connectors when it mounts, and a rail that opened two
 * requests nobody asked for on every page load is the cost this pays for.
 */
export function RailSection({
  name,
  title,
  meta = null,
  defaultOpen,
  children,
}: {
  /** Doubles as the storage key, so the choice follows the section across tasks. */
  name: RailSectionName;
  title: string;
  meta?: string | null;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  const contentId = React.useId();
  const [open, toggle] = useRailDisclosure(name, defaultOpen);

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
          className="group flex w-full items-baseline gap-2 rounded-xs border-b border-border/60 pb-2 text-left transition-colors duration-base ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 translate-y-[1px] text-muted-foreground/70 transition-[transform,color] duration-base ease-in-out group-hover:text-muted-foreground",
              open && "rotate-90"
            )}
            aria-hidden="true"
          />
          <span className="font-mono text-label text-foreground/80">{title}</span>
          {meta !== null && (
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {meta}
            </span>
          )}
        </button>
      </h2>
      {/* The chevron rotates over `duration-base`; before this the panel it
          controls appeared instantly, so an animated affordance pointed at an
          unanimated result. It is an entrance rather than a height collapse
          because the children are UNMOUNTED while closed (see above) — there is
          nothing left to animate shut, and a collapse would be animating an
          empty box. */}
      <div
        id={contentId}
        hidden={!open}
        className={cn(open && "mt-3.5 space-y-5 motion-safe:animate-fade-in-up")}
      >
        {open && children}
      </div>
    </section>
  );
}

/**
 * A disclosure inside a section: the activity feed under the plan, the decided
 * approvals under it, the actions performed under the outputs.
 *
 * These are the parts of the old rail that were true but subordinate. The feed
 * is the record of every step, and it is not what somebody came for — the plan
 * is. Keeping it one click away rather than one panel away is the difference
 * between a rail that reads as a narrative and a rail that reads as a log.
 */
export function RailDisclosure({
  storageKey,
  title,
  meta = null,
  defaultOpen = false,
  children,
}: {
  /** Null for a disclosure whose openness is not worth remembering. */
  storageKey: string;
  title: string;
  meta?: string | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  const contentId = React.useId();
  const [open, toggle] = useRailDisclosure(storageKey, defaultOpen);

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
          className="group flex w-full items-baseline gap-2 rounded-xs py-0.5 text-left transition-colors duration-base ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 translate-y-[1px] text-muted-foreground/70 transition-[transform,color] duration-base ease-in-out group-hover:text-muted-foreground",
              open && "rotate-90"
            )}
            aria-hidden="true"
          />
          {/* `text-label` is 12px / 0.10em / weight 500 — exactly what this was
              hand-rolling one pixel low, and the same rung RailSection above and
              RailHeading below already use, so the outline reads as one scale. */}
          <span className="font-mono text-label text-muted-foreground">
            {title}
          </span>
          {meta !== null && (
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {meta}
            </span>
          )}
        </button>
      </h3>
      <div
        id={contentId}
        hidden={!open}
        className={cn(open && "mt-2.5 motion-safe:animate-fade-in-up")}
      >
        {open && children}
      </div>
    </section>
  );
}

/**
 * A heading with no disclosure, for a part of a section that is always open.
 *
 * Used inside Context, where the read sources and the toolbox are two halves of
 * one answer rather than two things to choose between. Same heading level as
 * `RailDisclosure` so the outline stays consistent whichever a section uses.
 */
export function RailHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 font-mono text-label text-muted-foreground">{children}</h3>
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

/**
 * A number in a heading, said out loud when it changes and not before.
 *
 * The visible count beside "Outputs" updates silently as a run writes files,
 * which is right for a reader watching it and useless for one who is not. This
 * is the same fact as a polite announcement — "2 outputs" — and it is the only
 * thing in the rail besides the status that interrupts anybody.
 *
 * Same first-paint rule as `WorkRunAnnouncer`, for the same reason: text present
 * when a live region is created is announced by some screen readers as though it
 * had just changed, and "0 outputs" on page load is not news.
 */
export function RailLiveCount({ message }: { message: string }) {
  const [announced, setAnnounced] = React.useState("");

  React.useEffect(() => {
    setAnnounced(message);
  }, [message]);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {announced}
    </p>
  );
}
