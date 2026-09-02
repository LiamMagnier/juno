"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkComposer } from "@/components/work/work-composer";
import { WorkNav } from "@/components/work/work-nav";
import { useWorkArrivals } from "@/components/work/motion/use-work-arrivals";
import { WorkCrossfade } from "@/components/work/motion/work-crossfade";
import { WorkList, WorkSection } from "@/components/work/shell/work-section";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { InboxRow } from "@/components/work/inbox/inbox-row";
import { TriageBar, type TriageCounts } from "@/components/work/inbox/triage-bar";
import { useUnreadLedger } from "@/components/work/inbox/use-unread";
import {
  TRIAGE_CAPTION,
  WORK_TRIAGE_STATES,
  isWorkTriageState,
  matchesTriage,
  scheduleFor,
  type WorkTriageState,
} from "@/components/work/inbox/triage";
import { fetchWorkOutputCounts } from "@/components/work/shell/work-outputs";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkHosts,
  fetchWorkSchedules,
  fetchWorkSessions,
} from "@/components/work/work-transport";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkHost, ClientWorkSession } from "@/lib/work/serializers";

/**
 * Juno Work's home: an inbox of delegated work.
 *
 * WHAT CHANGED AND WHY. This page used to be a composer over four
 * always-expanded groups — Needs you / Under way / Parked / Finished — and the
 * argument for that shape was that "a workspace does not make you pick a slice
 * to see what you have". That argument is correct for a history and wrong for
 * this, because finished agent work is not something you read, it is something
 * you TRIAGE. Four open sections rank nothing, and the one that grows without
 * bound pushed the two that need a human below the fold on any account older
 * than a week. The old page answered that with a fold on Finished, which is a
 * symptom being managed rather than a shape being fixed.
 *
 * So: one list, a state selector with counts on it, and a sentence on every row
 * saying what that row is waiting for. The counts are what recover the thing
 * the grouping was protecting — you can still see the whole shape of the
 * account without operating anything — and the per-row sentence is what the
 * grouping could never give, because a group heading describes a pile and a
 * person triages one task at a time.
 *
 * FOUR INDEPENDENT LOADS, not one combined endpoint, because they fail
 * differently and the page has something honest to say in each case: with no
 * session list there is nothing to show, with no host list the composer cannot
 * promise anything will pick a task up, with no deliverable list a finished row
 * simply does not mention its files, and with no schedule list a recurring task
 * renders as an ordinary one. Folding them together would make one failure hide
 * the other three.
 *
 * THE STATE LIVES IN THE URL. `?show=needs_you` is what makes "3 need you" in
 * the sidebar, a notification, and a link in an email all able to land the
 * reader on the same filtered view — which is the cross-surface pending queue
 * this product was missing. It also means Back works, which a `useState` filter
 * never does.
 */

/** How many rows are rendered before the list offers to show the rest. */
const PAGE_SIZE = 25;

export default function WorkHomePage() {
  return (
    // `WorkInbox` reads `useSearchParams`, which opts the route out of static
    // prerendering unless it sits under a boundary. A real skeleton rather than
    // `null`, so the shell does not flash empty on the way in.
    <React.Suspense fallback={<InboxSkeleton />}>
      <WorkInbox />
    </React.Suspense>
  );
}

function InboxSkeleton() {
  return (
    <WorkHomeFrame>
      <WorkList className="mt-8">
        <WorkRowSkeletons count={4} />
      </WorkList>
    </WorkHomeFrame>
  );
}

/**
 * The page frame the inbox and its Suspense fallback share, so the header and
 * the tab row are on screen before the search params resolve and nothing moves
 * when they do.
 */
function WorkHomeFrame({ children }: { children: React.ReactNode }) {
  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Work"
        heading="Tasks"
        lede="Hand Juno an errand with a finish line. It plans the work, shows you every step, and asks before anything it cannot undo."
        icon={AppIcons.work}
      />
      {/* Schedules, skills and permissions live under /work and are reached
          from here rather than from the app sidebar: the sidebar is the switch
          between products, and four Work-internal destinations in it would
          make Work look like four of them. */}
      <WorkNav />
      {children}
    </AppPage>
  );
}

function WorkInbox() {
  const router = useRouter();
  const params = useSearchParams();

  const [sessions, setSessions] = React.useState<ClientWorkSession[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = React.useState(false);
  const [loadedAt, setLoadedAt] = React.useState<string | null>(null);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [hostsFailed, setHostsFailed] = React.useState(false);
  const [outputs, setOutputs] = React.useState<ReadonlyMap<string, number> | null>(null);
  const [schedules, setSchedules] = React.useState<readonly ClientWorkSchedule[]>([]);
  const [shown, setShown] = React.useState(PAGE_SIZE);
  const [seed, setSeed] = React.useState<{ text: string; nonce: number } | null>(null);

  const unread = useUnreadLedger();

  const requested = params.get("show");
  const state: WorkTriageState =
    requested !== null && isWorkTriageState(requested) ? requested : "needs_you";

  /**
   * Changing the filter is a navigation, not a state update.
   *
   * `replace`, not `push`: a reader who tries four pills and then presses Back
   * expects to leave Work, not to walk back through four filters they were only
   * glancing at. `scroll: false` because the list is below the fold on a short
   * window and re-anchoring to the top on every pill press loses their place.
   */
  const selectState = React.useCallback(
    (next: WorkTriageState) => {
      setShown(PAGE_SIZE);
      router.replace(next === "needs_you" ? "/work" : `/work?show=${next}`, { scroll: false });
    },
    [router]
  );

  const loadSessions = React.useCallback(async () => {
    const result = await fetchWorkSessions();
    if (result.kind === "ok") {
      setSessions(result.value);
      setSessionsFailed(false);
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
    // "unavailable" would state something the failure did not establish.
    setHostsFailed(true);
  }, []);

  const loadOutputs = React.useCallback(async () => {
    const counts = await fetchWorkOutputCounts();
    if (counts !== null) setOutputs(counts);
  }, []);

  /**
   * The schedules, loaded here purely so a recurring task can say so in the
   * list.
   *
   * A failure is silent and leaves the last set standing, for the same reason
   * the deliverable counts do: this read decorates rows, it does not constitute
   * them, and a dropped request must not turn a recurring task into a one-shot
   * on screen. There is no `schedulesFailed` beside `hostsFailed` because
   * nothing on the page is withheld or promised on the strength of it.
   */
  const loadSchedules = React.useCallback(async () => {
    const result = await fetchWorkSchedules();
    if (result.kind === "ok") setSchedules(result.value);
  }, []);

  const reload = React.useCallback(() => {
    void loadSessions();
    void loadHosts();
    void loadOutputs();
    void loadSchedules();
  }, [loadSessions, loadHosts, loadOutputs, loadSchedules]);

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
   * it with a changed flag until the next poll.
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

  const live = React.useMemo(
    () => (sessions ?? []).filter((session) => !session.archived),
    [sessions]
  );

  /*
   * Each session's triage context, computed once per poll rather than once per
   * pill per row. The counts below ask six questions of every row, and looking a
   * schedule up by session id inside that loop is a linear scan per question.
   */
  const context = React.useMemo(() => {
    const map = new Map<string, { scheduled: boolean; unread: boolean }>();
    for (const session of live) {
      map.set(session.id, {
        scheduled: scheduleFor(session, schedules) !== null,
        unread: unread.isUnread(session),
      });
    }
    return map;
  }, [live, schedules, unread]);

  const counts = React.useMemo<TriageCounts>(() => {
    // Written out rather than built with `Object.fromEntries`, which types as
    // `{[k: string]: number}` and would need a cast through `unknown` to become
    // the record — a cast that would then survive a seventh state being added
    // and silently hand the bar an object missing a key.
    const tally: TriageCounts = {
      needs_you: 0,
      in_progress: 0,
      scheduled: 0,
      unread: 0,
      done: 0,
      all: 0,
    };
    for (const session of live) {
      const ctx = context.get(session.id) ?? { scheduled: false, unread: false };
      for (const key of WORK_TRIAGE_STATES) {
        if (matchesTriage(session, key, ctx)) tally[key] += 1;
      }
    }
    return tally;
  }, [live, context]);

  const matching = React.useMemo(
    () =>
      live.filter((session) =>
        matchesTriage(session, state, context.get(session.id) ?? { scheduled: false, unread: false })
      ),
    [live, state, context]
  );

  const rows = matching.slice(0, shown);
  const arrivals = useWorkArrivals(rows.map((session) => session.id));

  // The account has nothing at all — not an empty filter, which says so for
  // itself below, and not a failed load, which says so louder.
  const nothingYet = sessions !== null && live.length === 0 && !sessionsFailed;

  return (
    <WorkHomeFrame>
        <div className="mt-6">
          <WorkComposer
            hosts={hosts}
            hostsFailed={hostsFailed}
            onRetryHosts={() => void loadHosts()}
            seed={seed}
          />
        </div>

        {sessionsFailed && sessions !== null && sessions.length === 0 ? (
          <WorkSection title="Your tasks">
            <WorkLoadError onRetry={() => void loadSessions()}>
              Couldn’t load your tasks. This list is empty because the request failed, not because
              there is nothing here.
            </WorkLoadError>
          </WorkSection>
        ) : (
          <WorkCrossfade
            pending={sessions === null}
            placeholder={
              <WorkSection title="Your tasks">
                <WorkRowSkeletons />
              </WorkSection>
            }
          >
            {nothingYet ? (
              <FirstRun onTry={(text) => setSeed({ text, nonce: Date.now() })} />
            ) : (
              <WorkSection
                title="Your tasks"
                meta={String(counts.all)}
                action={
                  counts.unread > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => unread.markAllSeen(live)}
                      className="h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
                    >
                      <CheckCheck className="size-3" aria-hidden="true" />
                      Mark all read
                    </Button>
                  ) : undefined
                }
              >
                <TriageBar value={state} counts={counts} onChange={selectState} />
                {/*
                  The caption is per-state and never omitted, because an empty
                  filtered list is otherwise ambiguous between "nothing matches"
                  and "that failed to load".
                */}
                <p className="mt-2.5 text-ui leading-relaxed text-muted-foreground">
                  {TRIAGE_CAPTION[state]}
                </p>

                {/*
                  A stale list under a failed refresh, said out loud. The rows
                  below are real and were true a moment ago; blanking them would
                  destroy information the failure did not disprove, and showing
                  them silently would let the reader act on a list that has
                  stopped updating.
                */}
                {sessionsFailed && (
                  <p className="mt-2.5 text-ui leading-relaxed text-warning-foreground" role="status">
                    This list stopped refreshing. What you can see was true as of{" "}
                    {loadedAt === null ? "the last successful load" : workTimeAgo(loadedAt)}.
                  </p>
                )}

                <WorkList className="mt-4">
                  {rows.map((session) => (
                    <InboxRow
                      key={session.id}
                      session={session}
                      outputCount={outputs?.get(session.id)}
                      schedule={scheduleFor(session, schedules)}
                      unread={context.get(session.id)?.unread ?? false}
                      enterRank={arrivals.rankFor(session.id)}
                      onChanged={replaceSession}
                      onOpen={(opened) => unread.markSeen(opened.id, opened.lastActivityAt)}
                    />
                  ))}
                </WorkList>

                {rows.length === 0 && (
                  <EmptyState
                    size="panel"
                    className="mt-4"
                    icon={AppIcons.work}
                    title={EMPTY_TITLE[state]}
                    description={EMPTY_BODY[state]}
                    action={
                      state === "needs_you" ? undefined : (
                        <Button variant="outline" size="sm" onClick={() => selectState("all")}>
                          Show everything
                        </Button>
                      )
                    }
                  />
                )}

                {matching.length > rows.length && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShown((current) => current + PAGE_SIZE)}
                      className="gap-1.5 font-mono text-micro text-muted-foreground"
                    >
                      Show {Math.min(PAGE_SIZE, matching.length - rows.length)} more of{" "}
                      {matching.length}
                    </Button>
                  </div>
                )}

                {/*
                  When the list is from, and how to make it newer. A footer
                  rather than a control in the section header, because it belongs
                  to every state and any header it sat in would move about as the
                  filter changed. It also answers the question a polled page owes
                  its reader — how old is this — which a bare Refresh button
                  never did.
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
              </WorkSection>
            )}
          </WorkCrossfade>
        )}
    </WorkHomeFrame>
  );
}

/**
 * What each state says when it has nothing in it.
 *
 * `needs_you` empty is GOOD NEWS and is the only one phrased as such. Every
 * other empty state here is a neutral fact about a filter; that one is the
 * answer to the question the reader opened the page with, and giving it the
 * same flat "nothing matches" as the others wastes the one moment this surface
 * gets to say the work is under control.
 */
const EMPTY_TITLE: Record<WorkTriageState, string> = {
  needs_you: "Nothing is waiting on you",
  in_progress: "Nothing is running",
  scheduled: "Nothing recurring yet",
  unread: "You are up to date",
  done: "Nothing finished yet",
  all: "No tasks yet",
};

const EMPTY_BODY: Record<WorkTriageState, string> = {
  needs_you: "Every task is either working, finished, or parked where you left it.",
  in_progress: "Nothing is being worked on right now.",
  scheduled: "A schedule turns a task into a standing one — same task, new run, history kept.",
  unread: "Nothing has moved since you last looked at it.",
  done: "Tasks land here when they stop, whether or not they succeeded.",
  all: "Describe something above and Juno will carry it out.",
};

/**
 * What somebody sees before they have ever run anything.
 *
 * The examples are the substance. Nobody's first difficulty with Work is
 * believing it can do things; it is knowing how much to ask for in one go, and
 * three short errands with visible finish lines answer that faster than any
 * description of the system.
 *
 * THEY ARE BUTTONS NOW. They were deliberately inert prose, on the ground that
 * "the composer owns its own text and there is no honest way to put words in it
 * from here" — which was true of the composer as it was, and was a component
 * boundary being paid for by the reader. The composer takes a `seed` now, so
 * pressing one writes it into the field and leaves the cursor there. It does
 * NOT start the task: the reader has to read what they are about to ask for and
 * press the button themselves, which is the difference between a suggestion and
 * an accident.
 */
const FIRST_RUN_EXAMPLES = [
  "Tidy my Downloads folder into folders by month.",
  "Reconcile last month’s expenses against the bank export.",
  "Summarise this week’s support email in one page.",
];

function FirstRun({ onTry }: { onTry: (text: string) => void }) {
  return (
    <WorkSection title="Getting started">
      <EmptyState
        icon={AppIcons.work}
        title="Give Juno an errand with a finish line"
        description="It plans the work, shows you every step as it goes, and asks first before anything it cannot undo."
        action={
          <div className="w-full">
            <p className="font-mono text-label text-muted-foreground">Try one of these</p>
            <div className="mx-auto mt-2.5 flex max-w-md flex-col gap-1.5">
              {FIRST_RUN_EXAMPLES.map((example) => (
                <Button
                  key={example}
                  variant="outline"
                  size="sm"
                  onClick={() => onTry(example)}
                  // Left-aligned and full width: these are sentences, not
                  // labels, and centring a paragraph inside a button makes the
                  // three of them impossible to scan as a list.
                  className="h-auto justify-start whitespace-normal px-3 py-2 text-left text-ui font-normal leading-relaxed text-muted-foreground"
                >
                  {example}
                </Button>
              ))}
            </div>
          </div>
        }
      />
    </WorkSection>
  );
}
