"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { signOutToSignIn } from "@/lib/sign-out";
import { toast } from "sonner";
import { ArrowLeft, Camera, ChevronDown, Download, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { ImportHistoryCard } from "@/components/settings/import-history";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { SharedLinksCard } from "@/components/share/shared-links-card";
import { useApp } from "@/components/app/app-provider";
import { PLANS, effectiveMinPlan, planRank } from "@/lib/plans";
import { MODELS_BY_PROVIDER, resolveModel, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
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
    // 24 fixed-width dots ≈ 284px — wider than a phone row. Decorative
    // (aria-hidden), so it yields below sm instead of overflowing the card.
    <div className="hidden min-w-[150px] justify-end gap-1 sm:flex" aria-hidden>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          className="h-8 w-2 rounded-full bg-muted ring-1 ring-inset ring-foreground/10 transition-colors"
          style={i < filled ? { backgroundColor: color } : undefined}
        />
      ))}
    </div>
  );
}

function shortProviderLabel(provider: Provider) {
  return PROVIDERS[provider].label.split(" · ")[0];
}

function ProviderLogoWell({ provider }: { provider: Provider }) {
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background shadow-pop">
      <ProviderLogo provider={provider} className="h-8 w-8" />
    </div>
  );
}

function ModelRow({ info, planLevel, count }: { info: ModelInfo; planLevel: number; count: number }) {
  const lockPlan = effectiveMinPlan(info.minPlan);
  const locked = planLevel < planRank(lockPlan);
  return (
    // flex-wrap: with released date + status + plan badges all shrink-0, the
    // worst case outgrows a 360px row — let badges wrap under the name instead.
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5">
      <ProviderLogo provider={info.provider} className="h-5 w-5 shrink-0" />
      <span className="min-w-0 truncate text-sm">{info.name}</span>
      <span className="shrink-0 font-mono text-caption text-muted-foreground">{info.released ?? "—"}</span>
      {info.status === "deprecated" && (
        <span className="shrink-0 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.14em] text-destructive">
          Retiring
        </span>
      )}
      {info.status === "legacy" && (
        <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Legacy
        </span>
      )}
      {locked && (
        <span className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <Lock className="h-2.5 w-2.5" /> {PLANS[lockPlan].name}
        </span>
      )}
      {count > 0 && (
        <span className="ml-auto shrink-0 pl-2 font-mono text-caption text-muted-foreground">{count.toLocaleString()} msgs</span>
      )}
    </li>
  );
}

function ProviderRow({
  provider,
  configured,
  usageCount,
  modelsUsed,
  share,
  planLevel,
  modelUsage,
  open,
  onToggle,
}: {
  provider: Provider;
  configured: boolean;
  usageCount: number;
  modelsUsed: number;
  share: number;
  planLevel: number;
  modelUsage: Map<string, number>;
  open: boolean;
  onToggle: () => void;
}) {
  if (!configured) {
    return (
      <div className="flex items-center gap-4 rounded-[24px] border border-border/50 p-4 opacity-45">
        <ProviderLogoWell provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{shortProviderLabel(provider)}</p>
          <p className="truncate text-sm text-muted-foreground">Not configured</p>
        </div>
      </div>
    );
  }
  const models = MODELS_BY_PROVIDER.get(provider) ?? [];
  return (
    <div className="surface-raised overflow-hidden rounded-[24px] border border-border/70">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors duration-fast ease-out-soft hover:bg-primary/5"
      >
        <ProviderLogoWell provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{shortProviderLabel(provider)}</p>
          <p className="truncate text-sm text-muted-foreground">
            {usageCount.toLocaleString()} messages · {modelsUsed} models used
          </p>
        </div>
        <AvailabilityBars ratio={share} color={providerAccent(provider)} />
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft",
            open && "rotate-180"
          )}
        />
      </button>
      <div
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <ul key={open ? "open" : "closed"} className={cn("space-y-0.5 px-4 pb-4 pt-1", open && "motion-safe:animate-rise-in")}>
            {models.map((info) => (
              <ModelRow key={info.id} info={info} planLevel={planLevel} count={modelUsage.get(info.id) ?? 0} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function AccountCard({ email }: { email: string }) {
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const match = confirm.trim().toLowerCase() === email.toLowerCase() && email.length > 0;

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail: confirm.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not delete the account.");
      }
      await signOutToSignIn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the account.");
      setDeleting(false);
    }
  };

  return (
    <Card className="p-5 rounded-[28px]">
      <CardEyebrow className="mb-4">Account</CardEyebrow>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Export your data</p>
          <p className="text-sm text-muted-foreground">
            Profile, settings, conversations, memories, projects, and file metadata.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="/api/account/export" download>
              <Download className="h-3.5 w-3.5" /> JSON
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/api/account/export?format=csv" download>
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Delete account permanently</p>
          <p className="text-sm text-muted-foreground">
            Chats, memories, files, and your subscription — everything, immediately.
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          Delete account…
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (deleting) return;
          setOpen(next);
          if (!next) setConfirm("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">Delete this account?</DialogTitle>
            <DialogDescription>
              This deletes your account and everything in it — conversations, memories, uploaded
              files, and your subscription. It takes effect immediately, and nothing can be
              recovered afterwards. If you want a copy, export your data first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-email" className="text-muted-foreground">
              Type <span className="font-mono text-foreground">{email}</span> to confirm
            </Label>
            <Input
              id="delete-confirm-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              placeholder={email}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={deleting}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setConfirm("");
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={!match || deleting} onClick={deleteAccount}>
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete permanently"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { user, quota, features } = useApp();
  const plan = PLANS[quota.plan];
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState(false);
  const [avatar, setAvatar] = React.useState<string | null>(user.image ?? null);
  const [uploading, setUploading] = React.useState(false);
  const [openProvider, setOpenProvider] = React.useState<Provider | null>(null);
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

  const modelUsage = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const item of stats?.models ?? []) {
      const key = resolveModel(item.model)?.id ?? item.model;
      map.set(key, (map.get(key) ?? 0) + item.count);
    }
    return map;
  }, [stats?.models]);

  const providerUsage = React.useMemo(() => {
    const map = new Map<Provider, { count: number; models: Set<string> }>();
    for (const item of stats?.models ?? []) {
      const info = resolveModel(item.model);
      if (!info) continue;
      const current = map.get(info.provider) ?? { count: 0, models: new Set<string>() };
      current.count += item.count;
      current.models.add(info.id);
      map.set(info.provider, current);
    }
    return map;
  }, [stats?.models]);

  const totalUsed = React.useMemo(() => {
    let total = 0;
    for (const usage of providerUsage.values()) total += usage.count;
    return total;
  }, [providerUsage]);

  const orderedProviders = React.useMemo(() => {
    const configured = new Set(features.providers);
    return [...PROVIDER_LIST].sort((a, b) => Number(configured.has(b)) - Number(configured.has(a)));
  }, [features.providers]);

  const planLevel = planRank(quota.plan);

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
            {/* Activity heatmap — last ~53 weeks */}
            <Card className="rounded-[28px] p-5">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <CardEyebrow>Activity</CardEyebrow>
                  <p className="mt-1 text-sm text-muted-foreground">Last 53 weeks of billable generations.</p>
                </div>
                <p className="shrink-0 text-sm text-muted-foreground">
                  <span className="font-mono text-foreground">
                    {compactNumber(stats.yearTokens ?? stats.totalTokens)}
                  </span>{" "}
                  tokens ·{" "}
                  <span className="font-mono text-foreground">
                    {(stats.yearMessages ?? stats.totalMessages).toLocaleString()}
                  </span>{" "}
                  replies
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
                  <p className="mt-1 text-sm text-muted-foreground">How your messages split across configured labs.</p>
                </div>
                <p className="shrink-0 font-mono text-caption uppercase text-muted-foreground">
                  {features.providers.length} of {PROVIDER_LIST.length} configured
                </p>
              </div>
              <div className="grid gap-3">
                {orderedProviders.map((provider) => {
                  const usage = providerUsage.get(provider);
                  return (
                    <ProviderRow
                      key={provider}
                      provider={provider}
                      configured={features.providers.includes(provider)}
                      usageCount={usage?.count ?? 0}
                      modelsUsed={usage?.models.size ?? 0}
                      share={totalUsed > 0 ? (usage?.count ?? 0) / totalUsed : 0}
                      planLevel={planLevel}
                      modelUsage={modelUsage}
                      open={openProvider === provider}
                      onToggle={() => setOpenProvider((prev) => (prev === provider ? null : provider))}
                    />
                  );
                })}
              </div>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* Most-used models — year window mix */}
              <Card className="rounded-[28px] p-5">
                <div className="mb-3">
                  <CardEyebrow>Most-used models</CardEyebrow>
                  <p className="mt-1 text-sm text-muted-foreground">Your mix over the last year.</p>
                </div>
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
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
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

        <div className="mt-4 space-y-4">
          <SharedLinksCard />
          <ImportHistoryCard />
          <AccountCard email={user.email ?? ""} />
        </div>
      </div>
    </div>
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
    <Card className="relative overflow-hidden rounded-[28px] p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(520px_220px_at_100%_-10%,hsl(var(--primary)/0.08),transparent_60%)]"
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardEyebrow>Lifetime</CardEyebrow>
            <p className="mt-1 max-w-[28ch] text-sm text-muted-foreground">
              Provider API cost from the spend ledger — input + output tokens for every model
              call, including thinking. Not reset by deleting chats.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border/60 bg-card/80 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground shadow-soft">
            {planName}
          </span>
        </div>

        <div className="mt-5 border-t border-border/50 pt-5">
          <p className="font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground">
            API cost
          </p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-serif text-[2rem] font-medium leading-none tracking-[-0.03em] text-foreground sm:text-[2.25rem]">
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

        <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 sm:grid-cols-4">
          <div className="bg-card/90 px-3 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Input
            </dt>
            <dd className="mt-1 font-serif text-heading font-medium tracking-[-0.02em] tabular-nums">
              {compactNumber(tokensIn ?? Math.round(tokens * 0.6))}
            </dd>
          </div>
          <div className="bg-card/90 px-3 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Output
            </dt>
            <dd className="mt-1 font-serif text-heading font-medium tracking-[-0.02em] tabular-nums">
              {compactNumber(tokensOut ?? Math.round(tokens * 0.4))}
            </dd>
          </div>
          <div className="bg-card/90 px-3 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Replies
            </dt>
            <dd className="mt-1 font-serif text-heading font-medium tracking-[-0.02em] tabular-nums">
              {messages.toLocaleString()}
            </dd>
          </div>
          <div className="bg-card/90 px-3 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Models
            </dt>
            <dd className="mt-1 font-serif text-heading font-medium tracking-[-0.02em] tabular-nums">
              {modelsTried}
            </dd>
          </div>
        </dl>

        {byModel.length > 0 ? (
          <div className="mt-5">
            <p className="font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground">
              By model
            </p>
            <ul className="mt-3 space-y-2.5">
              {byModel.slice(0, 6).map((row) => {
                const info = resolveModel(row.model);
                const share = row.costMicroUsd / maxModelCost;
                return (
                  <li key={row.model} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        {info ? <ProviderLogo provider={info.provider} className="h-4 w-4 shrink-0" /> : null}
                        <span className="truncate text-sm">{info?.name ?? row.model}</span>
                      </span>
                      <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                        {formatLifetimeCost(row.costMicroUsd)}
                        <span className="text-muted-foreground/70"> · {row.count.toLocaleString()}</span>
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                      {compactNumber(row.tokensIn)} in · {compactNumber(row.tokensOut)} out
                    </p>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
                      <div
                        className="h-full rounded-full bg-foreground/70 transition-[width] duration-base ease-out-soft"
                        style={{ width: `${Math.max(share * 100, row.costMicroUsd > 0 ? 3 : 0)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {kindsWithSpend.length > 1 ? (
          <div className="mt-5">
            <p className="font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground">
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
                        <span className="text-muted-foreground/70"> · {row.count.toLocaleString()}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
                      <div
                        className="h-full rounded-full bg-primary/80 transition-[width] duration-base ease-out-soft"
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
          <p className="mt-5 border-t border-border/50 pt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
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
