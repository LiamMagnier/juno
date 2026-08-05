"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { WorkComposer } from "@/components/work/work-composer";
import { WorkHostPanel } from "@/components/work/work-host-panel";
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
 * Polled on the same trio the Code sidebar uses — interval, visibility, sync
 * event — because a queued task becomes a running task without anybody
 * clicking, and a page that only loads on mount freezes on whatever it saw
 * first.
 */

export default function WorkHomePage() {
  const { user } = useApp();
  const [sessions, setSessions] = React.useState<ClientWorkSession[] | null>(null);
  const [sessionsFailed, setSessionsFailed] = React.useState(false);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [hostsFailed, setHostsFailed] = React.useState(false);

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
    // says nothing about whether a Mac is awake, and replacing a real answer
    // with "unavailable" would state something the failure did not establish.
    // The failure itself is carried separately, in `hostsFailed`.
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

  const attention = React.useMemo(
    () => (sessions ?? []).filter((session) => session.needsAttention),
    [sessions]
  );
  const recent = React.useMemo(
    () => (sessions ?? []).filter((session) => !session.needsAttention && !session.archived),
    [sessions]
  );
  const firstName = user.name?.split(" ")[0];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
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
              {attention.map((session, index) => (
                <WorkSessionRow key={session.id} session={session} explain index={index} />
              ))}
            </div>
          </WorkSection>
        )}

        <WorkSection
          title="Recent tasks"
          action={
            sessionsFailed ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadSessions()}
                className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
              </Button>
            )
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
          ) : sessions === null ? (
            <WorkSessionSkeletons />
          ) : recent.length === 0 && attention.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
              <p className="font-serif text-heading">No tasks yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Ask for something with a finish line — a folder tidied, a spreadsheet reconciled, a
                weekly summary written. Juno plans it, shows you every step, and asks before
                anything it cannot undo.
              </p>
            </div>
          ) : recent.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              Everything you have going is waiting on you, above.
            </p>
          ) : (
            <div className="space-y-2.5">
              {recent.map((session, index) => (
                <WorkSessionRow key={session.id} session={session} index={index} />
              ))}
            </div>
          )}
        </WorkSection>

        <WorkSection
          title="Where work can run"
          hint="What each executor is offering right now, rather than what it can do in principle."
        >
          <WorkHostPanel hosts={hosts} failed={hostsFailed} onRetry={() => void loadHosts()} />
        </WorkSection>
      </div>
    </div>
  );
}
