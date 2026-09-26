"use client";

import * as React from "react";
import { SettingsInlineError } from "@/components/settings/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettingsResource } from "@/components/settings/use-settings-resource";
import { compactCount, formatEur, formatShortDay } from "@/components/settings/format";
import { cn } from "@/lib/utils";
import type { UsageBreakdown } from "@/lib/usage-breakdown";

const DAYS = 30;
const DAY_MS = 86_400_000;
/** The chart's drawing height; bars are a share of it. */
const CHART_PX = 72;

interface HistoryDay {
  dayMs: number;
  requests: number;
  costMicroUsd: number;
}

/** The ledger's series is sparse (quiet days are absent); the chart needs every day. */
function fillDays(breakdown: UsageBreakdown): HistoryDay[] {
  const byDay = new Map(breakdown.daily.map((d) => [d.dayMs, d]));
  const start = Math.floor(breakdown.range.startMs / DAY_MS) * DAY_MS;
  return Array.from({ length: breakdown.range.days }, (_, i) => {
    const dayMs = start + i * DAY_MS;
    const day = byDay.get(dayMs);
    return { dayMs, requests: day?.requests ?? 0, costMicroUsd: day?.costMicroUsd ?? 0 };
  });
}

function parseBreakdown(body: unknown): UsageBreakdown {
  const b = body as UsageBreakdown | null;
  if (!b || !Array.isArray(b.daily) || !b.range || !b.totals) throw new Error("malformed breakdown");
  return b;
}

/**
 * The last thirty days, as one calm bar per day.
 *
 * It replaces the account page's dashboard: four stat tiles, a 53 by 7
 * contribution grid whose every square was its own tab stop (about 365 of
 * them before the sign-in controls), weekday bars and a model mix, each
 * dealt in on its own stagger. The question a reader brings here is "how
 * much have I been using it", and a month of bars under one sentence answers
 * it.
 *
 * One tab stop. The chart is a single focusable group: the arrow keys walk
 * the days, Home and End jump to the ends, and the line above the bars (a
 * polite live region) reads out the day the pointer or the keyboard is on.
 * Nothing loops and nothing is staggered; the bars draw at rest.
 */
export function UsageHistory({ eurPerUsd, showCost }: { eurPerUsd: number; showCost: boolean }) {
  const history = useSettingsResource(`/api/profile/usage/breakdown?days=${DAYS}`, parseBreakdown);
  return (
    <UsageHistoryView
      breakdown={history.data}
      failed={history.error && history.data === null}
      onRetry={() => void history.reload()}
      eurPerUsd={eurPerUsd}
      showCost={showCost}
    />
  );
}

/** The chart, drawn from data: the dev gallery renders this with fixtures. */
export function UsageHistoryView({
  breakdown,
  failed,
  onRetry,
  eurPerUsd,
  showCost,
}: {
  breakdown: UsageBreakdown | null;
  failed: boolean;
  onRetry: () => void;
  eurPerUsd: number;
  showCost: boolean;
}) {
  const days = React.useMemo(() => (breakdown ? fillDays(breakdown) : []), [breakdown]);
  const [active, setActive] = React.useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.requests));
  const eur = (micro: number) => formatEur((micro / 1_000_000) * (eurPerUsd > 0 ? eurPerUsd : 1));

  if (failed) {
    return (
      <SettingsInlineError onRetry={onRetry}>Couldn’t load your usage history.</SettingsInlineError>
    );
  }

  if (!breakdown) {
    return (
      <div className="py-4" aria-hidden="true">
        <Skeleton className="h-[1.5em] w-64 max-w-full rounded-xs text-ui" />
        <Skeleton className="mt-3 w-full rounded-control" style={{ height: CHART_PX }} />
        <Skeleton className="mt-2 h-[1.45em] w-full rounded-xs text-caption" />
      </div>
    );
  }

  const { totals } = breakdown;
  const focused = active !== null ? days[active] : null;
  const busiest = days.reduce<HistoryDay | null>((best, d) => (!best || d.requests > best.requests ? d : best), null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = days.length - 1;
    const at = active ?? last;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (event.key === "ArrowRight") next = Math.min(last, at + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div className="py-4">
      {/* The summary, or the day under the pointer or the keyboard. */}
      <p className="min-h-[1.5em] text-ui text-muted-foreground" aria-live="polite">
        {focused ? (
          <>
            <span className="text-foreground">{formatShortDay(focused.dayMs)}</span>
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">{focused.requests.toLocaleString()}</span>{" "}
            <span>{focused.requests === 1 ? "reply" : "replies"}</span>
            {showCost && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="tabular-nums">{eur(focused.costMicroUsd)}</span>
              </>
            )}
          </>
        ) : totals.requests === 0 ? (
          <span>Nothing in the last 30 days.</span>
        ) : (
          <>
            <span className="tabular-nums text-foreground">{totals.requests.toLocaleString()}</span>{" "}
            <span>{totals.requests === 1 ? "reply" : "replies"}</span>
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">{compactCount(totals.totalTokens)}</span> <span>tokens</span>
            {showCost && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="tabular-nums">{eur(totals.costMicroUsd)}</span>
              </>
            )}
            <span aria-hidden="true"> · </span>
            <span>last 30 days</span>
          </>
        )}
      </p>

      <div
        role="group"
        aria-roledescription="chart"
        aria-label="Replies per day, last 30 days. Use the arrow keys to read a day."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="mt-3 flex items-end gap-[3px] rounded-xs"
        style={{ height: CHART_PX }}
      >
        {days.map((day, i) => {
          const share = day.requests / max;
          const isActive = active === i;
          const isBusiest = !focused && busiest !== null && busiest.requests > 0 && day === busiest;
          return (
            <div
              key={day.dayMs}
              onPointerEnter={() => setActive(i)}
              className="flex h-full min-w-0 flex-1 items-end"
              aria-hidden="true"
            >
              {/* A quiet day still draws a 2px stub, so the month reads as
                  thirty days rather than as a few floating bars. */}
              <span
                className={cn(
                  "block w-full rounded-t-xs transition-colors duration-fast ease-out-soft",
                  day.requests === 0
                    ? "bg-border"
                    : isActive || isBusiest
                      ? "bg-primary"
                      : active !== null
                        ? "bg-muted-foreground/35"
                        : "bg-muted-foreground/45"
                )}
                style={{ height: day.requests === 0 ? 2 : Math.max(3, Math.round(share * CHART_PX)) }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-caption text-muted-foreground" aria-hidden="true">
        <span>{days[0] ? formatShortDay(days[0].dayMs) : null}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
