"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ArrowRight } from "@/components/ui/icons";
import { Monogram } from "@/components/ui/monogram";
import { requiresViewerCredentials } from "@/lib/image-source";
import type { AdminOverview } from "@/lib/admin-overview";

/* ── Formatting ──────────────────────────────────────────────────────────── */

const usd = (micro: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(micro / 1e6);
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const count = (n: number) => n.toLocaleString("en-US");
const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function ago(isoDate: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(isoDate).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

/** "12% more than last week", or null when there is nothing to compare. */
function versus(now: number, before: number, period: string): string | null {
  if (before <= 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `same as ${period}`;
  return `${Math.abs(pct)}% ${pct > 0 ? "more" : "less"} than ${period}`;
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

/**
 * One figure of the stats strip: a label, the number, and one plain line of
 * context. No sparkline, no coloured delta chip: the sentence says it.
 */
function Stat({ label, value, note, href }: { label: string; value: string; note?: string | null; href?: string }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-ui text-muted-foreground">
        {label}
        {href ? <ArrowRight aria-hidden="true" className="adm-go size-3.5" /> : null}
      </span>
      <span className="adm-figure mt-2 block">{value}</span>
      <span className="mt-1.5 block min-h-[1.125rem] truncate text-caption text-muted-foreground">{note}</span>
    </>
  );
  return href ? (
    <Link href={href} className="adm-stat adm-stat-link">
      {body}
    </Link>
  ) : (
    <div className="adm-stat">{body}</div>
  );
}

function SpendChart({ days }: { days: AdminOverview["days"] }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.spendMicroUsd));
  const total = days.reduce((s, d) => s + d.spendMicroUsd, 0);
  const shown = hover === null ? null : days[hover];
  return (
    <section aria-labelledby="adm-spend" className="adm-panel flex min-w-0 flex-col">
      <header className="flex items-baseline justify-between gap-4">
        <h2 id="adm-spend" className="text-ui font-medium text-foreground">
          Spend
        </h2>
        {/* The one number answers the pointer: the total, or the hovered day. */}
        <p className="text-ui tabular-nums text-muted-foreground">
          {shown ? (
            <>
              {dayLabel(shown.date)} <span className="ml-1.5 text-foreground">{usd(shown.spendMicroUsd)}</span>
            </>
          ) : (
            <>
              30 days <span className="ml-1.5 text-foreground">{usd(total)}</span>
            </>
          )}
        </p>
      </header>
      <div
        className="adm-bars mt-6"
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Daily spend over the last 30 days, ${usd(total)} in total.`}
      >
        {days.map((d, i) => (
          <div key={d.date} className="adm-bar-slot" data-active={hover === i ? "" : undefined} onPointerEnter={() => setHover(i)}>
            <span className="adm-bar" style={{ height: d.spendMicroUsd === 0 ? "1px" : `${Math.max(3, (d.spendMicroUsd / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-caption tabular-nums text-muted-foreground" aria-hidden="true">
        <span>{dayLabel(days[0].date)}</span>
        <span>Today</span>
      </div>
    </section>
  );
}

function TopModels({ models }: { models: AdminOverview["topModels"] }) {
  const total = models.reduce((s, m) => s + m.spendMicroUsd, 0) || 1;
  return (
    <section aria-labelledby="adm-models" className="adm-panel flex min-w-0 flex-col">
      <h2 id="adm-models" className="text-ui font-medium text-foreground">
        Models this month
      </h2>
      {models.length === 0 ? (
        <p className="mt-4 text-ui text-muted-foreground">No spend yet this month.</p>
      ) : (
        <ol className="adm-list mt-3">
          {models.map((m) => (
            <li key={m.model} className="flex min-w-0 items-center gap-3 py-2.5">
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {m.provider ? <ProviderLogo provider={m.provider} className="size-4" /> : null}
              </span>
              <span translate="no" className="min-w-0 flex-1 truncate text-ui text-foreground">
                {m.label}
              </span>
              <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{Math.round((m.spendMicroUsd / total) * 100)}%</span>
              <span className="w-14 shrink-0 text-right text-ui tabular-nums text-foreground">{usd(m.spendMicroUsd)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RecentUsers({ users }: { users: AdminOverview["recentUsers"] }) {
  const [now] = React.useState(() => Date.now());
  return (
    <section aria-labelledby="adm-recent" className="adm-panel min-w-0">
      <header className="flex items-baseline justify-between gap-4">
        <h2 id="adm-recent" className="text-ui font-medium text-foreground">
          Newest accounts
        </h2>
        <Link href="/admin/users" className="adm-link text-ui text-muted-foreground">
          All users
        </Link>
      </header>
      <ul className="adm-list mt-3 @[44rem]/page:grid @[44rem]/page:grid-cols-2 @[44rem]/page:gap-x-8">
        {users.map((u) => (
          <li key={u.id} className="flex min-w-0 items-center gap-3 py-2.5">
            {u.image ? (
              <Image
                src={u.image}
                unoptimized={requiresViewerCredentials(u.image)}
                alt=""
                width={28}
                height={28}
                className="size-7 shrink-0 rounded-full object-cover"
              />
            ) : (
              <Monogram name={u.name || u.email} className="size-7" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-foreground">{u.name || u.email.split("@")[0]}</span>
              <span className="block truncate text-caption text-muted-foreground">{u.email}</span>
            </span>
            {u.plan && u.plan !== "FREE" ? <span className="shrink-0 text-caption capitalize text-muted-foreground">{u.plan.toLowerCase()}</span> : null}
            <span className="w-8 shrink-0 text-right text-caption tabular-nums text-muted-foreground">{ago(u.createdAt, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

/**
 * The Admin Overview, drawn like a ledger rather than a dashboard template:
 * one strip of four figures divided by hairlines, then the spend, the models
 * and the newest accounts on flat hairline panels. One ink, sans figures,
 * context as plain sentences, and no arrival choreography: an owner opens
 * this to read numbers, and numbers should simply be there.
 */
export function AdminOverviewView({ data }: { data: AdminOverview }) {
  const queue = data.queues.flagsToReview + data.queues.openReports;
  const spend = versus(data.spend.monthMicroUsd, data.spend.prevMonthToDateMicroUsd, "last month");
  const activeShare = data.users.total > 0 ? Math.round((data.users.activeThisMonth / data.users.total) * 100) : null;
  const queueNote =
    queue === 0
      ? "Nothing waiting"
      : [
          data.queues.flagsToReview > 0 && `${data.queues.flagsToReview} ${data.queues.flagsToReview === 1 ? "flag" : "flags"}`,
          data.queues.openReports > 0 && `${data.queues.openReports} ${data.queues.openReports === 1 ? "report" : "reports"}`,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <AppPage measure="wide" contentClassName="adm flex flex-col gap-4 pb-16">
      <AppPageHeader className="mb-2" heading="Overview" />

      <div className="adm-stats">
        <Stat
          label="Accounts"
          value={count(data.users.total)}
          note={data.users.newThisWeek > 0 ? `${data.users.newThisWeek} new this week` : "None new this week"}
        />
        <Stat label="Active this month" value={count(data.users.activeThisMonth)} note={activeShare === null ? null : `${activeShare}% of accounts`} />
        <Stat label="Spend this month" value={usd(data.spend.monthMicroUsd)} note={spend ?? `${compact(data.spend.monthTokens)} tokens`} />
        <Stat
          label="To review"
          value={count(queue)}
          note={queueNote}
          href={queue === 0 ? undefined : data.queues.flagsToReview > 0 ? "/admin/moderation" : "/admin/links"}
        />
      </div>

      <div className="adm-split">
        <SpendChart days={data.days} />
        <TopModels models={data.topModels} />
      </div>

      <RecentUsers users={data.recentUsers} />
    </AppPage>
  );
}
