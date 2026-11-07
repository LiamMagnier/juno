"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { ArrowRight, ArrowUpRight, ExternalLink as LinkIcon, ShieldAlert } from "@/components/ui/icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import { useReducedMotion } from "@/lib/motion-preference";
import { cn } from "@/lib/utils";
import type { AdminOverview } from "@/lib/admin-overview";

/* ── Formatting ──────────────────────────────────────────────────────────── */

const usd = (micro: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(micro / 1e6);
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
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

/** Percent change, or null when there is nothing to compare against. */
function delta(now: number, before: number): number | null {
  if (before <= 0) return null;
  return (now - before) / before;
}

/* ── Count-up ────────────────────────────────────────────────────────────── */

/**
 * A figure that counts up once, on first paint (650ms, strong ease-out). The
 * Overview is opened a few times a day at most, so a short arrival is earned;
 * reduced motion shows the final number at once.
 */
function useCountUp(target: number, reduce: boolean): number {
  const [value, setValue] = React.useState(reduce ? target : 0);
  React.useEffect(() => {
    if (reduce) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 650);
      const eased = 1 - Math.pow(1 - p, 4);
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce]);
  return value;
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function Delta({ value, neutral = false }: { value: number | null; neutral?: boolean }) {
  if (value === null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  // Spend is neither good nor bad news on its own, so it can be told without a colour.
  return (
    <span className={cn("adm-delta", neutral ? "adm-delta-neutral" : up ? "adm-delta-good" : "adm-delta-bad")}>
      <ArrowUpRight aria-hidden="true" className={cn("size-3", !up && "rotate-90")} />
      {Math.abs(Math.round(value * 100))}%
    </span>
  );
}

function Spark({ values, reduce }: { values: number[]; reduce: boolean }) {
  const max = Math.max(1, ...values);
  const w = 120;
  const h = 32;
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("adm-spark", !reduce && "adm-spark-draw")}>
      <path d={`${line} L${w},${h} L0,${h} Z`} className="adm-spark-area" />
      <path d={line} pathLength={1} className="adm-spark-line" />
    </svg>
  );
}

function Kpi({
  label,
  value,
  format,
  foot,
  spark,
  href,
  tone,
  index,
  reduce,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  foot?: React.ReactNode;
  spark?: number[];
  href?: string;
  tone?: "alert";
  index: number;
  reduce: boolean;
}) {
  const shown = useCountUp(value, reduce);
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui text-muted-foreground">{label}</span>
        {href ? <ArrowRight aria-hidden="true" className="adm-kpi-go size-4 text-muted-foreground" /> : null}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <span className={cn("adm-figure", tone === "alert" && value > 0 && "text-destructive-ink")}>{format(shown)}</span>
        {spark ? <Spark values={spark} reduce={reduce} /> : null}
      </div>
      <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">{foot}</div>
    </>
  );
  const cls = "adm-card adm-kpi adm-rise flex min-w-0 flex-col";
  const style = { ["--i" as string]: index };
  return href ? (
    <Link href={href} className={cn(cls, "adm-kpi-link")} style={style}>
      {body}
    </Link>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}

function SpendChart({ days, reduce }: { days: AdminOverview["days"]; reduce: boolean }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.spendMicroUsd));
  const total = days.reduce((s, d) => s + d.spendMicroUsd, 0);
  const shown = hover === null ? null : days[hover];
  return (
    <section aria-labelledby="adm-spend" className="adm-card adm-rise flex min-w-0 flex-col" style={{ ["--i" as string]: 4 }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="adm-spend" className="text-ui text-muted-foreground">
            Spend, last 30 days
          </h2>
          {/* The figure swaps to the hovered day: the chart has no axis
              labels to read, so its one number answers the pointer. */}
          <p className="adm-figure mt-2 tabular-nums">{shown ? usd(shown.spendMicroUsd) : usd(total)}</p>
          <p className="mt-1 text-caption text-muted-foreground">{shown ? dayLabel(shown.date) : `${dayLabel(days[0].date)} – ${dayLabel(days[days.length - 1].date)}`}</p>
        </div>
      </div>
      <div
        className={cn("adm-bars mt-6", !reduce && "adm-bars-grow")}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Daily spend over the last 30 days, ${usd(total)} in total.`}
      >
        {days.map((d, i) => (
          <div
            key={d.date}
            className="adm-bar-slot"
            data-active={hover === i ? "" : undefined}
            data-dim={hover !== null && hover !== i ? "" : undefined}
            onPointerEnter={() => setHover(i)}
          >
            <span
              className="adm-bar"
              data-zero={d.spendMicroUsd === 0 ? "" : undefined}
              style={{ height: `${Math.max(2, (d.spendMicroUsd / max) * 100)}%`, ["--c" as string]: i }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function TopModels({ models }: { models: AdminOverview["topModels"] }) {
  const top = models[0]?.spendMicroUsd || 1;
  return (
    <section aria-labelledby="adm-models" className="adm-card adm-rise flex min-w-0 flex-col" style={{ ["--i" as string]: 5 }}>
      <h2 id="adm-models" className="text-ui text-muted-foreground">
        Top models this month
      </h2>
      {models.length === 0 ? (
        <p className="mt-6 text-ui text-muted-foreground">No spend yet this month.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3.5">
          {models.map((m, i) => (
            <li key={m.model} className="min-w-0" title={`${compact(m.tokens)} tokens`}>
              <div className="flex items-center gap-2.5">
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {m.provider ? <ProviderLogo provider={m.provider} className="size-4" /> : null}
                </span>
                <span translate="no" className="min-w-0 flex-1 truncate text-ui text-foreground">
                  {m.label}
                </span>
                <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{usd(m.spendMicroUsd)}</span>
              </div>
              <span className="adm-share mt-1.5" style={{ width: `${Math.max(2, (m.spendMicroUsd / top) * 100)}%`, ["--i" as string]: i }} />
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
    <section aria-labelledby="adm-recent" className="adm-card adm-rise min-w-0" style={{ ["--i" as string]: 6 }}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="adm-recent" className="text-ui text-muted-foreground">
          Newest accounts
        </h2>
        <Link href="/admin/users" className="adm-link inline-flex items-center gap-1 text-ui text-muted-foreground">
          All users
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      <ul className="-mx-2 mt-3 grid gap-0.5 @[44rem]/page:grid-cols-2 @[44rem]/page:gap-x-4">
        {users.map((u) => (
          <li key={u.id} className="adm-row flex min-w-0 items-center gap-3 rounded-field px-2 py-2">
            {u.image ? (
              <Image
                src={u.image}
                unoptimized={requiresViewerCredentials(u.image)}
                alt=""
                width={32}
                height={32}
                className="size-8 shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
              />
            ) : (
              <DotIdenticon seed={u.id} className="size-8 shrink-0" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-foreground">{u.name || u.email.split("@")[0]}</span>
              <span className="block truncate text-caption text-muted-foreground">{u.email}</span>
            </span>
            {u.plan && u.plan !== "FREE" ? <span className="adm-plan shrink-0">{u.plan.toLowerCase()}</span> : null}
            <span className="w-8 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">{ago(u.createdAt, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function AdminOverviewView({ data }: { data: AdminOverview }) {
  const reduce = useReducedMotion() ?? false;
  const queue = data.queues.flagsToReview + data.queues.openReports;
  const spendDelta = delta(data.spend.monthMicroUsd, data.spend.prevMonthToDateMicroUsd);
  const signupDelta = delta(data.users.newThisWeek, data.users.newPrevWeek);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <AppPage measure="wide" contentClassName="adm flex flex-col gap-4 pb-16">
      <AppPageHeader className="mb-0" heading="Overview" lede={today} />

      <div className="adm-kpis">
        <Kpi
          index={0}
          reduce={reduce}
          label="Accounts"
          value={data.users.total}
          format={(n) => Math.round(n).toLocaleString("en-US")}
          spark={data.days.map((d) => d.signups)}
          foot={
            <>
              <span>+{data.users.newThisWeek} this week</span>
              <Delta value={signupDelta} />
            </>
          }
        />
        <Kpi
          index={1}
          reduce={reduce}
          label="Active this month"
          value={data.users.activeThisMonth}
          format={(n) => Math.round(n).toLocaleString("en-US")}
          foot={data.users.total > 0 ? <span>{Math.round((data.users.activeThisMonth / data.users.total) * 100)}% of accounts</span> : null}
        />
        <Kpi
          index={2}
          reduce={reduce}
          label="Spend this month"
          value={data.spend.monthMicroUsd}
          format={(n) => usd(n)}
          spark={data.days.map((d) => d.spendMicroUsd)}
          foot={
            <>
              <span>{compact(data.spend.monthTokens)} tokens</span>
              <Delta value={spendDelta} neutral />
            </>
          }
        />
        <Kpi
          index={3}
          reduce={reduce}
          label="Needs review"
          value={queue}
          tone="alert"
          format={(n) => Math.round(n).toString()}
          href={data.queues.flagsToReview > 0 || data.queues.openReports === 0 ? "/admin/moderation" : "/admin/links"}
          foot={
            queue === 0 ? (
              <span>All clear</span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1">
                  <ShieldAlert aria-hidden="true" className="size-3.5" />
                  {data.queues.flagsToReview} flags
                </span>
                <span className="inline-flex items-center gap-1">
                  <LinkIcon aria-hidden="true" className="size-3.5" />
                  {data.queues.openReports} reports
                </span>
              </>
            )
          }
        />
      </div>

      <div className="adm-split">
        <SpendChart days={data.days} reduce={reduce} />
        <TopModels models={data.topModels} />
      </div>

      <RecentUsers users={data.recentUsers} />
    </AppPage>
  );
}
