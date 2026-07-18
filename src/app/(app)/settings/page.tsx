"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { signOutToSignIn } from "@/lib/sign-out";
import { toast } from "sonner";
import { ArrowLeft, NotebookPen, Check, Download, Loader2, Monitor, Moon, Play, Square, Sun, Trash2, Plus, CalendarClock } from "lucide-react";
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
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";
import { VOICES, DEFAULT_VOICE } from "@/lib/voices";
import { AUTO_LOCALE, UI_LOCALES, localeNativeName } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

const LANGUAGES = ["auto", "English", "Spanish", "French", "German", "Portuguese", "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic"];

// Short on purpose: a preview is billed per character and the user may audition
// a dozen voices in a row. Long enough to hear timbre, not a paragraph.
const VOICE_PREVIEW_TEXT = "Hi, I'm Juno. This is how I sound when I read an answer aloud.";

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
    // One container system for every section: same radius, same border (the
    // Card default border-border/70), same padding, same eyebrow margin.
    // flex-col + h-full so side-by-side tiles stretch to equal height and
    // internals can pin footers with mt-auto.
    <Card
      style={{ animationDelay: `${i * 55}ms` }}
      className={cn("flex h-full flex-col rounded-[20px] p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]", span && "sm:col-span-2", className)}
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

  // Voice preview: at most one audition at a time — a new click cancels whatever
  // is loading or playing. `previewSeq` is the ownership token; every stop mints
  // a fresh one so a slow fetch that lands after its click was superseded can
  // neither start playing nor touch the UI.
  const [preview, setPreview] = React.useState<{ id: string; loading: boolean } | null>(null);
  const previewAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = React.useRef<string | null>(null);
  const previewSeqRef = React.useRef(0);

  const stopPreview = React.useCallback(() => {
    previewSeqRef.current++;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.onended = null;
      previewAudioRef.current.onerror = null;
      previewAudioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }, []);

  // Leaving the page mid-preview must not keep the blob alive or keep talking.
  React.useEffect(() => stopPreview, [stopPreview]);

  const playPreview = async (voiceId: string) => {
    const wasActive = preview?.id === voiceId;
    stopPreview();
    if (wasActive) return; // clicking the live preview again just stops it
    const seq = previewSeqRef.current; // claim the token stopPreview just minted
    setPreview({ id: voiceId, loading: true });
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: VOICE_PREVIEW_TEXT, voiceId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (previewSeqRef.current !== seq) return; // superseded while fetching
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewUrlRef.current = url;
      previewAudioRef.current = audio;
      const done = () => {
        if (previewSeqRef.current === seq) stopPreview();
      };
      audio.onended = done;
      audio.onerror = done;
      setPreview({ id: voiceId, loading: false });
      await audio.play();
    } catch {
      if (previewSeqRef.current !== seq) return; // a newer preview already owns the UI
      stopPreview();
      toast.error("Could not play that preview.");
    }
  };

  const save = React.useCallback(
    async (patch: Partial<ClientSettings>) => {
      setSettings(patch);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) toast.error("Could not save settings.");
      return res.ok;
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

  // A full reload, not router.refresh(): the locale decides `<html lang>`/`dir`
  // server-side, and the already-translated DOM has to come back from the
  // source catalog rather than be translated a second time in place.
  const setUiLocale = async (uiLocale: string) => {
    if (await save({ uiLocale })) window.location.reload();
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

  // Falls back rather than leaving the group unselected if the stored preset was retired.
  const activePersonality = isPersonalityId(settings.personality) ? settings.personality : DEFAULT_PERSONALITY;

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
            <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-5">
              {/* Plan info (Left) */}
              <div className="field-well md:col-span-2 flex flex-col justify-between rounded-[12px] bg-accent/40 border border-border/50 p-4">
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
                      <li key={idx} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Check className="h-3 w-3 text-primary shrink-0" />
                        <span className="truncate">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t border-border/40">
                  <span className="font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground">
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
              <div className="field-well md:col-span-3 flex flex-col justify-center rounded-[12px] border border-border/50 p-4 bg-card">
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
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      No usage limits on this plan.
                    </p>
                  </div>
                ) : quota.plan === "FREE" ? (
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
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
                    <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
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
            <div className="grid gap-6 sm:grid-cols-2">
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

          {/* Default model — spans so the two language selects below pair off
              in the 2-column grid instead of leaving a half-empty row. */}
          <Tile eyebrow="Default model" i={2} span>
            <p className="mb-3 text-sm text-muted-foreground">
              Used for new conversations. Choose Auto to route each prompt to the cheapest capable model.
            </p>
            <Select
              value={resolveModel(settings.defaultModel)?.id ?? settings.defaultModel}
              onValueChange={(v) => save({ defaultModel: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="juno:auto">
                  Auto
                  <span className="ml-1.5 text-xs text-muted-foreground">· cheapest model that can handle the prompt</span>
                </SelectItem>
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

          {/* Interface language — Juno's own chrome, not Juno's replies. */}
          <Tile eyebrow="Interface language" i={4}>
            <p className="mb-3 text-sm text-muted-foreground">The language Juno&apos;s buttons and menus are in.</p>
            <Select value={settings.uiLocale} onValueChange={(v) => void setUiLocale(v)}>
              <SelectTrigger aria-label="Interface language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_LOCALE}>Auto-detect</SelectItem>
                {UI_LOCALES.map((l) => (
                  // Each language names itself, so whoever needs the option can
                  // read it — and data-no-auto-translate keeps it that way if a
                  // future catalog ever picks these names up.
                  <SelectItem key={l} value={l}>
                    <span data-no-auto-translate lang={l}>
                      {localeNativeName(l)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Tile>

          {/* Response style */}
          <Tile eyebrow="Response style" i={5} span>
            <p className="mb-3 text-sm text-muted-foreground">
              How Juno writes. Your custom instructions below still take priority.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Response style">
              {PERSONALITIES.map((p) => {
                const selected = activePersonality === p.id;
                return (
                  <button
                    key={p.id}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => save({ personality: p.id })}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-xl border p-3 text-left shadow-pop transition-[transform,box-shadow,background-color,border-color] duration-fast ease-out-soft hover:bg-accent hover:shadow-float motion-safe:hover:-translate-y-0.5",
                      selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/70"
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                      {p.label}
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{p.description}</span>
                  </button>
                );
              })}
            </div>
          </Tile>

          {/* Read-aloud voice — every clause here removes a way this could be a
              control that looks alive and does nothing:
                serverTts   — else the browser fallback speaks in the OS voice and
                              none of these thirteen voices is ever heard.
                ttsProvider — the list is OpenAI's. Under ElevenLabs the route
                              correctly drops an OpenAI id (it would 404 there) and
                              uses its own default, so the choice is ignored.
                plan.voice  — /api/voice/tts 403s without it, so on Free every
                              preview button would fail silently. */}
          {features.serverTts && features.ttsProvider === "openai" && plan.voice && (
            <Tile eyebrow="Read-aloud voice" i={6} span>
              <p className="mb-3 text-sm text-muted-foreground">
                The voice Juno reads answers aloud in. Press play to hear one.
              </p>
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                role="radiogroup"
                aria-label="Read-aloud voice"
              >
                {VOICES.map((v) => {
                  const selected = (settings.voiceId ?? DEFAULT_VOICE) === v.id;
                  const active = preview?.id === v.id;
                  const loading = active && preview.loading;
                  return (
                    // relative + hover:z-10 so the lifted tile's shadow lands on top
                    // of its neighbours instead of being painted over by them.
                    <div
                      key={v.id}
                      className={cn(
                        "relative flex items-center gap-2 rounded-xl border p-3 shadow-pop transition-[transform,box-shadow,background-color,border-color] duration-fast ease-out-soft hover:z-10 hover:bg-accent hover:shadow-float motion-safe:hover:-translate-y-0.5",
                        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/70"
                      )}
                    >
                      {/* Overlay button = the whole tile selects, while the play
                          button below stays a real sibling (nesting it inside would
                          be invalid HTML and unreachable by keyboard). */}
                      <button
                        role="radio"
                        aria-checked={selected}
                        aria-label={`Read aloud in the ${v.label} voice`}
                        onClick={() => save({ voiceId: v.id })}
                        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                      />
                      <div className="pointer-events-none min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          {v.label}
                          {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">{v.description}</span>
                      </div>
                      {/* secondary, not ghost: a ghost button's hover:bg-accent is the
                          same wash the tile itself gets on hover, which would leave
                          the play control with no hover feedback of its own. */}
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        // z-10: sits above the full-tile overlay button that precedes it.
                        className="relative z-10 shrink-0"
                        onClick={() => void playPreview(v.id)}
                        aria-label={active ? `Stop the ${v.label} preview` : `Preview the ${v.label} voice`}
                      >
                        {/* h-4 w-4 to match the [&_svg]:size-4 the Button base forces —
                            a smaller class here would be silently out-specified. */}
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : active ? (
                          <Square className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </Tile>
          )}

          <Tile eyebrow="Custom instructions" i={7} span>
            <p className="mb-3 text-sm text-muted-foreground">
              Juno keeps these in mind in every conversation. No character cap — long system prompts and curricula are fine; the model context window is the only real limit.
            </p>
            <div className="relative">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={saveInstructions}
                placeholder="E.g. I'm a product manager. Keep answers concise and use bullet points."
                className="min-h-[110px] pb-8"
              />
              <span className="absolute bottom-2.5 right-3 font-mono text-[10px] text-muted-foreground/50 select-none">
                {instructions.length.toLocaleString()} chars
              </span>
            </div>
          </Tile>

          {/* Memory — pairs with Account below; both tiles stretch to the same
              height (grid stretch + Tile's flex-col), buttons pinned to the
              bottom edge with mt-auto so the pair reads as one system. */}
          <Tile eyebrow="Memory" i={8}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <NotebookPen className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium">Reference saved memories</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Manage what Juno remembers</p>
                </div>
              </div>
              <Switch checked={settings.memoryEnabled} onCheckedChange={(v) => save({ memoryEnabled: v })} aria-label="Toggle memory" />
            </div>
            <div className="mt-auto pt-4">
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/memory">Open memory manager</Link>
              </Button>
            </div>
          </Tile>

          {/* Account */}
          <Tile eyebrow="Account" i={9}>
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
            </div>
            <div className="mt-auto space-y-2 pt-4">
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

          {/* Email notifications */}
          <Tile eyebrow="Email notifications" i={10} span>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div>
                  <p className="text-sm font-medium">Budget alerts</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Email me at 80% of my monthly budget.
                  </p>
                </div>
                <Switch
                  checked={settings.emailBudgetAlerts}
                  onCheckedChange={(v) => save({ emailBudgetAlerts: v })}
                  aria-label="Toggle budget alert emails"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Weekly digest</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Usage recap every Monday.
                  </p>
                </div>
                <Switch
                  checked={settings.emailWeeklyDigest}
                  onCheckedChange={(v) => save({ emailWeeklyDigest: v })}
                  aria-label="Toggle weekly digest emails"
                />
              </div>

              {!features.email && (
                <p className="pt-3 border-t border-border/40 text-xs text-muted-foreground/70">
                  Email delivery isn&apos;t configured yet — your preferences are saved and take effect once it is.
                </p>
              )}
            </div>
          </Tile>

          {/* Danger zone — same calm container as every other section; the
              danger lives in the buttons (destructive-outline fills red on
              hover), not in a shouting border. */}
          <Tile eyebrow="Danger zone" i={11} span className="border-destructive/20">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div>
                  <p className="text-sm font-medium">Delete all conversations</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete all your chat history.
                  </p>
                </div>
                <Button variant="destructive-outline" size="sm" onClick={() => setDeleteChatsOpen(true)} className="gap-2 shrink-0">
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
                <Button variant="destructive-outline" size="sm" onClick={() => setDeleteOpen(true)} className="gap-2 shrink-0">
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
