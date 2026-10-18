"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StopCircle, type IconComponent } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import { PhraseWithArgs, usePhrase } from "@/lib/i18n-phrase";
import type { PhraseSpec } from "@/lib/run/types";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_STATES,
  groupActivity,
  type ActivityCounts,
  type ActivityItem,
  type ActivityKind,
  type ActivityState,
} from "@/lib/activity/model";
import { ACTIVITY_COPY } from "@/components/activity/activity-copy";
import { ActivityStatusMark, STATUS_INK } from "@/components/activity/activity-status-mark";
import { stopActivityItem, useActivity } from "@/components/activity/use-activity";

/*
 * THE ACTIVITY PAGE (G70): one column of everything live, in four groups.
 *
 * Each row is one link to the surface that already owns the item: the chat
 * where a task's approval card renders, the Code session, the research run's
 * page. Approving or answering happens there, through the approval UI that
 * already checks the action digest; this page never re-implements a decision.
 * The one action it takes in place is Stop, through each product's own stop
 * endpoint, because stopping needs no context beyond "that one".
 *
 * Keyboard: the rows form one roving list. ↑/↓ (and j/k) move between them,
 * Home/End jump, Enter opens. Tab still reaches each row's Stop.
 */

type Filter = "all" | ActivityState;

const KIND_ICON: Record<ActivityKind, IconComponent> = {
  work: AppIcons.work,
  code: AppIcons.code,
  research: AppIcons.research,
};

export function ActivityView({ now: nowOverride }: { now?: number } = {}) {
  const { load, items, counts, hasMore, loadMore, loadingMore, refresh, retry } = useActivity();
  const [filter, setFilter] = React.useState<Filter>("all");
  const now = useNow(nowOverride);

  return (
    <AppPage measure="wide">
      <AppPageHeader heading={ACTIVITY_COPY.heading} lede={ACTIVITY_COPY.lede} />
      {load.kind === "loading" ? (
        <ActivitySkeleton />
      ) : load.kind === "error" ? (
        <LoadError title={ACTIVITY_COPY.loadError} onRetry={retry} />
      ) : (
        <ActivityBody
          items={items}
          counts={counts}
          filter={filter}
          onFilter={setFilter}
          now={now}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          onChanged={() => void refresh()}
        />
      )}
    </AppPage>
  );
}

/** A clock that ticks every 30s, so "running for 4 min" stays true without a refetch. */
function useNow(override?: number): number {
  const [now, setNow] = React.useState(() => override ?? Date.now());
  React.useEffect(() => {
    if (override !== undefined) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(id);
  }, [override]);
  return override ?? now;
}

export function ActivityBody({
  items,
  counts,
  filter,
  onFilter,
  now,
  hasMore,
  loadingMore,
  onLoadMore,
  onChanged,
}: {
  items: readonly ActivityItem[];
  counts: ActivityCounts | null;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  now: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onChanged: () => void;
}) {
  const groups = groupActivity(items, filter === "all" ? null : filter);
  const listRef = React.useRef<HTMLDivElement>(null);
  const filterLabel = usePhrase(ACTIVITY_COPY.filterLabel);

  if (items.length === 0 && !hasMore) {
    return (
      <EmptyState
        title={ACTIVITY_COPY.emptyTitle}
        description={ACTIVITY_COPY.emptyDescription}
        action={
          <Button asChild variant="secondary" size="sm">
            <Link href="/chat">{ACTIVITY_COPY.emptyAction}</Link>
          </Button>
        }
      />
    );
  }

  const total = counts ? counts.needs_you + counts.running + counts.ready + counts.blocked : items.length;
  const options: SegmentedOption<Filter>[] = [
    { value: "all", label: ACTIVITY_COPY.all, count: total },
    ...ACTIVITY_STATES.map((state) => ({
      value: state,
      label: ACTIVITY_COPY.states[state],
      ...(state === "needs_you" ? { badge: counts?.needs_you ?? 0 } : { count: counts?.[state] ?? 0 }),
    })),
  ];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches("[data-activity-row]")) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-activity-row]") ?? []);
    const at = rows.indexOf(target);
    if (at < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") next = Math.min(rows.length - 1, at + 1);
    else if (event.key === "ArrowUp" || event.key === "k") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div className="mt-2 space-y-6">
      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        <SegmentedControl<Filter>
          value={filter}
          onChange={onFilter}
          options={options}
          ariaLabel={filterLabel}
          size="sm"
          columns="content"
          className="min-w-max"
        />
      </div>

      <div ref={listRef} onKeyDown={onKeyDown} aria-describedby="activity-keyboard-hint">
        <p id="activity-keyboard-hint" className="sr-only">
          {ACTIVITY_COPY.keyboardHint}
        </p>
        {groups.length === 0 ? (
          <p className="rounded-card bg-muted/50 px-4 py-6 text-center text-ui text-muted-foreground">{ACTIVITY_COPY.filteredEmpty}</p>
        ) : (
          groups.map((group) => (
            <section key={group.state} aria-labelledby={`activity-group-${group.state}`} className="mb-6 last:mb-0">
              <header className="flex items-baseline gap-2 px-1 pb-1.5">
                <h2 id={`activity-group-${group.state}`} className={cn("flex items-center gap-1.5 text-label font-medium", STATUS_INK[group.state])}>
                  <ActivityStatusMark state={group.state} />
                  {ACTIVITY_COPY.states[group.state]}
                  <span className="font-mono text-micro tabular-nums text-muted-foreground" data-no-auto-translate>
                    {counts?.[group.state] ?? group.items.length}
                  </span>
                </h2>
                <p className="min-w-0 truncate text-micro text-muted-foreground">{ACTIVITY_COPY.hints[group.state]}</p>
              </header>
              <ul className="divide-y divide-border/60 overflow-hidden rounded-card border border-border/70 bg-background">
                {group.items.map((item) => (
                  <ActivityRow key={item.id} item={item} now={now} onChanged={onChanged} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loadingMore}>
            {ACTIVITY_COPY.showMore}
          </Button>
        </div>
      )}
    </div>
  );
}

function timeSpec(item: ActivityItem, now: number): PhraseSpec {
  if (item.state === "running") {
    const ms = Math.max(0, now - Date.parse(item.startedAt));
    return { parts: [{ phrase: ACTIVITY_COPY.runningFor }, { kind: "duration", ms: roundToMinute(ms), style: "narrow" }] };
  }
  const ms = Math.max(0, now - Date.parse(item.updatedAt));
  if (item.state === "needs_you") {
    return { parts: [{ phrase: ACTIVITY_COPY.waitingFor }, { kind: "duration", ms: roundToMinute(ms), style: "narrow" }] };
  }
  return { parts: [{ kind: "duration", ms: roundToMinute(ms), style: "narrow" }, { phrase: ACTIVITY_COPY.ago }] };
}

/** Whole minutes (at least one), or whole hours past two: a row is not a stopwatch. */
function roundToMinute(ms: number): number {
  const minute = 60_000;
  if (ms >= 2 * 60 * minute) return Math.round(ms / (60 * minute)) * 60 * minute;
  return Math.max(minute, Math.round(ms / minute) * minute);
}

export function ActivityRow({ item, now, onChanged }: { item: ActivityItem; now: number; onChanged: () => void }) {
  const [active, setActive] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const KindIcon = KIND_ICON[item.kind];
  const needWords = item.need ? ACTIVITY_COPY.needs[item.need] : null;
  const verb = item.state === "needs_you" && item.need ? ACTIVITY_COPY.verbs[item.need] : ACTIVITY_COPY.open;
  const stopWord = usePhrase(ACTIVITY_COPY.stop);
  const stateWord = usePhrase(ACTIVITY_COPY.states[item.state]);
  const kindWord = usePhrase(ACTIVITY_COPY.kinds[item.kind]);
  const stopFailed = usePhrase(ACTIVITY_COPY.stopFailed);

  const stop = async () => {
    setStopping(true);
    const ok = await stopActivityItem(item);
    setStopping(false);
    if (!ok) toast.error(stopFailed);
    onChanged();
  };

  return (
    <li
      className="group relative flex flex-col gap-2 px-3 py-2.5 transition-colors duration-150 hover:bg-accent/50 focus-within:bg-accent/50 sm:flex-row sm:items-center sm:gap-3 motion-safe:animate-rise-in"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
    >
      <Link
        href={item.href}
        data-activity-row=""
        aria-label={`${item.title}, ${kindWord}, ${stateWord}`}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-control outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="mt-[3px]">
          <ActivityStatusMark state={item.state} active={active} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            translate="no"
            className={cn("block truncate text-ui text-foreground", item.state === "ready" && "font-medium")}
          >
            {item.title}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <KindIcon motion="none" aria-hidden="true" className="size-3" />
              {ACTIVITY_COPY.kinds[item.kind]}
            </span>
            {needWords && (
              <>
                <span aria-hidden="true">·</span>
                <span className={cn(item.state === "needs_you" && STATUS_INK.needs_you)}>{needWords}</span>
              </>
            )}
            {item.needSummary && (
              <>
                <span aria-hidden="true">·</span>
                <span translate="no" className="min-w-0 truncate">
                  {item.needSummary}
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <PhraseWithArgs spec={timeSpec(item, now)} className="tabular-nums" />
          </span>
        </span>
      </Link>
      {/* Above the row's stretched link, so each is its own target. */}
      <div className="relative z-10 flex shrink-0 items-center gap-1.5 pl-[22px] sm:pl-0">
        {item.canStop && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void stop()}
            loading={stopping}
            aria-label={`${stopWord}: ${item.title}`}
          >
            <StopCircle motion="none" aria-hidden="true" className="size-3.5" />
            {stopping ? ACTIVITY_COPY.stopping : ACTIVITY_COPY.stop}
          </Button>
        )}
        <Button
          asChild
          variant={item.state === "needs_you" ? "secondary" : "ghost"}
          size="sm"
          tabIndex={-1}
          className="pointer-events-none sm:pointer-events-auto"
        >
          <Link href={item.href} tabIndex={-1} aria-hidden="true">
            {verb}
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function ActivitySkeleton() {
  return (
    <div role="status" aria-label={ACTIVITY_COPY.loading} className="mt-2 space-y-6">
      <Skeleton className="h-8 w-80 max-w-full rounded-field" />
      {[3, 2].map((rows, group) => (
        <div key={group} className="space-y-1.5">
          <Skeleton className="ml-1 h-3.5 w-24" />
          <div className="divide-y divide-border/60 rounded-card border border-border/70">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-3">
                <Skeleton className="size-3 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
