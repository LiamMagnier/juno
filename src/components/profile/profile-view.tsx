"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { AppPage } from "@/components/app/app-page";
import { PageBackdrop } from "@/components/app/page-backdrop";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { requiresViewerCredentials } from "@/lib/image-source";
import { cn } from "@/lib/utils";
import {
  formatDayLong,
  formatDays,
  formatDuration,
  formatTokens,
  formatTokensExact,
  type ProfileActivity,
} from "@/lib/profile-activity";
import { ActivityChart, type ActivityView } from "@/components/profile/activity-chart";
import "@/components/profile/profile.css";

export interface ProfileIdentity {
  id: string;
  name: string | null;
  handle: string;
  image: string | null;
}

const VIEWS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "cumulative", label: "Cumulative" },
] as const;

/**
 * The profile: who you are, and a year of what you have used.
 *
 * A centred identity under the homepage's construction, one hairline strip
 * of five figures, the activity chart and the models it went to. No
 * showcase, no public toggle and no Share: profiles are not public, and a
 * button that cannot do what it says is not shipped. Edit goes to Settings,
 * Account, with the username field open (the photo is changed there too).
 *
 * Drawn from props so the dev gallery renders it with fixtures
 * (src/app/dev/profile); ProfilePage feeds it from /api/profile/activity.
 */
export function ProfileView({
  identity,
  activity,
  failed = false,
  onRetry,
  editHref = "/settings?section=account&focus=username",
}: {
  identity: ProfileIdentity;
  /** Null while loading. */
  activity: ProfileActivity | null;
  failed?: boolean;
  onRetry?: () => void;
  editHref?: string;
}) {
  // The arrival plays once; later view switches only cross-fade.
  const [entered, setEntered] = React.useState(false);
  const loaded = activity !== null;
  React.useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => setEntered(true), 1600);
    return () => window.clearTimeout(t);
  }, [loaded]);

  return (
    <AppPage measure="wide" className="pf">
      <div className="@container/pfpage pb-24">
        <header className="relative isolate pb-10 pt-12 @[40rem]/pfpage:pt-16">
          <PageBackdrop />
          <div className="absolute right-0 top-4 flex items-center gap-1.5">
            <Button asChild variant="outline" size="sm">
              <Link href={editHref}>Edit</Link>
            </Button>
          </div>
          <div className="flex flex-col items-center text-center motion-safe:animate-rise-in">
            <Avatar identity={identity} />
            <h1 translate="no" className="pf-name mt-5 max-w-full text-balance text-foreground">
              {identity.name || identity.handle}
            </h1>
            <p translate="no" className="mt-2 text-body text-muted-foreground">
              @{identity.handle}
            </p>
          </div>
        </header>

        {failed && !activity ? (
          <LoadError title="Couldn’t load your activity" onRetry={onRetry} className="py-16" />
        ) : (
          <>
            <StatStrip activity={activity} />
            <ActivitySection activity={activity} animate={!entered} />
            <ModelsSection activity={activity} animate={!entered} />
          </>
        )}
      </div>
    </AppPage>
  );
}

function Avatar({ identity }: { identity: ProfileIdentity }) {
  return identity.image ? (
    <Image
      src={identity.image}
      unoptimized={requiresViewerCredentials(identity.image)}
      alt=""
      width={88}
      height={88}
      priority
      className="size-[88px] shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
    />
  ) : (
    <DotIdenticon seed={identity.id} className="size-[88px] shrink-0" />
  );
}

function StatStrip({ activity }: { activity: ProfileActivity | null }) {
  const stats: { label: string; value: string | null; title?: string; small?: boolean }[] = activity
    ? [
        { label: "Lifetime tokens", value: formatTokens(activity.lifetimeTokens), title: `${formatTokensExact(activity.lifetimeTokens)} tokens` },
        {
          label: "Peak day",
          value: activity.peakDay ? formatTokens(activity.peakDay.tokens) : "0",
          title: activity.peakDay ? `${formatTokensExact(activity.peakDay.tokens)} tokens on ${formatDayLong(activity.peakDay.date)}` : undefined,
        },
        activity.longestTask
          ? {
              label: "Longest task",
              value: formatDuration(activity.longestTask.ms),
              title: activity.longestTask.kind === "work" ? "Longest finished Work task" : "Longest finished deep research",
            }
          : { label: "Longest task", value: "None yet", small: true },
        { label: "Longest streak", value: formatDays(activity.streak.longest) },
        { label: "Current streak", value: formatDays(activity.streak.current) },
      ]
    : ["Lifetime tokens", "Peak day", "Longest task", "Longest streak", "Current streak"].map((label) => ({ label, value: null }));

  return (
    <dl className="pf-strip">
      {stats.map((s, i) => (
        <div
          key={s.label}
          title={s.title}
          className="flex min-w-0 flex-col-reverse items-center gap-2 px-4 py-5 text-center motion-safe:animate-rise-in"
          style={{ animationDelay: `${80 + i * 40}ms`, animationFillMode: "both" }}
        >
          <dt className="text-caption text-muted-foreground">{s.label}</dt>
          <dd className={cn("pf-figure truncate text-foreground", s.small && "pf-figure-sm")}>
            {s.value ?? <Skeleton className="inline-block h-7 w-16 align-middle" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SectionHead({ id, title, meta, children }: { id: string; title: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h2 id={id} className="pf-h2 text-foreground">
          {title}
        </h2>
        {meta && <div className="mt-1 text-ui text-muted-foreground">{meta}</div>}
      </div>
      {children}
    </div>
  );
}

function ActivitySection({ activity, animate }: { activity: ProfileActivity | null; animate: boolean }) {
  const [view, setView] = React.useState<ActivityView>("daily");
  const yearTokens = activity?.days.reduce((s, d) => s + d.tokens, 0) ?? 0;
  const empty = activity !== null && activity.lifetimeTokens === 0;

  return (
    <section aria-labelledby="pf-activity" className="mt-14">
      <SectionHead
        id="pf-activity"
        title="Token activity"
        meta={
          activity === null ? (
            <Skeleton className="inline-block h-4 w-48 align-middle" />
          ) : empty ? (
            "Nothing yet this year"
          ) : (
            `${formatTokens(yearTokens)} tokens in the last year`
          )
        }
      >
        <SegmentedControl value={view} onChange={setView} options={VIEWS} ariaLabel="Activity view" />
      </SectionHead>

      {activity === null ? (
        <Skeleton className="h-[136px] w-full rounded-card" />
      ) : (
        <>
          <ActivityChart days={activity.days} today={activity.today} view={view} animate={animate} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-caption text-muted-foreground">
            <span>
              {empty
                ? "Each day you chat, research or run a task fills a square."
                : `Days in ${activity.timeZone.replace(/_/g, " ")} time`}
            </span>
            {view === "daily" && (
              <span className="flex items-center gap-1.5" aria-hidden="true">
                Less
                {[0, 1, 2, 3, 4].map((l) => (
                  <span key={l} className="pf-cell size-[11px]" data-level={l} />
                ))}
                More
              </span>
            )}
          </div>
          {empty && (
            <div className="mt-6">
              <Button asChild variant="outline" size="sm">
                <Link href="/chat">Start a chat</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ModelsSection({ activity, animate }: { activity: ProfileActivity | null; animate: boolean }) {
  const models = activity?.models ?? [];
  const top = models[0]?.share ?? 1;
  return (
    <section aria-labelledby="pf-models" className="mt-16">
      <SectionHead
        id="pf-models"
        title="Models"
        meta={
          activity === null ? (
            <Skeleton className="inline-block h-4 w-32 align-middle" />
          ) : activity.modelCount === 0 ? (
            "The models you use will be ranked here."
          ) : (
            `${activity.modelCount} ${activity.modelCount === 1 ? "model" : "models"} used, by tokens`
          )
        }
      />
      {activity === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full rounded-control" />
          ))}
        </div>
      ) : models.length > 0 ? (
        <ol className={cn("-mx-2.5", animate && "pf-enter")}>
          {models.map((m, i) => (
            <li
              key={m.model}
              title={`${formatTokensExact(m.tokens)} tokens across ${formatTokensExact(m.requests)} ${m.requests === 1 ? "request" : "requests"}`}
              className="pf-model grid grid-cols-[1rem_minmax(0,1fr)_auto_3rem] items-center gap-x-3 gap-y-2 rounded-control px-2.5 py-2.5 transition-colors duration-fast ease-out-soft hover:bg-accent @[44rem]/pfpage:grid-cols-[1rem_minmax(0,14rem)_minmax(0,1fr)_5rem_3rem]"
            >
              <span className="flex size-4 items-center justify-center text-muted-foreground">
                {m.provider ? <ProviderLogo provider={m.provider} className="size-4" /> : null}
              </span>
              <span translate="no" className="truncate text-body text-foreground">
                {m.label}
              </span>
              <span className="col-span-3 col-start-2 row-start-2 @[44rem]/pfpage:col-span-1 @[44rem]/pfpage:col-start-3 @[44rem]/pfpage:row-start-1">
                <span
                  className="pf-share block"
                  style={{ width: `${Math.max(1.5, (m.share / top) * 100)}%`, ["--i" as string]: i }}
                />
              </span>
              <span className="pf-mono text-right text-ui text-foreground">{formatTokens(m.tokens)}</span>
              <span className="pf-mono text-right text-ui text-muted-foreground">{formatShare(m.share)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
