"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MessageCircle, RefreshCw, Telescope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { formatMicroUsd, runDuration } from "@/components/research/run-format";
import { RunStateBadge } from "@/components/research/run-state-badge";
import { IDLE_POLL_MS, WORKING_POLL_MS } from "@/components/research/use-research-run";
import { isWorkingResearchState } from "@/lib/research/domain";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The research library: every run this account has made, and the place to
 * start one. A research run is the longest-lived thing Juno produces — it
 * outlasts its request, often its conversation, and sometimes the tab — so it
 * gets what long-lived work gets everywhere else in the product (artifacts,
 * files, tasks): a page of its own where starting, tracking and reviewing are
 * one surface instead of three panels hidden in three chats.
 */

interface RunListItem {
  id: string;
  goal: string;
  state: string;
  conversationId: string | null;
  costMicroUsd: string;
  sourceCount: number;
  live: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** Below the schema's minimum the server would 400; catching it here turns a round trip into a disabled button. */
const MIN_GOAL_CHARS = 8;

export default function ResearchLibraryPage() {
  const router = useRouter();
  const [runs, setRuns] = React.useState<RunListItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [goal, setGoal] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const goalRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      let fresh: RunListItem[] | null = null;
      try {
        const res = await fetch("/api/research");
        if (!res.ok) throw new Error();
        fresh = ((await res.json()) as { runs?: RunListItem[] }).runs ?? [];
        if (stopped) return;
        setRuns(fresh);
        setError(false);
      } catch {
        if (stopped) return;
        // A failed poll on a page that was already showing runs keeps showing
        // them; only a first load with nothing behind it becomes the error
        // state. Either way the loop stops — retry is a button, not a hammer.
        setError(true);
        setRuns((previous) => previous ?? []);
        return;
      }
      // The panel's cadence, applied to the whole list: fast only while some
      // run is actually being driven, slow while one merely waits on a person,
      // and stopped entirely once everything is settled history.
      const anyWorking = fresh.some((run) => run.live && (isWorkingResearchState(run.state) || run.state === "accepted"));
      const anyLive = fresh.some((run) => run.live);
      if (!anyLive) return;
      timer = setTimeout(tick, anyWorking ? WORKING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = goal.trim();
    if (value.length < MIN_GOAL_CHARS || starting) return;
    setStarting(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: value }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        run?: { id: string };
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.run?.id) {
        // The server's words where it has them — plan gates, run limits and
        // configuration are its story to tell, not this page's to invent.
        throw new Error(data.message ?? data.error ?? "The run could not be started.");
      }
      router.push(`/research/${data.run.id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The run could not be started.");
      setStarting(false);
    }
  };

  const loading = runs === null;
  const items = runs ?? [];

  return (
    <div className="app-page-scroll">
      <main className="app-page-content max-w-3xl">
        <AppPageHeader
          eyebrow="Research"
          heading="Deep research"
          icon={Telescope}
          lede="Long investigations with sources, a cited report, and a citation check at the end."
          actions={
            !loading && !error && items.length > 0 ? (
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {items.length} {items.length === 1 ? "run" : "runs"}
              </span>
            ) : undefined
          }
        />

        {/* Starting a run lives on the page itself, not behind a dialog: this
            surface exists so that start, track and review are one place. */}
        <form onSubmit={start} className="rounded-card border border-border/60 bg-card p-4 sm:p-5">
          <label htmlFor="research-goal" className="font-mono text-label uppercase text-muted-foreground">
            New run
          </label>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="research-goal"
              ref={goalRef}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="What should Juno investigate?"
              className="h-10 flex-1"
            />
            <Button
              type="submit"
              disabled={starting || goal.trim().length < MIN_GOAL_CHARS}
              className="shrink-0 gap-1.5"
            >
              {starting ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Telescope className="size-3.5" aria-hidden />
              )}
              {starting ? "Drafting the plan…" : "Plan research"}
            </Button>
          </div>
          <p className="mt-2 text-caption text-muted-foreground">
            Juno drafts its searches first and waits for your approval — nothing is spent until you confirm the plan.
          </p>
        </form>

        {error && items.length === 0 ? (
          <EmptyState
            tone="error"
            className="mt-6"
            title="Couldn’t load your research"
            description="Check your connection and try once more."
            action={
              <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)} className="group/retry gap-2">
                <RefreshCw className="size-3.5 transition-transform duration-base group-hover/retry:rotate-45 motion-reduce:transition-none" />
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <div className="mt-6 flex flex-col gap-3" aria-label="Loading research runs">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-28 rounded-card" style={staggerDelay(i, "tight")} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            className="mt-6"
            icon={Telescope}
            title="No research yet"
            description="Give Juno a question above, or switch on Deep research in any chat. It plans its searches, reads and cross-checks real sources, then writes a report and audits every citation in it."
            action={
              <Button variant="outline" size="sm" onClick={() => goalRef.current?.focus()}>
                Start your first run
              </Button>
            }
          />
        ) : (
          <ul className="mt-6 flex flex-col gap-3">
            {items.map((run, i) => {
              const duration = runDuration(run.createdAt, run.finishedAt);
              return (
                <li
                  key={run.id}
                  style={staggerDelay(i, "tight")}
                  className={cn(
                    "group relative rounded-card border border-border/65 bg-card",
                    "transition-[border-color,background-color] duration-fast ease-out-soft hover:border-foreground/25 hover:bg-secondary",
                    "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                  )}
                >
                  <Link
                    href={`/research/${run.id}`}
                    className="block p-4 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <RunStateBadge state={run.state} />
                      <span className="font-mono text-caption tabular-nums text-muted-foreground">
                        {timeAgo(run.createdAt)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-body font-medium text-foreground">{run.goal}</p>
                    <p className="mt-1.5 font-mono text-caption tabular-nums text-muted-foreground">
                      {run.sourceCount} {run.sourceCount === 1 ? "source" : "sources"} · {formatMicroUsd(run.costMicroUsd)}
                      {duration ? ` · ${duration}` : ""}
                    </p>
                  </Link>
                  {run.conversationId && (
                    <Link
                      href={`/chat/${run.conversationId}`}
                      aria-label="Open the conversation this run started from"
                      title="Open conversation"
                      // z-10 keeps this clickable above the row's stretched link.
                      className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-control text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:size-10"
                    >
                      <MessageCircle className="size-3.5" aria-hidden />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
