"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { WorkComposer } from "@/components/work/work-composer";
import { WorkNav } from "@/components/work/work-nav";
import { useWorkArrivals } from "@/components/work/motion/use-work-arrivals";
import { WorkCrossfade } from "@/components/work/motion/work-crossfade";
import {
  WorkSection,
  WorkSessionRow,
  WorkSessionSkeletons,
} from "@/components/work/work-session-row";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkHosts,
  fetchWorkSessions,
} from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { isLiveStatus, isTerminalStatus } from "@/lib/work/domain";
import type { ClientWorkHost, ClientWorkSession } from "@/lib/work/serializers";
import { cn } from "@/lib/utils";

/**
 * Juno Work's home: give it a task, then see what it is doing about the ones you
 * already gave it.
 *
 * Two independent loads rather than one combined endpoint, because they fail
 * differently and the page has something honest to say in each case: with no
 * session list there is nothing to show below the composer, and with no host
 * list the composer cannot promise that anything will pick a task up. Folding
 * them together would make one failure hide the other.
 *
 * The host list is loaded and never displayed. It exists so the composer can run
 * `selectTarget` before the button is pressed; the page itself has no "where
 * work can run" board, because a person on a website cannot see, reach or wake
 * the machines such a board would list, and the one fact they need from it —
 * that a task cannot start, and why — reaches them as a sentence under the
 * composer instead.
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

/** Which slice of the already-loaded sessions "Recent tasks" is showing. */
type RecentFilter = "all" | "live" | "done";

const RECENT_FILTERS = [
  { value: "all", label: "All" },
  { value: "live", label: "In progress" },
  { value: "done", label: "Done" },
] as const satisfies readonly { value: RecentFilter; label: string }[];

export default function WorkHomePage() {
  const { user } = useApp();
  const [sessions, setSessions] = React.useState<ClientWorkSession[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = React.useState(false);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [hostsFailed, setHostsFailed] = React.useState(false);
  const [filter, setFilter] = React.useState<RecentFilter>("all");

  const loadSessions = React.useCallback(async () => {
    const result = await fetchWorkSessions();
    if (result.kind === "ok") {
      setSessions(result.value);
      setSessionsFailed(false);
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

  const reload = React.useCallback(() => {
    void loadSessions();
    void loadHosts();
  }, [loadSessions, loadHosts]);

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

  const attention = React.useMemo(
    () => (sessions ?? []).filter((session) => session.needsAttention),
    [sessions]
  );
  const recent = React.useMemo(() => {
    const rows = (sessions ?? []).filter(
      (session) => !session.needsAttention && !session.archived
    );
    // Pinned first, and otherwise exactly the order the route sent. The list
    // query already orders by last activity, so this is a stable partition
    // rather than a second sort: re-ordering the rest here would disagree with
    // the paging the route is built for the moment there are more than forty.
    return [...rows.filter((session) => session.pinned), ...rows.filter((session) => !session.pinned)];
  }, [sessions]);

  // The control is only offered once there is something to filter, and while it
  // is absent the list is unfiltered no matter what the state last held — a
  // hidden "Done" would otherwise empty a list the reader has no way to refill.
  const filterable = recent.length > 0;
  const activeFilter: RecentFilter = filterable ? filter : "all";
  const visible = React.useMemo(() => {
    // `isLiveStatus` / `isTerminalStatus` rather than a partition written out
    // again here: the two lists in domain.ts are the definition, and a third
    // copy would drift the first time a status is added to one of them.
    if (activeFilter === "live") return recent.filter((session) => isLiveStatus(session.status));
    if (activeFilter === "done") return recent.filter((session) => isTerminalStatus(session.status));
    return recent;
  }, [activeFilter, recent]);

  /*
   * One arrival tracker per list, not one for the page.
   *
   * A task that stops for an answer moves from "Recent tasks" to "Needs you".
   * That is a real arrival in the section it lands in — it also genuinely
   * remounts, since the two sections are different parents — and a single
   * page-wide tracker would have called it an old row and let it appear with no
   * entrance at all, in the one section on the page that exists to be noticed.
   *
   * Passed a fresh array each render on purpose: the hook keys off the ids
   * themselves, so memoising the array here would only be guarding a comparison
   * it already does.
   */
  const attentionArrivals = useWorkArrivals(attention.map((session) => session.id));
  const visibleArrivals = useWorkArrivals(visible.map((session) => session.id));

  /**
   * What to say when the filtered list is empty — which is never the same
   * sentence twice. "No tasks yet" is an invitation; "nothing is running" is a
   * status; and either one used in the other's place is a lie about the account.
   * `null` means the account genuinely has nothing at all, which is the only
   * case that earns the full empty card.
   */
  const emptyNote =
    activeFilter === "live"
      ? attention.length > 0
        ? "Nothing is running unattended — everything you have going is waiting on you, above."
        : "Nothing is running right now."
      : activeFilter === "done"
        ? "Nothing has finished yet."
        : attention.length > 0
          ? "Everything you have going is waiting on you, above."
          : null;

  const firstName = user.name?.split(" ")[0];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
        {/* Schedules and skills live under /work and are reachable from here
            rather than from the app sidebar: the sidebar is the switch between
            products, and three Work-internal destinations in it would make Work
            look like three of them. */}
        <div className="mb-6 flex justify-center">
          <WorkNav />
        </div>
        <div className="flex flex-col items-center text-center">
          <p className="mb-3 font-mono text-[11px] text-muted-foreground/80 [animation-fill-mode:backwards] motion-safe:animate-fade-in">
            Juno Work
          </p>
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
            <div className="flex items-center justify-end pr-[0.38em]">
              <JunoMark
                className={cn(
                  "block h-[1.32rem] w-[1.32rem] shrink-0 sm:h-[1.83rem] sm:w-[1.83rem]",
                  "[animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                )}
              />
            </div>
            <h1 className="text-center font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]">
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

        <div className="mt-7 sm:mt-9">
          <WorkComposer
            hosts={hosts}
            hostsFailed={hostsFailed}
            onRetryHosts={() => void loadHosts()}
          />
        </div>

        {attention.length > 0 && (
          <WorkSection
            title="Needs you"
            hint="These have stopped and cannot move until you decide something."
          >
            <div className="space-y-2.5">
              {attention.map((session) => (
                <WorkSessionRow
                  key={session.id}
                  session={session}
                  explain
                  enterDelayMs={attentionArrivals.delayFor(session.id)}
                  onChanged={replaceSession}
                />
              ))}
            </div>
          </WorkSection>
        )}

        <WorkSection
          title="Recent tasks"
          action={
            <div className="flex items-center gap-2">
              {filterable && (
                <SegmentedControl
                  value={activeFilter}
                  onChange={setFilter}
                  options={RECENT_FILTERS}
                  ariaLabel="Filter recent tasks"
                  optionClassName="gap-1.5 px-2.5 py-0.5 text-[12px]"
                />
              )}
              {sessionsFailed ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadSessions()}
                  className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
                </Button>
              )}
            </div>
          }
        >
          {sessionsFailed ? (
            <WorkStateNote
              tone="error"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadSessions()}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                </Button>
              }
            >
              Couldn’t load your tasks. This list is empty because the request failed, not because
              there is nothing here.
            </WorkStateNote>
          ) : (
            // The skeleton fades out over whatever the load turned out to be —
            // rows, an empty note, or the invitation. All three are the answer
            // to the same question, and only one of them being allowed to
            // resolve gently would make the other two feel like errors.
            <WorkCrossfade pending={sessions === null} placeholder={<WorkSessionSkeletons />}>
              {visible.length === 0 && emptyNote === null ? (
                <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
                  <p className="font-serif text-heading">No tasks yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                    Ask for something with a finish line — a folder tidied, a spreadsheet
                    reconciled, a weekly summary written. Juno plans it, shows you every step, and
                    asks before anything it cannot undo.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                  {emptyNote}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {visible.map((session) => (
                    <WorkSessionRow
                      key={session.id}
                      session={session}
                      enterDelayMs={visibleArrivals.delayFor(session.id)}
                      onChanged={replaceSession}
                    />
                  ))}
                </div>
              )}
            </WorkCrossfade>
          )}
        </WorkSection>
      </div>
    </div>
  );
}
