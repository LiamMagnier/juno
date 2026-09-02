"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { toast } from "sonner";
import { Camera, Loader2, MessageSquare } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Badge } from "@/components/ui/badge";
import { openSettings } from "@/components/settings/settings-sections";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useApp } from "@/components/app/app-provider";
import { PLANS } from "@/lib/plans";
import { resolveModel } from "@/lib/models";
import { providerAccent } from "@/lib/provider-colors";
import { cn, formatUsd } from "@/lib/utils";

interface KindSpend {
  kind: string;
  count: number;
  costMicroUsd: number;
  tokensIn?: number;
  tokensOut?: number;
}

interface ModelSpend {
  model: string;
  count: number;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
}

interface Stats {
  daily: Record<string, { tokens: number; count: number }>;
  models: { model: string; count: number; tokens: number }[];
  /** Year-window totals for the heatmap caption (preferred). */
  yearTokens?: number;
  yearMessages?: number;
  /** Lifetime totals (also mirrored from lifetime.* for older shapes). */
  totalTokens: number;
  totalMessages: number;
  lifetime?: {
    tokens: number;
    tokensIn?: number;
    tokensOut?: number;
    messages: number;
    costMicroUsd: number;
    storedCostMicroUsd?: number;
    modelsTried: number;
    byKind: KindSpend[];
    byModel?: ModelSpend[];
  };
  eurPerUsd?: number;
  memberSince: string | null;
}

const KIND_LABEL: Record<string, string> = {
  chat: "Chat",
  image: "Image",
  video: "Video",
  voice: "Voice",
  code: "Code",
  task: "Tasks",
};

function kindLabel(kind: string) {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatLifetimeCost(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return formatUsd(usd);
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1_000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const LEVEL_BG = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];
const DOW = ["", "Mon", "", "Wed", "", "Fri", ""];

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * `YYYY-MM-DD` for the day this Date falls on WHERE THE USER IS.
 *
 * The grid walks local days (it starts from local midnight) but used to key them
 * with `toISOString()`, which is UTC. East of UTC local midnight is still the
 * previous UTC day, so every cell was looked up — and its tooltip labelled — one
 * day early: the whole year shifted a square left and today's generations landed
 * in a cell that no longer existed on the grid.
 */
function toLocalISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildWeeks(daily: Stats["daily"]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const days: { date: string; tokens: number; count: number }[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const ds = toLocalISODate(d);
    days.push({ date: ds, tokens: daily[ds]?.tokens ?? 0, count: daily[ds]?.count ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const level = (t: number) => (t === 0 ? 0 : t < max * 0.25 ? 1 : t < max * 0.5 ? 2 : t < max * 0.75 ? 3 : 4);
  const cells = days.map((d) => ({ ...d, level: level(d.tokens) }));
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function TokenHeatmap({ daily }: { daily: Stats["daily"] }) {
  const weeks = React.useMemo(() => buildWeeks(daily), [daily]);
  return (
    <div className="flex gap-2">
      <div className="flex flex-col gap-[3px] pt-[2px] font-mono text-caption text-muted-foreground">
        {DOW.map((d, i) => (
          <span key={i} className="flex h-[11px] items-center">{d}</span>
        ))}
      </div>
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {Array.from({ length: 7 }).map((_, di) => {
              const cell = week[di];
              if (!cell) return <span key={di} className="h-[11px] w-[11px]" />;
              return (
                <span
                  key={di}
                  title={`${cell.date} · ${cell.tokens.toLocaleString()} tokens`}
                  className={cn("h-[11px] w-[11px] rounded-micro", LEVEL_BG[cell.level])}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}



export default function ProfilePage() {
  const router = useRouter();
  const { user, quota } = useApp();
  const plan = PLANS[quota.plan];
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState(false);
  const [avatar, setAvatar] = React.useState<string | null>(user.image ?? null);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // A callback, not an inline effect body: the fetch had no retry at all, so one
  // transient blip left the page permanently stubbed until a manual reload.
  const loadStats = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/profile/stats");
      if (!r.ok) throw new Error();
      setStats(await r.json());
    } catch {
      setError(true);
    }
  }, []);

  React.useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/profile/avatar", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Upload failed.");
      setAvatar(d.url);
      toast.success("Profile picture updated.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update picture.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <AppPage measure="reading">
        <AppPageHeader
          eyebrow="Profile"
          heading={user.name ?? "You"}
          lede="Your activity, model mix and lifetime ledger."
          actions={
            <Button variant="outline" size="sm" onClick={() => openSettings("account")}>
              Account settings
            </Button>
          }
        />

        {/* Identity Header */}
        <div className="surface-raised flex items-center gap-4 rounded-card p-5">
          <div className="group relative">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="relative flex size-16 items-center justify-center overflow-hidden surface-raised rounded-full bg-muted text-xl font-bold text-foreground disabled:cursor-default"
              aria-label="Change profile picture"
            >
              {avatar ? (
                <Image src={avatar} unoptimized={requiresViewerCredentials(avatar)} alt="" width={64} height={64} className="size-full object-cover" />
              ) : (
                <span>{(user.name || user.email || "U").slice(0, 2).toUpperCase()}</span>
              )}
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-black/60 text-white opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100",
                  uploading && "opacity-100"
                )}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAvatar(f);
                e.target.value = "";
              }}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">{user.name || "User"}</h3>
              <Badge variant="secondary">{plan.name}</Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>
            <p className="mt-1 font-mono text-caption text-muted-foreground/80">
              Member since {stats?.memberSince ? new Date(stats.memberSince).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "Aug 2026"}
            </p>
          </div>
        </div>

        {error ? (
          <EmptyState
            tone="error"
            size="panel"
            className="mt-5"
            icon={StatusIcons.error}
            title="Couldn't load your stats"
            description="Your activity, model mix and lifetime ledger all come from one request, and it didn't come back."
            action={
              <Button variant="outline" size="sm" onClick={() => void loadStats()}>
                Try again
              </Button>
            }
          />
        ) : !stats ? (
          <div className="mt-5 space-y-4">
            <div className="skeleton h-32 rounded-card" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="skeleton h-40 rounded-card" />
              <div className="skeleton h-40 rounded-card" />
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            {/* Activity heatmap — last ~53 weeks */}
            <Card className="p-5">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <CardEyebrow>Activity</CardEyebrow>
                  <p className="mt-1 text-xs text-muted-foreground">Last 53 weeks of generations.</p>
                </div>
                <p className="shrink-0 font-mono text-caption text-muted-foreground">
                  <span className="text-foreground font-medium">
                    {compactNumber(stats.yearTokens ?? stats.totalTokens)}
                  </span>{" "}
                  tokens ·{" "}
                  <span className="text-foreground font-medium">
                    {(stats.yearMessages ?? stats.totalMessages).toLocaleString()}
                  </span>{" "}
                  replies
                </p>
              </div>
              <TokenHeatmap daily={stats.daily} />
              <div className="mt-3 flex items-center justify-end gap-1.5 font-mono text-micro text-muted-foreground">
                Less
                {LEVEL_BG.map((bg, i) => (
                  <span key={i} className={cn("h-[11px] w-[11px] rounded-micro", bg)} />
                ))}
                More
              </div>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Most-used models — year window mix */}
              <Card className="p-5">
                <div className="mb-3">
                  <CardEyebrow>Most-used models</CardEyebrow>
                  <p className="mt-1 text-xs text-muted-foreground">Your mix across active providers.</p>
                </div>
                {stats.models.length === 0 ? (
                  <EmptyState
                    tone="empty"
                    size="panel"
                    icon={MessageSquare}
                    title="No chats yet"
                    description="Start a conversation and your model mix builds itself here."
                  />
                ) : (
                  <ul className="space-y-3">
                    {stats.models.slice(0, 6).map((m) => {
                      const info = resolveModel(m.model);
                      const accent = info ? providerAccent(info.provider) : "hsl(var(--primary))";
                      return (
                        <li key={m.model} className="flex items-center gap-2.5">
                          {info && <ProviderLogo provider={info.provider} className="size-5" />}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-xs font-medium text-foreground">{info?.name ?? m.model}</span>
                              <span className="shrink-0 font-mono text-caption text-muted-foreground">{m.count} msgs</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${(m.count / Math.max(1, stats.models[0]?.count ?? 1)) * 100}%`,
                                  backgroundColor: accent,
                                }}
                              />
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <LifetimeCard stats={stats} planName={plan.name} />
            </div>

          </div>
        )}

    </AppPage>
  );
}

/**
 * Lifetime ledger card — dense editorial recap of real provider cost from
 * ApiSpend. Hero figure is total API spend; supporting metrics fill the card
 * so it never reads as an empty 2×2 stat grid.
 */
function LifetimeCard({ stats, planName }: { stats: Stats; planName: string }) {
  const life = stats.lifetime;
  const tokens = life?.tokens ?? stats.totalTokens;
  const tokensIn = life?.tokensIn;
  const tokensOut = life?.tokensOut;
  const messages = life?.messages ?? stats.totalMessages;
  const costMicroUsd = life?.costMicroUsd ?? 0;
  const modelsTried = life?.modelsTried ?? stats.models.length;
  const byKind = life?.byKind ?? [];
  const byModel = life?.byModel ?? [];
  const rate = stats.eurPerUsd && stats.eurPerUsd > 0 ? stats.eurPerUsd : 1;
  const costUsd = costMicroUsd / 1_000_000;
  const costEur = costUsd * rate;
  const maxKindCost = Math.max(1, ...byKind.map((k) => k.costMicroUsd));
  const maxModelCost = Math.max(1, ...byModel.map((m) => m.costMicroUsd));
  const kindsWithSpend = byKind.filter((k) => k.costMicroUsd > 0 || k.count > 0);

  return (
    <Card className="relative overflow-hidden rounded-surface p-5">
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardEyebrow>Lifetime</CardEyebrow>
            <p className="mt-1 max-w-[28ch] text-sm text-muted-foreground">
              Provider API cost from the spend ledger — input + output tokens for every model
              call, including thinking. Not reset by deleting chats.
            </p>
          </div>
          {/* `bg-secondary`, not `bg-card`: this pill sits INSIDE a bg-card
              Card, so it was painting its own parent's fill onto itself — a
              zero-point step, leaving the /60 hairline to carry the whole
              shape. One rung up is the same move AppLogo and the provider well
              on this page already make. */}
          <span className="shrink-0 rounded-full border border-border/60 bg-secondary px-2.5 py-1 text-caption font-medium text-muted-foreground">
            {planName}
          </span>
        </div>

        <div className="mt-5 border-t border-border/60 pt-5">
          <p className="font-mono text-caption text-muted-foreground">
            API cost
          </p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {/* `text-display` already IS this role — a clamped 2rem→3rem with its
              own tracking — so the hand-rolled responsive pair and the tracking
              override were a private copy of a scale rung. */}
          <p className="font-serif text-display font-medium leading-none text-foreground">
              {formatLifetimeCost(costMicroUsd)}
            </p>
            {rate !== 1 && costUsd > 0 ? (
              <p className="font-mono text-caption text-muted-foreground">
                ≈ €
                {costEur.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Chat, image, video, voice, and code — priced at each model&rsquo;s input/output rates.
            Thinking tokens bill as output.
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border/60 bg-border/60 sm:grid-cols-4">
          <div className="bg-card px-3 py-3">
            <dt className="font-mono text-caption text-muted-foreground">
              Input
            </dt>
            <dd className="mt-1 text-heading font-semibold tracking-[-0.02em] tabular-nums">
              {compactNumber(tokensIn ?? Math.round(tokens * 0.6))}
            </dd>
          </div>
          <div className="bg-card px-3 py-3">
            <dt className="font-mono text-caption text-muted-foreground">
              Output
            </dt>
            <dd className="mt-1 text-heading font-semibold tracking-[-0.02em] tabular-nums">
              {compactNumber(tokensOut ?? Math.round(tokens * 0.4))}
            </dd>
          </div>
          <div className="bg-card px-3 py-3">
            <dt className="font-mono text-caption text-muted-foreground">
              Replies
            </dt>
            <dd className="mt-1 text-heading font-semibold tracking-[-0.02em] tabular-nums">
              {messages.toLocaleString()}
            </dd>
          </div>
          <div className="bg-card px-3 py-3">
            <dt className="font-mono text-caption text-muted-foreground">
              Models
            </dt>
            <dd className="mt-1 text-heading font-semibold tracking-[-0.02em] tabular-nums">
              {modelsTried}
            </dd>
          </div>
        </dl>

        {byModel.length > 0 ? (
          <div className="mt-5">
            <p className="font-mono text-caption text-muted-foreground">
              By model
            </p>
            {/* Compact scroll region — keeps the card short while all models stay reachable. */}
            <div className="relative mt-3">
              <ul className="max-h-[11.5rem] space-y-2.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]">
                {byModel.map((row) => {
                  const info = resolveModel(row.model);
                  const share = row.costMicroUsd / maxModelCost;
                  return (
                    <li key={row.model} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          {info ? <ProviderLogo provider={info.provider} className="size-4 shrink-0" /> : null}
                          <span className="truncate text-sm">{info?.name ?? row.model}</span>
                        </span>
                        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                          {formatLifetimeCost(row.costMicroUsd)}
                          <span className="text-muted-foreground"> · {row.count.toLocaleString()}</span>
                        </span>
                      </div>
                      <p className="mt-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                        {compactNumber(row.tokensIn)} in · {compactNumber(row.tokensOut)} out
                      </p>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
                        {/* Same fill and the same reduced-motion escape as the
                            "By surface" bars below. These two lists sit in one
                            card, measure the same quantity at the same rank,
                            and were drawn in two different inks on two
                            different motion contracts — this one animated its
                            width even for a reader who asked for no motion. */}
                        <div
                          className="h-full rounded-full bg-primary/80 transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
                          style={{ width: `${Math.max(share * 100, row.costMicroUsd > 0 ? 3 : 0)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {byModel.length > 3 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent"
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {kindsWithSpend.length > 1 ? (
          <div className="mt-5">
            <p className="font-mono text-caption text-muted-foreground">
              By surface
            </p>
            <ul className="mt-3 space-y-2.5">
              {kindsWithSpend.map((row) => {
                const share = row.costMicroUsd / maxKindCost;
                return (
                  <li key={row.kind} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm">{kindLabel(row.kind)}</span>
                      <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                        {formatLifetimeCost(row.costMicroUsd)}
                        <span className="text-muted-foreground"> · {row.count.toLocaleString()}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
                      <div
                        className="h-full rounded-full bg-primary/80 transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
                        style={{ width: `${Math.max(share * 100, row.costMicroUsd > 0 ? 3 : 0)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : kindsWithSpend.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground">
            No billable API use yet — once you chat or generate, the ledger fills in here.
          </p>
        ) : null}

        {stats.memberSince ? (
          <p className="mt-5 border-t border-border/60 pt-3 font-mono text-caption text-muted-foreground">
            Member since{" "}
            {new Date(stats.memberSince).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

