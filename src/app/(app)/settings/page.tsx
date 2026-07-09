"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { signOutToSignIn } from "@/lib/sign-out";
import { toast } from "sonner";
import { ArrowLeft, Brain, Check, Download, Monitor, Moon, Sun, Trash2, Plus, Palette, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardEyebrow } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/components/app/app-provider";
import { resolveModel } from "@/lib/models";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { PLANS, canUseModel } from "@/lib/plans";
import { ACCENTS } from "@/lib/accents";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

const LANGUAGES = ["auto", "English", "Spanish", "French", "German", "Portuguese", "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic"];

function Tile({
  eyebrow,
  i,
  span,
  className,
  children,
}: {
  eyebrow: string;
  i: number;
  span?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      style={{ animationDelay: `${i * 55}ms` }}
      className={cn("p-5 rounded-[28px] motion-safe:animate-rise-in [animation-fill-mode:backwards]", span && "sm:col-span-2", className)}
    >
      <CardEyebrow className="mb-3">{eyebrow}</CardEyebrow>
      {children}
    </Card>
  );
}

function CustomPickerButton({
  selected,
  customColor,
  onChange,
}: {
  selected: boolean;
  customColor: string;
  onChange: (color: string) => void;
}) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <input
        ref={pickerRef}
        type="color"
        value={customColor}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => pickerRef.current?.click()}
        aria-label="Custom accent color"
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-fast hover:scale-110 coarse:h-11 coarse:w-11 relative overflow-hidden",
          selected && "ring-2 ring-foreground"
        )}
        style={{
          background: selected
            ? customColor
            : "linear-gradient(135deg, #ff007f, #7f00ff, #00ffff, #00ff7f, #ffea00)",
        }}
      >
        {selected ? (
          <Check className="h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        ) : (
          <Plus className="h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        )}
      </button>
    </div>
  );
}

/** "4 hr 47 min" / "12 min" / "2 days" — time until a rolling window frees up. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.round(h / 24);
    return `${d} day${d > 1 ? "s" : ""}`;
  }
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

/** "Fri 6:59 PM" — the moment a rolling window next frees up, in local time. */
function formatResetMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "May 3, 2026" — an absolute date for billing renewals. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Claude-style usage row: label + reset subtitle, a bar, and "N% used". */
function UsageMeter({ label, subtitle, pct }: { label: string; subtitle: string; pct: number }) {
  const shown = Math.min(100, Math.round(pct * 100));
  const hot = pct >= 0.9;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-caption text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex min-w-[160px] flex-1 items-center gap-3">
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-all duration-base",
              hot ? "bg-warning" : "bg-primary"
            )}
            style={{ width: `${Math.min(100, pct * 100)}%` }}
          />
        </div>
        <span className="w-16 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">
          {shown}% used
        </span>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, settings, setSettings, quota, spend, features, models } = useApp();
  const { setTheme } = useTheme();
  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteChatsOpen, setDeleteChatsOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deletingChats, setDeletingChats] = React.useState(false);
  const [portalLoading, setPortalLoading] = React.useState(false);

  const save = React.useCallback(
    async (patch: Partial<ClientSettings>) => {
      setSettings(patch);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) toast.error("Could not save settings.");
    },
    [setSettings]
  );

  const setAccent = (accent: string) => {
    document.documentElement.dataset.accent = accent;
    save({ accent });
  };

  const setThemePref = (theme: ClientSettings["theme"]) => {
    setTheme(theme);
    save({ theme });
  };

  const saveInstructions = () => {
    if (instructions !== settings.customInstructions) save({ customInstructions: instructions });
  };

  const exportData = () => {
    window.location.href = "/api/account/export";
  };

  const deleteAccount = async () => {
    setDeleting(true);
    const res = await fetch("/api/account", { method: "DELETE" });
    if (res.ok) {
      toast.success("Account deleted.");
      void signOutToSignIn();
    } else {
      setDeleting(false);
      toast.error("Could not delete account.");
    }
  };

  const deleteAllChats = async () => {
    setDeletingChats(true);
    const res = await fetch("/api/conversations", { method: "DELETE" });
    if (res.ok) {
      toast.success("All conversations deleted.");
      window.location.href = "/chat";
    } else {
      setDeletingChats(false);
      toast.error("Could not delete conversations.");
    }
  };

  const openPortal = async () => {
    setPortalLoading(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else {
      setPortalLoading(false);
      toast.error(data.error ?? "Could not open billing portal.");
    }
  };

  const themeOptions: { value: ClientSettings["theme"]; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  const plan = PLANS[quota.plan];
  const windows = spend.windows;
  const unlimited = spend.budgetMicroUsd == null;

  // Live clock so the rolling-window countdowns tick without a reload. Kept null
  // until mount so SSR and the first client render agree (no now/timezone drift).
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const sessionSubtitle =
    nowMs == null ? "5-hour window" : `Resets in ${formatCountdown(windows.session.resetsAtMs - nowMs)}`;
  const weeklySubtitle =
    nowMs == null ? "7-day window" : `Resets ${formatResetMoment(windows.weekly.resetsAtMs)}`;

  const renewsAtMs = spend.billing.renewsAtMs;
  const cancelAtPeriodEnd = spend.billing.cancelAtPeriodEnd;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="font-serif text-title font-medium">Settings</h1>
            <p className="text-caption text-muted-foreground">{user.email}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Usage dashboard */}
          <Tile eyebrow="Usage" i={0} span>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-5 items-stretch mt-1">
              {/* Plan info (Left) */}
              <div className="field-well md:col-span-2 flex flex-col justify-between rounded-[18px] bg-accent/40 border border-border/50 p-4">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-serif text-heading font-semibold tracking-tight">
                      {plan.name} Plan
                    </span>
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {plan.tagline}
                  </p>
                  
                  {/* Plan Features */}
                  <ul className="mt-4 space-y-1.5">
                    {plan.features.slice(0, 3).map((feat, idx) => (
                      <li key={idx} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Check className="h-3 w-3 text-primary shrink-0" />
                        <span className="truncate">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t border-border/40">
                  <span className="text-caption text-muted-foreground uppercase tracking-wider font-mono">
                    {plan.price > 0 ? `${plan.price} € HT/mo` : "Active tier"}
                  </span>
                  {quota.plan === "FREE" && features.billing && (
                    <Button asChild size="sm" className="h-7 px-3 text-xs">
                      <Link href="/upgrade">Upgrade</Link>
                    </Button>
                  )}
                </div>
              </div>

              {/* Usage windows (Right) — rolling session + weekly, percentages only */}
              <div className="field-well md:col-span-3 flex flex-col justify-center rounded-[18px] border border-border/50 p-4 bg-card">
                {unlimited ? (
                  <div>
                    <div className="flex items-center gap-[3.5px] py-1.5" aria-hidden>
                      {Array.from({ length: 32 }).map((_, i) => (
                        <span
                          key={i}
                          className="h-[5px] w-[5px] rounded-full bg-primary/75 animate-pulse"
                          style={{ animationDelay: `${i * 65}ms`, animationDuration: "1.6s" }}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      No usage limits on this plan.
                    </p>
                  </div>
                ) : quota.plan === "FREE" ? (
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Free is a browse-only tier. Upgrade to Pro to start using models.
                    </p>
                    {features.billing && (
                      <Button asChild size="sm" className="h-7 px-3 text-xs">
                        <Link href="/upgrade">Upgrade</Link>
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <UsageMeter label="Current session" subtitle={sessionSubtitle} pct={windows.session.pct} />
                    <div className="border-t border-border/40" />
                    <span className="font-mono text-[10px] text-label uppercase text-muted-foreground/80 tracking-widest block">
                      Weekly limits
                    </span>
                    <UsageMeter label="All models" subtitle={weeklySubtitle} pct={windows.weekly.pct} />
                    {renewsAtMs != null && (
                      <p className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                        <CalendarClock className="h-3.5 w-3.5 opacity-70" />
                        {cancelAtPeriodEnd ? "Access ends" : "Budget renews"} {formatDate(renewsAtMs)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Tile>

          {/* Appearance */}
          <Tile eyebrow="Appearance" i={1} span>
            <div className="grid gap-6 sm:grid-cols-2 sm:gap-12">
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Theme</Label>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                  {themeOptions.map((t) => {
                    const selected = settings.theme === t.value;
                    return (
                      <button
                        key={t.value}
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setThemePref(t.value)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-xl border p-3 text-sm shadow-pop transition-all duration-fast ease-out-soft hover:-translate-y-0.5 hover:bg-accent hover:shadow-float",
                          selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/70"
                        )}
                      >
                        <t.icon className="h-4 w-4" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Accent color</Label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent color">
                  {ACCENTS.map((a) => {
                    const selected = settings.accent === a.id;
                    return (
                      <button
                        key={a.id}
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setAccent(a.id)}
                        aria-label={a.id}
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-fast hover:scale-110 coarse:h-11 coarse:w-11",
                          selected && "ring-2 ring-foreground"
                        )}
                        style={{ backgroundColor: a.color }}
                      >
                        {selected && <Check className="h-4 w-4 text-white" />}
                      </button>
                    );
                  })}
                  {/* Custom color picker */}
                  {(() => {
                    const isPreset = ACCENTS.some((a) => a.id === settings.accent);
                    const selected = !isPreset && settings.accent.startsWith("#");
                    const customColor = selected ? settings.accent : "#ea580c";
                    return (
                      <CustomPickerButton
                        selected={selected}
                        customColor={customColor}
                        onChange={setAccent}
                      />
                    );
                  })()}
                </div>
              </div>
            </div>
          </Tile>

          {/* Default model */}
          <Tile eyebrow="Default model" i={2}>
            <p className="mb-3 text-sm text-muted-foreground">Used for new conversations.</p>
            <Select
              value={resolveModel(settings.defaultModel)?.id ?? settings.defaultModel}
              onValueChange={(v) => save({ defaultModel: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models
                  .filter((m) => (m.modality ?? "chat") === "chat")
                  .map((m) => {
                    const configured = features.providers.includes(m.provider as Provider);
                    return (
                      <SelectItem key={m.id} value={m.id} disabled={!configured || !canUseModel(quota.plan, m.id)}>
                        {m.name}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          · {(PROVIDERS[m.provider]?.label ?? m.provider).split(" · ")[0]}
                          {!configured ? " (no key)" : ""}
                        </span>
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
          </Tile>

          {/* Language */}
          <Tile eyebrow="Response language" i={3}>
            <p className="mb-3 text-sm text-muted-foreground">The language Juno replies in.</p>
            <Select value={settings.responseLanguage} onValueChange={(v) => save({ responseLanguage: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l === "auto" ? "Auto-detect" : l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Tile>

          <Tile eyebrow="Custom instructions" i={4} span>
            <p className="mb-3 text-sm text-muted-foreground">Juno keeps these in mind in every conversation.</p>
            <div className="relative">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={saveInstructions}
                placeholder="E.g. I'm a product manager. Keep answers concise and use bullet points."
                className="min-h-[110px] pb-8"
                maxLength={4000}
              />
              <span className="absolute bottom-2.5 right-3 font-mono text-[10px] text-muted-foreground/50 select-none">
                {instructions.length}/4000
              </span>
            </div>
          </Tile>

          {/* Memory */}
          <Tile eyebrow="Memory" i={5}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Brain className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium">Reference saved memories</p>
                  <p className="text-xs text-muted-foreground">Manage what Juno remembers</p>
                </div>
              </div>
              <Switch checked={settings.memoryEnabled} onCheckedChange={(v) => save({ memoryEnabled: v })} aria-label="Toggle memory" />
            </div>
            <Button asChild variant="link" className="mt-2 h-auto p-0">
              <Link href="/memory">Open memory manager →</Link>
            </Button>
          </Tile>

          {/* Account */}
          <Tile eyebrow="Account" i={6}>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Current plan</span>
                <span className="font-medium">{plan.name}</span>
              </div>
              {renewsAtMs != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{cancelAtPeriodEnd ? "Access ends" : "Renews"}</span>
                  <span className="font-medium">{formatDate(renewsAtMs)}</span>
                </div>
              )}
              {features.billing && quota.plan !== "FREE" && (
                <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading} className="w-full">
                  {portalLoading ? "Opening…" : "Manage subscription"}
                </Button>
              )}
              {features.billing && quota.plan === "FREE" && (
                <Button asChild size="sm" className="w-full">
                  <Link href="/upgrade">Upgrade plan</Link>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={exportData} className="w-full gap-2">
                <Download className="h-4 w-4" /> Export my data
              </Button>
            </div>
          </Tile>

          {/* Danger zone */}
          <Tile eyebrow="Danger zone" i={7} span className="border-destructive/30">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div>
                  <p className="text-sm font-medium">Delete all conversations</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete all your chat history.
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setDeleteChatsOpen(true)} className="gap-2 shrink-0">
                  <Trash2 className="h-4 w-4" /> Delete all chats
                </Button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Delete account</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete your account, conversations, and memories.
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} className="gap-2 shrink-0">
                  <Trash2 className="h-4 w-4" /> Delete account
                </Button>
              </div>
            </div>
          </Tile>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Delete your account?</DialogTitle>
            <DialogDescription>
              This permanently deletes your account, conversations, and memories. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAccount} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteChatsOpen} onOpenChange={setDeleteChatsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Delete all conversations?</DialogTitle>
            <DialogDescription>
              This permanently deletes all your conversations and message history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteChatsOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAllChats} disabled={deletingChats}>
              {deletingChats ? "Deleting…" : "Delete all chats"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
