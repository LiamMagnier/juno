"use client";

import * as React from "react";
import { Flame, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ActivityHeatmap } from "@/components/settings/activity-heatmap";
import { useApp } from "@/components/app/app-provider";
import { resolveModel } from "@/lib/models";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { UsageBreakdown } from "@/lib/usage-breakdown";

/**
 * What the account has actually done, on the account page.
 *
 * Two feeds, one screen. `/api/profile/stats` is the year: a token count per
 * UTC day and the model mix, which is what the activity graph and the rhythm
 * bars are drawn from. `/api/profile/usage/breakdown?days=30` is the month:
 * streaks, pace and totals, which is what the figures at the top read from.
 * The plan's own budget comes from the bootstrap the whole app already holds,
 * so the "this month" figure matches the billing pane to the cent.
 */

interface ProfileStats {
  daily: Record<string, { tokens: number; count: number }>;
  models: { model: string; count: number; tokens: number }[];
  yearTokens?: number;
  yearMessages?: number;
  totalTokens: number;
  totalMessages: number;
  lifetime?: { tokens: number; messages: number; costMicroUsd: number; modelsTried: number };
  eurPerUsd?: number;
  memberSince: string | null;
}

interface Loaded {
  stats: ProfileStats;
  month: UsageBreakdown;
}

export function useProfileUsage() {
  const [data, setData] = React.useState<Loaded | null>(null);
  const [error, setError] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [stats, month] = await Promise.all([
        fetch("/api/profile/stats").then((r) => (r.ok ? (r.json() as Promise<ProfileStats>) : Promise.reject(new Error("stats")))),
        fetch("/api/profile/usage/breakdown?days=30").then((r) =>
          r.ok ? (r.json() as Promise<UsageBreakdown>) : Promise.reject(new Error("breakdown"))
        ),
      ]);
      setData({ stats, month });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

function eur(microUsd: number, rate: number): string {
  const amount = (microUsd / 1_000_000) * rate;
  if (amount > 0 && amount < 0.01) return "<0,01 €";
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function memberSinceLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_PLURAL: Record<string, string> = {
  Sun: "Sundays",
  Mon: "Mondays",
  Tue: "Tuesdays",
  Wed: "Wednesdays",
  Thu: "Thursdays",
  Fri: "Fridays",
  Sat: "Saturdays",
};

/** Tokens per weekday over the year, as a share of the busiest weekday. */
function weekdayRhythm(daily: ProfileStats["daily"]): Array<{ label: string; tokens: number; share: number; days: number }> {
  const totals = new Array<number>(7).fill(0);
  const activeDays = new Array<number>(7).fill(0);
  for (const [date, day] of Object.entries(daily)) {
    const [y, m, d] = date.split("-").map(Number);
    const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    totals[weekday] = (totals[weekday] ?? 0) + day.tokens;
    if (day.count > 0) activeDays[weekday] = (activeDays[weekday] ?? 0) + 1;
  }
  const max = Math.max(1, ...totals);
  // Monday first: that is how a week reads in the places this app is used.
  return [1, 2, 3, 4, 5, 6, 0].map((i) => ({
    label: WEEKDAYS[i]!,
    tokens: totals[i]!,
    share: totals[i]! / max,
    days: activeDays[i]!,
  }));
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  detail,
  i,
  children,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  i: number;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="surface-inset flex min-w-0 flex-col justify-between gap-2 rounded-card px-4 py-3.5 motion-safe:animate-fade-in-up"
      style={{ ...staggerDelay(i, "loose"), animationFillMode: "both" }}
    >
      <p className="font-mono text-label text-muted-foreground">{label}</p>
      <div>
        <p className="text-title font-medium leading-none tabular-nums text-foreground">{value}</p>
        {detail && <p className="mt-1.5 truncate text-caption text-muted-foreground">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

function StatSkeleton({ i }: { i: number }) {
  return (
    <div className="surface-inset flex flex-col gap-3 rounded-card px-4 py-3.5" style={staggerDelay(i, "loose")}>
      <span className="skeleton h-3 w-16 rounded-micro" />
      <span className="skeleton h-7 w-24 rounded-micro" />
      <span className="skeleton h-3 w-28 rounded-micro" />
    </div>
  );
}

function ModelMix({ models }: { models: ProfileStats["models"] }) {
  const top = models.slice(0, 5);
  const total = Math.max(1, models.reduce((n, m) => n + m.count, 0));
  if (top.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No model calls in the last year yet.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {top.map((entry, i) => {
        const resolved = resolveModel(entry.model);
        const share = entry.count / total;
        return (
          <li
            key={entry.model}
            className="flex items-center gap-3 motion-safe:animate-fade-in"
            style={{ ...staggerDelay(i, "loose"), animationFillMode: "both" }}
          >
            {resolved ? (
              <ProviderLogo provider={resolved.provider} className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0 rounded-full bg-muted" />
            )}
            <span className="w-36 shrink-0 truncate text-ui text-foreground sm:w-44">{resolved?.name ?? entry.model}</span>
            <span className="surface-inset relative h-2 min-w-0 flex-1 overflow-hidden rounded-full">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-primary/80 transition-transform duration-slow ease-out-soft motion-reduce:transition-none"
                style={{ width: "100%", transform: `scaleX(${Math.max(0.02, share)})`, transformOrigin: "left" }}
              />
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">
              {Math.round(share * 100)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Rhythm({ daily }: { daily: ProfileStats["daily"] }) {
  const days = React.useMemo(() => weekdayRhythm(daily), [daily]);
  const busiest = days.reduce((best, day) => (day.tokens > best.tokens ? day : best), days[0]!);
  const anything = days.some((day) => day.tokens > 0);
  return (
    <div>
      <div className="grid grid-cols-7 items-end gap-2" style={{ height: 88 }} role="img" aria-label={anything ? `Activity by weekday. Busiest: ${busiest.label}.` : "No weekday activity yet."}>
        {days.map((day, i) => (
          <div key={day.label} className="flex h-full flex-col items-center justify-end gap-1.5">
            <div className="flex w-full flex-1 items-end">
              <span
                title={`${day.label} · ${compactCount(day.tokens)} tokens · ${day.days} active ${day.days === 1 ? "day" : "days"}`}
                className={cn(
                  "block w-full origin-bottom rounded-t-xs transition-transform duration-slow ease-out-soft motion-reduce:transition-none",
                  day === busiest && day.tokens > 0 ? "bg-primary" : "bg-primary/35"
                )}
                style={{ height: "100%", transform: `scaleY(${anything ? Math.max(0.04, day.share) : 0.04})`, ...staggerDelay(i, "tight"), animationFillMode: "both" }}
              />
            </div>
            <span className={cn("font-mono text-micro", day === busiest && day.tokens > 0 ? "text-foreground" : "text-muted-foreground")}>
              {day.label}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        {anything ? (
          <>
            You use Juno most on <span className="text-foreground">{WEEKDAY_PLURAL[busiest.label] ?? busiest.label}</span>.
          </>
        ) : (
          "Your weekly rhythm appears here once you have used Juno for a few days."
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The overview
// ---------------------------------------------------------------------------

export function UsageStats({ data, loading, error, reload }: ReturnType<typeof useProfileUsage>) {
  const { spend, quota } = useApp();
  const rate = data?.stats.eurPerUsd && data.stats.eurPerUsd > 0 ? data.stats.eurPerUsd : spend.eurPerUsd || 1;
  const unlimited = spend.budgetMicroUsd === null || spend.budgetMicroUsd === undefined || spend.capDisabled;
  const monthPct = unlimited || !spend.budgetMicroUsd ? 0 : Math.min(1, spend.spentMicroUsd / spend.budgetMicroUsd);

  if (error) {
    return (
      <div className="surface-inset flex flex-wrap items-center justify-between gap-3 rounded-card px-4 py-3">
        <p className="text-sm text-muted-foreground">Your usage could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => void reload()} className="gap-1.5">
          <RefreshCw className="size-3.5" /> Try again
        </Button>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <StatSkeleton key={i} i={i} />
        ))}
      </div>
    );
  }

  const { month } = data;
  const streakHot = month.currentStreakDays >= 3;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        i={0}
        label="This month"
        value={unlimited ? "Unlimited" : eur(spend.spentMicroUsd, rate)}
        detail={
          unlimited
            ? `${quota.plan === "FREE" ? "Message" : "Spend"} ceiling off`
            : `of ${eur(spend.budgetMicroUsd ?? 0, rate)} · ${Math.round(monthPct * 100)}% used`
        }
      >
        {!unlimited && (
          <Progress
            value={Math.round(monthPct * 100)}
            tone={monthPct >= 1 ? "destructive" : monthPct >= 0.9 ? "warning" : "primary"}
            aria-label="Monthly spend"
            className="h-1.5"
          />
        )}
      </Stat>
      <Stat
        i={1}
        label="Last 30 days"
        value={compactCount(month.totals.requests)}
        detail={`${month.totals.requests === 1 ? "reply" : "replies"} · ${compactCount(month.totals.totalTokens)} tokens`}
      />
      <Stat
        i={2}
        label="Streak"
        value={
          <span className="inline-flex items-center gap-1.5">
            {month.currentStreakDays}
            <span className="text-body font-normal text-muted-foreground">{month.currentStreakDays === 1 ? "day" : "days"}</span>
            {streakHot && <Flame aria-hidden className="size-4 text-primary" />}
          </span>
        }
        detail={`Longest ${month.longestStreakDays} ${month.longestStreakDays === 1 ? "day" : "days"} this month`}
      />
      <Stat
        i={3}
        label="Active days"
        value={
          <span>
            {month.activeDays}
            <span className="text-body font-normal text-muted-foreground"> / {month.range.days}</span>
          </span>
        }
        detail={month.pace.last24h > 0 ? `${month.pace.last24h} in the last 24 h` : "Nothing in the last 24 h"}
      />
    </div>
  );
}

export function UsageActivity({ data, loading }: Pick<ReturnType<typeof useProfileUsage>, "data" | "loading">) {
  if (loading || !data) {
    return (
      <div className="space-y-2 pl-8">
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <span key={row} className="skeleton block h-[11px] w-full rounded-micro" style={staggerDelay(row, "tight")} />
        ))}
      </div>
    );
  }
  const year = data.stats.yearMessages ?? data.stats.totalMessages;
  const tokens = data.stats.yearTokens ?? data.stats.totalTokens;
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        <span className="tabular-nums text-foreground">{year.toLocaleString()}</span> {year === 1 ? "reply" : "replies"} and{" "}
        <span className="tabular-nums text-foreground">{compactCount(tokens)}</span> tokens in the last year
        {data.stats.memberSince && memberSinceLabel(data.stats.memberSince) && (
          <>
            {" "}
            · with Juno since <span className="text-foreground">{memberSinceLabel(data.stats.memberSince)}</span>
          </>
        )}
        .
      </p>
      <ActivityHeatmap daily={data.stats.daily} />
    </div>
  );
}

export function UsageDetail({ data, loading }: Pick<ReturnType<typeof useProfileUsage>, "data" | "loading">) {
  if (loading || !data) return null;
  return (
    <div className="grid gap-8 py-2 md:grid-cols-2">
      <div>
        <p className="mb-3 text-ui font-medium text-foreground">Weekly rhythm</p>
        <Rhythm daily={data.stats.daily} />
      </div>
      <div>
        <p className="mb-3 text-ui font-medium text-foreground">Models this year</p>
        <ModelMix models={data.stats.models} />
      </div>
    </div>
  );
}
