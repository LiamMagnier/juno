"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { WorkComposer } from "@/components/work/work-composer";
import { WorkNav } from "@/components/work/work-nav";
import { useWorkArrivals, type WorkArrivals } from "@/components/work/motion/use-work-arrivals";
import { WorkCrossfade } from "@/components/work/motion/work-crossfade";
import { WorkSection, WorkSessionRow } from "@/components/work/work-session-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import {
  WORK_GROUP_KEYS,
  groupWorkSessions,
  type WorkGroupKey,
} from "@/components/work/shell/work-groups";
import { fetchWorkOutputCounts } from "@/components/work/shell/work-outputs";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkHosts,
  fetchWorkSessions,
} from "@/components/work/work-transport";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";
import type { ClientWorkHost, ClientWorkSession } from "@/lib/work/serializers";
import { cn } from "@/lib/utils";

/**
 * Juno Work's home: give it a task, then see what it is doing about the ones you
 * already gave it.
 *
 * Three independent loads rather than one combined endpoint, because they fail
 * differently and the page has something honest to say in each case: with no
 * session list there is nothing to show below the composer, with no host list
 * the composer cannot promise that anything will pick a task up, and with no
 * deliverable list a finished row simply does not mention its files. Folding
 * them together would make one failure hide the other two.
 *
 * The host list is loaded and never displayed. It exists so the composer can run
 * `selectTarget` before the button is pressed; the page itself has no "where
 * work can run" board, because a person on a website cannot see, reach or wake
 * the machines such a board would list, and the one fact they need from it —
 * that a task cannot start, and why — reaches them as a sentence under the
 * composer instead.
 *
 * THE LIST IS GROUPED, NOT FILTERED. It used to be one "Recent tasks" section
 * with a segmented All / In progress / Done control over it, which made the
 * reader operate a control to answer the question they arrived with and showed
 * them one slice at a time. The four groups in `work-groups.ts` answer it
 * outright — what needs me, what is running, what is parked, what is done — and
 * the control is gone rather than kept beside them, because a filter over a
 * grouping is two answers to one question that can disagree.
 *
 * Polled on the same trio the Code sidebar uses — interval, visibility, sync
 * event — because a queued task becomes a running task without anybody
 * clicking, and a page that only loads on mount freezes on whatever it saw
 * first.
 *
 * WHICH IS ALSO WHY THE ENTRANCES ARE COMPUTED HERE. Polling means this list
 * re-renders twice a minute whether or not anything changed, and a page that
 * replayed its entrance on every response would twitch at the reader for the
 * whole time they had it open. Only the list knows which rows are genuinely new,
 * so only the list can say which ones have earned an entrance; `useWorkArrivals`
 * turns each set of ids into "this one is new, and it is the nth new one",
 * and hands every other row a `null` that the row reads as "do not move".
 */

/**
 * The four groups, in the order they are rendered.
 *
 * `explain` is off for the finished group alone. For the other three the status
 * word is not the whole story — a task waiting on an approval and one waiting on
 * an answer are both "stopped", a running task that has recorded nothing for
 * twenty minutes and one mid-sentence are both "Running" — and the sentence
 * `statusActivity` produces is the difference. A finished task's pill has
 * already said everything a row can honestly say about it, and a fourth block of
 * prose under the longest section on the page would only make it harder to scan.
 */
const SECTIONS: readonly {
  key: WorkGroupKey;
  title: string;
  hint?: string;
  explain: boolean;
  /** Amber ink on the heading. See `WorkSection` — exactly one section gets it. */
  attention?: boolean;
}[] = [
  {
    key: "attention",
    title: "Needs you",
    hint: "These have stopped and cannot move until you decide something.",
    explain: true,
    attention: true,
  },
  {
    key: "running",
    title: "Under way",
    hint: "Juno is working on these. Nothing here is waiting on you.",
    explain: true,
  },
  {
    key: "parked",
    title: "Parked",
    hint: "A draft was never started, and a paused task is holding where you left it. Neither moves until you say so.",
    explain: true,
  },
  { key: "finished", title: "Finished", explain: false },
];

/**
 * How many finished tasks are shown before the section folds.
 *
 * Finished is the group that grows without bound — everything ends up here — and
 * it is also the group nobody came to the page to read. Eight is enough to cover
 * "what did I run this morning" and few enough that the sections above it are
 * still on screen. The rest are one press away rather than gone: the list route
 * is clamped at forty, so "show all" is a bounded promise.
 */
const FINISHED_PREVIEW = 8;

export default function WorkHomePage() {
  const { user } = useApp();
  const [sessions, setSessions] = React.useState<ClientWorkSession[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = React.useState(false);
  const [loadedAt, setLoadedAt] = React.useState<string | null>(null);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [hostsFailed, setHostsFailed] = React.useState(false);
  const [outputs, setOutputs] = React.useState<ReadonlyMap<string, number> | null>(null);
  const [showAllFinished, setShowAllFinished] = React.useState(false);

  const loadSessions = React.useCallback(async () => {
    const result = await fetchWorkSessions();
    if (result.kind === "ok") {
      setSessions(result.value);
      setSessionsFailed(false);
      // Stamped from the response rather than kept as a Date, so the footer can
      // hand it to `workTimeAgo` like every other time on this page.
      setLoadedAt(new Date().toISOString());
      return;
    }
    setSessionsFailed(true);
    setSessions((current) => current ?? []);
  }, []);

  const loadHosts = React.useCallback(async () => {
    const result = await fetchWorkHosts();
    if (result.kind === "ok") {
      setHosts(result.value);
      setHostsFailed(false);
      return;
    }
    // What we last knew is left standing rather than blanked. A dropped request
    // says nothing about what could run a task, and replacing a real answer with
    // "unavailable" would state something the failure did not establish. The
    // failure itself is carried separately, in `hostsFailed`, which is what lets
    // the composer hold back rather than guess.
    setHostsFailed(true);
  }, []);

  /**
   * Deliverable counts, kept on the same clock as everything else.
   *
   * A failure is silent and leaves the last counts standing, which is the whole
   * reason `fetchWorkOutputCounts` answers null rather than an empty map: this
   * read decorates rows, it does not constitute them, and a dropped request must
   * not take a "3 files" label off a task that has three files. There is no
   * `outputsFailed` beside `hostsFailed` for the same reason — nothing on the
   * page is withheld or promised on the strength of it, so there is nothing to
   * tell the reader.
   */
  const loadOutputs = React.useCallback(async () => {
    const counts = await fetchWorkOutputCounts();
    if (counts !== null) setOutputs(counts);
  }, []);

  const reload = React.useCallback(() => {
    void loadSessions();
    void loadHosts();
    void loadOutputs();
  }, [loadSessions, loadHosts, loadOutputs]);

  React.useEffect(() => {
    reload();
    const tick = () => {
      if (!document.hidden) reload();
    };
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [reload]);

  /**
   * One row after the user changed it, folded back into the list.
   *
   * Archiving is the case that matters: the list route filters `archived: false`
   * by default, so a task put away here must leave the list rather than sit in
   * it with a changed flag until the next poll. Everything else is patched in
   * place, which is what keeps a rename from making the row jump.
   */
  const replaceSession = React.useCallback((saved: ClientWorkSession) => {
    setSessions((current) =>
      current === null
        ? current
        : saved.archived
          ? current.filter((session) => session.id !== saved.id)
          : current.map((session) => (session.id === saved.id ? saved : session))
    );
  }, []);

  const groups = React.useMemo(() => groupWorkSessions(sessions ?? []), [sessions]);

  /*
   * What each section actually renders, which is the groups themselves except
   * for the fold on Finished.
   *
   * Computed before the arrival trackers below and not inside them, because the
   * trackers must key off the rows that will exist rather than the rows that
   * could: pressing "Show all" genuinely mounts sixteen more rows, and those
   * rows genuinely have arrived.
   */
  const rows: Record<WorkGroupKey, ClientWorkSession[]> = React.useMemo(
    () => ({
      ...groups,
      finished: showAllFinished ? groups.finished : groups.finished.slice(0, FINISHED_PREVIEW),
    }),
    [groups, showAllFinished]
  );

  /*
   * One arrival tracker per section, not one for the page.
   *
   * A task that stops for an answer moves from "Under way" to "Needs you". That
   * is a real arrival in the section it lands in — it also genuinely remounts,
   * since the two sections are different parents — and a single page-wide
   * tracker would have called it an old row and let it appear with no entrance
   * at all, in the one section on the page that exists to be noticed.
   *
   * Written out four times rather than mapped, because these are hooks: a call
   * per group inside a loop over `SECTIONS` would tie React's hook order to the
   * contents of an array, and the day a fifth group is added conditionally that
   * becomes a crash rather than a mistake. Passed a fresh array each render on
   * purpose — the hook keys off the ids themselves, so memoising here would only
   * be guarding a comparison it already does.
   */
  const arrivals: Record<WorkGroupKey, WorkArrivals> = {
    attention: useWorkArrivals(rows.attention.map((session) => session.id)),
    running: useWorkArrivals(rows.running.map((session) => session.id)),
    parked: useWorkArrivals(rows.parked.map((session) => session.id)),
    finished: useWorkArrivals(rows.finished.map((session) => session.id)),
  };

  // The account has nothing at all — not an empty filter, because there is no
  // filter any more, and not a failed load, which says so for itself below.
  const nothingYet = sessions !== null && WORK_GROUP_KEYS.every((key) => groups[key].length === 0);

  const firstName = user.name?.split(" ")[0];

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-3xl">
        {/* Schedules and skills live under /work and are reachable from here
            rather than from the app sidebar: the sidebar is the switch between
            products, and three Work-internal destinations in it would make Work
            look like three of them. */}
        <div className="mb-7 flex justify-center">
          <WorkNav />
        </div>
        <div className="flex flex-col items-center text-center">
          {/* `font-mono text-label`, the register WorkSection already set for
              Work's section labels. This page was running three treatments for the
              same semantic role: a sans eyebrow here, a second one on "Tasks that
              work well", and the mono label on every section heading between them. */}
          <p className="mb-3 font-mono text-label text-muted-foreground [animation-fill-mode:backwards] motion-safe:animate-fade-in">
            Juno Work
          </p>
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
            <div className="flex items-center justify-end pr-[0.38em]">
              <JunoMark
                className={cn(
                  // Kept at ~0.75× the greeting's cap height, which is what the
                  // old 1.2/1.5rem pair was against the old 1.65/2rem type. The
                  // heading is on `display` now, so the mark moves with it —
                  // otherwise it reads as a bullet beside the words rather than
                  // as part of the line.
                  "block size-6 shrink-0 sm:size-9",
                  "[animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                )}
              />
            </div>
            {/* `text-display` carries its own clamp, -0.02em and weight 500;
                the hand-rolled pair of sizes here and the task page's own bespoke
                clamp were two ladders for two titles one click apart. */}
            <h1 className="text-center font-serif text-display font-normal">
              <span className="inline-block [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
                What needs doing{firstName ? "," : "?"}
              </span>
              {firstName ? (
                <>
                  {" "}
                  <span className="inline-block font-medium italic text-primary [animation-delay:180ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
                    {firstName}?
                  </span>
                </>
              ) : null}
            </h1>
            <div aria-hidden="true" />
          </div>
        </div>

        <div className="mt-6 sm:mt-7">
          <WorkComposer
            hosts={hosts}
            hostsFailed={hostsFailed}
            onRetryHosts={() => void loadHosts()}
          />
        </div>

        {sessionsFailed ? (
          <WorkSection title="Your tasks">
            <WorkLoadError onRetry={() => void loadSessions()}>
              Couldn’t load your tasks. This list is empty because the request failed, not because
              there is nothing here.
            </WorkLoadError>
          </WorkSection>
        ) : (
          // The skeleton fades out over whatever the load turned out to be —
          // the groups, or the invitation. Both are the answer to the same
          // question, and only one of them being allowed to resolve gently
          // would make the other feel like an error.
          <WorkCrossfade
            pending={sessions === null}
            placeholder={
              <WorkSection title="Your tasks">
                <WorkRowSkeletons />
              </WorkSection>
            }
          >
            {nothingYet ? (
              <FirstRun />
            ) : (
              <>
                {SECTIONS.map((section) => {
                  const group = rows[section.key];
                  // An empty group is absent rather than shown empty. "Nothing
                  // is running" is worth saying on a page whose only other
                  // content is a list you asked to be filtered; on a page that
                  // shows every group at once it is four headings of noise
                  // around the one thing the reader has.
                  if (group.length === 0) return null;
                  return (
                    <WorkSection
                      key={section.key}
                      title={section.title}
                      hint={section.hint}
                      tone={section.attention ? "attention" : "neutral"}
                      /* The count of the whole GROUP, not of the rows rendered.
                         The two differ only on Finished, where the fold shows
                         eight of twenty-four — and a heading reading "Finished
                         8" over a button offering "Show all 24" would be two
                         counts of one list that disagree. The group's own size
                         is the honest number in both places. */
                      meta={String(groups[section.key].length)}
                      action={
                        section.key === "finished" &&
                        !showAllFinished &&
                        groups.finished.length > FINISHED_PREVIEW ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAllFinished(true)}
                            className="h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
                          >
                            <ChevronDown className="size-3" aria-hidden="true" />
                            Show all {groups.finished.length}
                          </Button>
                        ) : undefined
                      }
                    >
                      <div className="space-y-2.5">
                        {group.map((session) => (
                          <WorkSessionRow
                            key={session.id}
                            session={session}
                            explain={section.explain}
                            outputCount={outputs?.get(session.id)}
                            enterRank={arrivals[section.key].rankFor(session.id)}
                            onChanged={replaceSession}
                          />
                        ))}
                      </div>
                    </WorkSection>
                  );
                })}

                {/*
                  When the list is from, and the way to make it newer.
                  A footer rather than a control in a section header, because it
                  belongs to all four sections and any header it sat in would
                  move about as groups emptied and filled. It also answers the
                  question a polled page owes its reader — how old is this — which
                  a bare Refresh button next to a heading never did.
                */}
                {loadedAt !== null && (
                  <div className="mt-5 flex items-center justify-center gap-1.5 font-mono text-micro tabular-nums text-muted-foreground">
                    <span>Updated {workTimeAgo(loadedAt)}</span>
                    <span aria-hidden="true">·</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void loadSessions()}
                      className="h-6 gap-1.5 px-1.5 font-mono text-micro text-muted-foreground"
                    >
                      <ActionIcons.refresh className="size-3" aria-hidden="true" /> Refresh
                    </Button>
                  </div>
                )}
              </>
            )}
          </WorkCrossfade>
        )}
      </div>
    </div>
  );
}

/**
 * What somebody sees before they have ever run anything.
 *
 * Two jobs, and the order matters: say what Work is FOR, then show what a task
 * looks like. The old card did only the first, in one dense sentence carrying
 * three examples, a promise about planning and a promise about approvals — which
 * is a paragraph a person skims rather than reads, on the one screen where they
 * have nothing else to go on.
 *
 * The examples are the substance. Nobody's first difficulty with Work is
 * believing it can do things; it is knowing how much to ask for in one go, and
 * three short errands with visible finish lines answer that faster than any
 * description of the system. They are deliberately not buttons: the composer
 * owns its own text and there is no honest way to put words in it from here, and
 * a chip that looks pressable and is not is worse than a line of prose.
 */
const FIRST_RUN_EXAMPLES = [
  "Tidy my Downloads folder into folders by month.",
  "Reconcile last month’s expenses against the bank export.",
  "Summarise this week’s support email in one page.",
];

function FirstRun() {
  return (
    <WorkSection title="Getting started">
      {/*
       * `EmptyState`, not a hand-rolled block.
       *
       * This is the first thing a new account sees under the composer, and it
       * was the one empty state in Work that had not adopted the primitive: a
       * `border-t` rule and centred prose, against a dashed `rounded-card` plate
       * on the schedules, skills and Macs pages one click away. The dash is the
       * whole point of that plate — it reads as a space waiting to be filled
       * rather than as a finished thing — which is exactly what this screen is.
       *
       * The examples ride in `action` because they ARE the action, in the only
       * form this screen can honestly offer one. They are deliberately not
       * buttons: the composer owns its own text and there is no honest way to
       * put words in it from here, and a chip that looks pressable and is not is
       * worse than a line of prose.
       */}
      <EmptyState
        icon={AppIcons.work}
        title="Give Juno an errand with a finish line"
        description="It plans the work, shows you every step as it goes, and asks first before anything it cannot undo."
        action={
          <div className="w-full">
            <p className="font-mono text-label text-muted-foreground">Tasks that work well</p>
            <ul className="mx-auto mt-2.5 max-w-md space-y-1.5 text-ui leading-relaxed text-muted-foreground">
              {FIRST_RUN_EXAMPLES.map((example, index) => (
                <li
                  key={example}
                  className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
                  // The same cascade the rows use, on the same step, so the one
                  // screen with no rows on it still moves the way the list does.
                  // Through `staggerDelay` rather than a hand-copied 26: the step
                  // was written out here by hand and had already drifted from the
                  // rung every other Work list runs on.
                  style={staggerDelay(index, "tight", 60)}
                >
                  “{example}”
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </WorkSection>
  );
}
