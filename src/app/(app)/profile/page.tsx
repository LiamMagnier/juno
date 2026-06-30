"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useApp } from "@/components/app/app-provider";
import { PLANS, planRank } from "@/lib/plans";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { providerAccent } from "@/lib/provider-colors";
import { cn } from "@/lib/utils";

interface Stats {
  daily: Record<string, { tokens: number; count: number }>;
  models: { model: string; count: number; tokens: number }[];
  totalTokens: number;
  totalMessages: number;
  memberSince: string | null;
}

const LEVEL_BG = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];
const DOW = ["", "Mon", "", "Wed", "", "Fri", ""];

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function buildWeeks(daily: Stats["daily"]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const days: { date: string; tokens: number; count: number }[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
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
      <div className="flex flex-col gap-[3px] pt-[2px] font-mono text-[9px] text-muted-foreground">
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
                  className={cn("h-[11px] w-[11px] rounded-[2px]", LEVEL_BG[cell.level])}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function AvailabilityBars({ ratio, color, dots = 24 }: { ratio: number; color: string; dots?: number }) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * dots);
  return (
    <div className="flex min-w-[150px] justify-end gap-1" aria-hidden>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          className="h-8 w-2 rounded-full bg-muted transition-colors"
          style={i < filled ? { backgroundColor: color } : undefined}
        />
      ))}
    </div>
  );
}

function shortProviderLabel(provider: Provider) {
  return PROVIDERS[provider].label.split(" · ")[0];
}

function UsageCard({
  title,
  subtitle,
  color,
  ratio,
  logo,
}: {
  title: string;
  subtitle: string;
  color: string;
  ratio: number;
  logo: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-[24px] border bg-card/80 p-4 shadow-soft">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background shadow-soft">{logo}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">{title}</p>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <AvailabilityBars ratio={ratio} color={color} />
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { user, quota, models } = useApp();
  const plan = PLANS[quota.plan];
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState(false);
  const [avatar, setAvatar] = React.useState<string | null>(user.image ?? null);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/profile/stats");
        if (!r.ok) throw new Error();
        setStats(await r.json());
      } catch {
        setError(true);
      }
    })();
  }, []);

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

  const usageRatio = quota.limit == null ? 1 : Math.max(0, Math.min(1, (quota.remaining ?? 0) / quota.limit));
  const usageSubtitle =
    quota.limit == null
      ? `${plan.name} plan · unlimited`
      : `${plan.name} plan · ${(quota.remaining ?? 0).toLocaleString()} of ${quota.limit.toLocaleString()} messages left`;

  const modelUsage = React.useMemo(() => new Map((stats?.models ?? []).map((m) => [m.model, m])), [stats?.models]);
  const providerUsage = React.useMemo(() => {
    const map = new Map<Provider, { count: number; tokens: number }>();
    for (const item of stats?.models ?? []) {
      const info = resolveModel(item.model);
      if (!info) continue;
      const current = map.get(info.provider) ?? { count: 0, tokens: 0 };
      current.count += item.count;
      current.tokens += item.tokens;
      map.set(info.provider, current);
    }
    return map;
  }, [stats?.models]);

  const sortedModels = React.useMemo<ModelInfo[]>(() => {
    return [...models].sort((a, b) => {
      const au = modelUsage.get(a.id)?.count ?? 0;
      const bu = modelUsage.get(b.id)?.count ?? 0;
      if (bu !== au) return bu - au;
      return a.name.localeCompare(b.name);
    });
  }, [modelUsage, models]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Profile</span>
        </div>

        {/* Identity */}
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
          <div className="group relative">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative block h-20 w-20 overflow-hidden rounded-full border bg-card shadow-soft"
              aria-label="Change profile picture"
            >
              {avatar ? (
                <Image src={avatar} alt="" width={80} height={80} className="h-full w-full object-cover" />
              ) : (
                <DotIdenticon seed={user.id} className="h-full w-full p-2" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-foreground/40 text-background opacity-0 transition-opacity group-hover:opacity-100">
                {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
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
          <div className="min-w-0">
            <h1 className="font-serif text-title font-medium">{user.name ?? "You"}</h1>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <p className="mt-1 font-mono text-caption uppercase tracking-wider text-muted-foreground">
              {plan.name} plan
              {stats?.memberSince ? ` · since ${new Date(stats.memberSince).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : ""}
            </p>
          </div>
        </div>

        {error ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">Couldn’t load your stats.</p>
        ) : !stats ? (
          <div className="mt-8 space-y-4">
            <div className="skeleton h-32 rounded-lg" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="skeleton h-40 rounded-lg" />
              <div className="skeleton h-40 rounded-lg" />
            </div>
          </div>
        ) : (
          <div className="mt-8 space-y-4">
            {/* Activity heatmap */}
            <Card className="p-5 rounded-[28px]">
              <div className="mb-4 flex items-end justify-between">
                <CardEyebrow>Activity</CardEyebrow>
                <p className="text-sm text-muted-foreground">
                  <span className="font-mono text-foreground">{compactNumber(stats.totalTokens)}</span> tokens ·{" "}
                  <span className="font-mono text-foreground">{stats.totalMessages.toLocaleString()}</span> replies
                </p>
              </div>
              <TokenHeatmap daily={stats.daily} />
              <div className="mt-3 flex items-center justify-end gap-1.5 font-mono text-[10px] text-muted-foreground">
                Less
                {LEVEL_BG.map((bg, i) => (
                  <span key={i} className={cn("h-[11px] w-[11px] rounded-[2px]", bg)} />
                ))}
                More
              </div>
            </Card>

            <Card className="p-5 rounded-[28px]">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <CardEyebrow>Provider availability</CardEyebrow>
                  <p className="mt-1 text-sm text-muted-foreground">Remaining usage follows your current plan quota.</p>
                </div>
                <p className="shrink-0 font-mono text-caption uppercase text-muted-foreground">
                  {quota.limit == null ? "Unlimited" : `${quota.used} used`}
                </p>
              </div>
              <div className="grid gap-3">
                {PROVIDER_LIST.map((provider) => {
                  const usage = providerUsage.get(provider);
                  const color = providerAccent(provider);
                  return (
                    <UsageCard
                      key={provider}
                      title={shortProviderLabel(provider)}
                      subtitle={`${usageSubtitle}${usage?.count ? ` · ${usage.count.toLocaleString()} used here` : ""}`}
                      color={color}
                      ratio={usageRatio}
                      logo={<ProviderLogo provider={provider} className="h-8 w-8" />}
                    />
                  );
                })}
              </div>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Model availability */}
              <Card className="p-5 rounded-[28px]">
                <CardEyebrow className="mb-3">Model availability</CardEyebrow>
                <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
                  {sortedModels.map((info) => {
                    const usage = modelUsage.get(info.id);
                    const allowed = planRank(quota.plan) >= planRank(info.minPlan);
                    const color = allowed ? providerAccent(info.provider) : "hsl(var(--muted-foreground) / 0.35)";
                    return (
                      <div key={info.id} className="rounded-[20px] border bg-background/70 p-3">
                        <div className="mb-2 flex items-center gap-2.5">
                          <ProviderLogo provider={info.provider} className="h-5 w-5" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{info.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {allowed ? usageSubtitle : `Requires ${PLANS[info.minPlan].name}`}
                              {usage?.count ? ` · ${usage.count.toLocaleString()} used` : ""}
                            </p>
                          </div>
                        </div>
                        <AvailabilityBars ratio={allowed ? usageRatio : 0} color={color} dots={20} />
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Most-used models */}
              <Card className="p-5 rounded-[28px]">
                <CardEyebrow className="mb-3">Most-used models</CardEyebrow>
                {stats.models.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No chats yet — start one to see your mix.</p>
                ) : (
                  <ul className="space-y-3">
                    {stats.models.slice(0, 6).map((m) => {
                      const info = resolveModel(m.model);
                      const accent = info ? providerAccent(info.provider) : "hsl(var(--primary))";
                      return (
                        <li key={m.model} className="flex items-center gap-2.5">
                          {info && <ProviderLogo provider={info.provider} className="h-5 w-5" />}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm">{info?.name ?? m.model}</span>
                              <span className="shrink-0 font-mono text-caption text-muted-foreground">{m.count}</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full" style={{ width: `${(m.count / Math.max(1, stats.models[0]?.count ?? 1)) * 100}%`, backgroundColor: accent }} />
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              {/* Totals */}
              <Card className="p-5 rounded-[28px]">
                <CardEyebrow className="mb-3">Lifetime</CardEyebrow>
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="Tokens" value={compactNumber(stats.totalTokens)} />
                  <Stat label="Replies" value={stats.totalMessages.toLocaleString()} />
                  <Stat label="Models tried" value={`${stats.models.length}`} />
                  <Stat label="Plan" value={plan.name} />
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-serif text-title font-medium">{value}</p>
      <p className="font-mono text-caption uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
