"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { NotebookPen, Loader2, Monitor, Moon, Play, Square, Sun, Plus, CalendarClock } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { AppPageHeader } from "@/components/app/app-page-header";
import { useApp } from "@/components/app/app-provider";
import { PermissionsSection } from "@/components/settings/permissions-section";
import { Tile, TileSaveStatus, type TileSaveState } from "@/components/settings/tile";
import { SettingsGroup, SettingsSectionNav, type SettingsSection } from "@/components/settings/section-nav";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { resolveModel } from "@/lib/models";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { PLANS, canUseModel } from "@/lib/plans";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";
import { VOICES, DEFAULT_VOICE } from "@/lib/voices";
import { AUTO_LOCALE, UI_LOCALES, localeNativeName } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { describeCapSource, type BudgetCapSource } from "@/lib/spend-ceiling";
import type { ClientSettings } from "@/types/app";
import { staggerDelay } from "@/lib/motion";

const LANGUAGES = ["auto", "English", "Spanish", "French", "German", "Portuguese", "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic"];

/** The custom-colour swatch is the last option of the accent radiogroup, not a control beside it. */
const CUSTOM_ACCENT = "__custom__";
const ACCENT_OPTIONS: string[] = [...ACCENTS.map((a) => a.id), CUSTOM_ACCENT];

// Short on purpose: a preview is billed per character and the user may audition
// a dozen voices in a row. Long enough to hear timbre, not a paragraph.
const VOICE_PREVIEW_TEXT = "Hi, I'm Juno. This is how I sound when I read an answer aloud.";

/**
 * The rail, and the reading order of the page.
 *
 * Order is deliberate: what you are paying and what you have spent first, then
 * the things people actually come here to change, then account and access, and
 * the irreversible operations last and alone. `id` must match the SettingsGroup
 * it names — that string is both the anchor target and the scroll-spy key.
 */
const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "usage", label: "Plan & usage" },
  { id: "appearance", label: "Appearance" },
  { id: "chat", label: "Chat defaults" },
  { id: "data", label: "Memory" },
  { id: "account", label: "Account & access" },
  { id: "danger", label: "Danger zone" },
];


/**
 * One accent swatch — the picker and the custom-colour button are the same
 * control and were two hand-rolled ones, sitting in the same Appearance tile as
 * a theme picker built on `<Pressable>`. Two pickers, one tile, two affordance
 * vocabularies. `kind="icon"` is the primitive for a bare glyph you press, and
 * it is already circular; `hover:bg-transparent` neutralises its accent fill,
 * which would otherwise paint over the inline swatch colour on hover.
 */
const AccentSwatch = React.forwardRef<
  HTMLButtonElement,
  {
    selected: boolean;
    /** The fill. `background` rather than `backgroundColor` so a gradient works. */
    background: string;
    /** Colour the glyph is measured against — the gradient has no single one. */
    inkAgainst?: string;
    label: string;
    onClick: () => void;
    children?: React.ReactNode;
  } & Pick<React.ComponentPropsWithoutRef<"button">, "tabIndex" | "onKeyDown">
>(function AccentSwatch({ selected, background, inkAgainst, label, onClick, children, ...rest }, ref) {
  return (
    <Pressable
      ref={ref}
      kind="icon"
      size="lg"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={cn(
        // `ring-offset-background`, not `ring-offset-card`: this grid lives
        // inside <Tile>, which is bg-transparent over the page ground, so the
        // 2px gap was being painted in --card — a colour that matches nothing
        // behind it, and on pure black a 6.5% halo around the selected swatch.
        "overflow-hidden ring-offset-2 ring-offset-background hover:bg-transparent motion-safe:hover:scale-110",
        selected && "ring-2 ring-foreground"
      )}
      style={{ background, color: swatchInk(inkAgainst ?? background) }}
      {...rest}
    >
      {children}
    </Pressable>
  );
});

const CustomPickerButton = React.forwardRef<
  HTMLButtonElement,
  {
    selected: boolean;
    customColor: string;
    onChange: (color: string) => void;
  } & Pick<React.ComponentPropsWithoutRef<"button">, "tabIndex" | "onKeyDown">
>(function CustomPickerButton({ selected, customColor, onChange, ...rest }, ref) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      {/* A proxy the labeled button opens via .click(); it must not be its own
          unnamed tab stop in the accessibility tree. */}
      <input
        ref={pickerRef}
        type="color"
        value={customColor}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <AccentSwatch
        ref={ref}
        selected={selected}
        background={
          selected ? customColor : "linear-gradient(135deg, #ff007f, #7f00ff, #00ffff, #00ff7f, #ffea00)"
        }
        // Unselected the swatch is a full-spectrum gradient, so no single ink
        // clears it — the drop shadow below is what keeps the glyph readable.
        inkAgainst={selected ? customColor : undefined}
        label="Custom accent color"
        onClick={() => pickerRef.current?.click()}
        {...rest}
      >
        {selected ? (
          <StatusIcons.success className="size-4" />
        ) : (
          <Plus className="size-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        )}
      </AccentSwatch>
    </div>
  );
});

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
/** Euro amounts, with enough precision to be believed at the low end. */
function formatEur(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<0,01 €";
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function UsageMeter({ label, subtitle, pct }: { label: string; subtitle: string; pct: number }) {
  const shown = Math.min(100, Math.round(pct * 100));
  const hot = pct >= 0.9;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-caption text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex min-w-40 flex-1 items-center gap-3">
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          // ring-1 ring-inset: on pure black a bare `bg-muted` track (9.5%) has
          // no edge, and every other meter in the product draws this hairline.
          className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10"
        >
          <div
            className={cn(
              // Scoped, not `transition-all` — the only two properties that
              // change here are the fill width and its tone at the 90% mark.
              "absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-base ease-out-soft motion-reduce:transition-none",
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

/**
 * The spend ceiling, said out loud.
 *
 * Juno enforces a euro ceiling on every account — including the personal one,
 * which used to be the single account with no ceiling at all — and the usage
 * tile showed percentages and a remaining balance without ever naming the
 * number or who chose it. A limit the user cannot see is a limit they meet by
 * surprise.
 *
 * Lowering is the operation offered, because raising is the one that cannot do
 * anything: the effective ceiling is the MINIMUM of the plan's figure and this
 * one, so a bigger number here buys nothing a plan has not already paid for.
 * The exception is the account whose plan states no figure, where this IS the
 * ceiling — which is exactly the account that most needs the control.
 */
function SpendCeiling({
  ceilingEur,
  storedCapEur,
  capSource,
  capDisabled,
  onSave,
}: {
  ceilingEur: number | null;
  storedCapEur: number | null;
  capSource: BudgetCapSource;
  capDisabled: boolean;
  onSave: (eur: number | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = React.useState(storedCapEur == null ? "" : String(storedCapEur));
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    setDraft(storedCapEur == null ? "" : String(storedCapEur));
  }, [storedCapEur]);

  const parsed = draft.trim() === "" ? null : Number(draft);
  const valid = parsed == null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000);
  const dirty = (parsed ?? null) !== (storedCapEur ?? null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !dirty || saving) return;
    setSaving(true);
    const ok = await onSave(parsed);
    setSaving(false);
    if (ok) toast.success("Spend ceiling updated.");
  };

  if (capDisabled) {
    // Loud on purpose. This is the one bypass that exists, and an account
    // running without a ceiling must never look like an account on a generous
    // plan — the two states are opposites and used to render identically.
    return (
      <div
        role="status"
        className="rounded-field border border-warning/40 bg-warning/10 p-4"
      >
        <p className="text-sm font-medium text-warning">Spend ceiling is switched off</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Nothing is capping what this account can spend on models. This is a development
          escape hatch — turn it back on before using the account normally.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-field border border-border/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Monthly spend ceiling</span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {ceilingEur == null ? "—" : formatEur(ceilingEur)}
        </span>
      </div>
      <p aria-live="polite" className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {describeCapSource(capSource)}. Juno stops generating once a billing period reaches
        this figure.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1">
          <Label htmlFor="spend-cap" className="mb-1.5 block text-xs text-muted-foreground">
            Your own ceiling, in euros
          </Label>
          <Input
            id="spend-cap"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Use the default"
            aria-invalid={!valid}
            aria-describedby="spend-cap-help"
          />
        </div>
        {/* No height override on either control: forcing h-11 here made this the
            one 44px field on a page whose four other fields are the primitives'
            36px, and paired it with a button that was lg-tall and default-wide. */}
        <Button type="submit" disabled={!valid || !dirty || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      <p id="spend-cap-help" className="mt-2 text-caption text-muted-foreground">
        {valid
          ? "Leave it empty to fall back to the default. A ceiling above your plan's changes nothing — the lower of the two always wins."
          : "Enter a whole number of euros between 0 and 100000."}
      </p>
    </form>
  );
}

function SettingsContent({ hideHeader, filterGroup }: { hideHeader?: boolean; filterGroup?: string }) {
  const router = useRouter();
  const { user, settings, setSettings, quota, spend, features, models } = useApp();
  const { setTheme } = useTheme();
  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  // The blur-save's voice. Without it the only success signal was silence —
  // the page toasts failures, so "nothing happened" meant "it worked", which
  // is not a thing a user can be expected to know.
  const [instructionsSave, setInstructionsSave] = React.useState<TileSaveState>("idle");
  const instructionsTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(instructionsTimerRef.current), []);
  const [deleteChatsOpen, setDeleteChatsOpen] = React.useState(false);
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
      // Roll the optimistic write back when the server refuses it. Without this
      // every control on the page — the switches, the selects, the radio tiles —
      // kept showing the value the server rejected, so a toast said the save
      // failed while the UI went on claiming it had succeeded. PermissionsSection
      // has always done this; the rest of the page had not.
      const previous = Object.fromEntries(
        (Object.keys(patch) as (keyof ClientSettings)[]).map((key) => [key, settings[key]])
      ) as Partial<ClientSettings>;
      setSettings(patch);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSettings(previous);
        toast.error("Could not save settings.");
      }
      return res.ok;
    },
    [setSettings, settings]
  );

  // Both of these write somewhere `settings` does not reach — the <html> dataset
  // and next-themes — so the rollback above cannot undo them on its own.
  const setAccent = async (accent: string) => {
    const previous = settings.accent;
    document.documentElement.dataset.accent = accent;
    if (!(await save({ accent }))) document.documentElement.dataset.accent = previous;
  };

  const setThemePref = async (theme: ClientSettings["theme"]) => {
    const previous = settings.theme;
    setTheme(theme);
    if (!(await save({ theme }))) setTheme(previous);
  };

  // A full reload, not router.refresh(): the locale decides `<html lang>`/`dir`
  // server-side, and the already-translated DOM has to come back from the
  // source catalog rather than be translated a second time in place.
  const setUiLocale = async (uiLocale: string) => {
    if (await save({ uiLocale })) window.location.reload();
  };

  const saveInstructions = async () => {
    if (instructions === settings.customInstructions) return;
    clearTimeout(instructionsTimerRef.current);
    setInstructionsSave("saving");
    const ok = await save({ customInstructions: instructions });
    setInstructionsSave(ok ? "saved" : "failed");
    // Transient like the permissions card's confirmation; the failed state
    // stays until the next attempt because the draft it describes is still
    // sitting unsaved in the textarea.
    if (ok) instructionsTimerRef.current = setTimeout(() => setInstructionsSave("idle"), 4000);
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
  const activeVoice = settings.voiceId ?? DEFAULT_VOICE;
  const accentIsPreset = ACCENTS.some((a) => a.id === settings.accent);
  const customAccent = !accentIsPreset && settings.accent.startsWith("#");

  // Every `role="radiogroup"` on this page, wired to the keyboard behaviour the
  // role advertises. See use-radio-group.ts for what four of them were missing.
  const themeOption = useRadioGroup(
    themeOptions,
    themeOptions.findIndex((t) => t.value === settings.theme),
    (t) => void setThemePref(t.value)
  );
  const accentOption = useRadioGroup(
    ACCENT_OPTIONS,
    customAccent ? ACCENTS.length : ACCENTS.findIndex((a) => a.id === settings.accent),
    // Arrowing onto the custom swatch cannot commit a colour that does not exist
    // yet: it takes focus, and the click is what opens the wheel.
    (id) => {
      if (id !== CUSTOM_ACCENT) void setAccent(id);
    }
  );
  const styleOption = useRadioGroup(
    PERSONALITIES,
    PERSONALITIES.findIndex((p) => p.id === activePersonality),
    (p) => void save({ personality: p.id })
  );
  const voiceOption = useRadioGroup(
    VOICES,
    VOICES.findIndex((v) => v.id === activeVoice),
    (v) => void save({ voiceId: v.id })
  );

  const plan = PLANS[quota.plan];
  const windows = spend.windows;
  const unlimited = spend.budgetMicroUsd == null;
  // Free is browse-only, and an account with its ceiling switched off is a
  // warning state, not a healthy one. Neither earns a green "live" pip.
  const generating = quota.plan !== "FREE" && !spend.capDisabled;

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

  /*
   * The euro figures, shown rather than withheld.
   *
   * Juno computes an exact per-request cost, writes an ApiSpend ledger row for
   * every call, and enforces a monthly budget in euros — and this dashboard
   * showed percentages only. Seven of eight incumbents publish nothing but
   * relative multipliers ("4x higher"), and Google removed its numeric quotas
   * outright; on the indie side the closest comparable dashboards carry no
   * currency at all. The number exists here and is the clearest thing Juno can
   * say that nobody else does, so it says it.
   *
   * Formatted from the same micro-USD the ledger stores, converted at the same
   * rate the server bills at — no second source of truth.
   */
  const eurPerUsd = spend.eurPerUsd > 0 ? spend.eurPerUsd : 1;
  const spentEur = (spend.spentMicroUsd / 1_000_000) * eurPerUsd;
  const budgetEur =
    spend.budgetMicroUsd == null ? null : (spend.budgetMicroUsd / 1_000_000) * eurPerUsd;
  // Money already held by turns that are still streaming. Netting it off the
  // headroom is what stops the tile promising a balance the next turn will
  // discover is gone.
  const heldEur = (spend.reservedMicroUsd / 1_000_000) * eurPerUsd;
  const remainingEur = budgetEur == null ? null : Math.max(0, budgetEur - spentEur - heldEur);

  const saveSpendCap = React.useCallback(
    async (monthlySpendCapEur: number | null) => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlySpendCapEur }),
      });
      if (!res.ok) {
        toast.error("Could not save the spend ceiling.");
        return false;
      }
      // The ceiling is server-rendered into the bootstrap alongside the meters,
      // so a refresh is what makes the number and the gauges agree again;
      // patching local state would show a ceiling the server has not confirmed.
      router.refresh();
      return true;
    },
    [router]
  );

  const renewsAtMs = spend.billing.renewsAtMs;
  const cancelAtPeriodEnd = spend.billing.cancelAtPeriodEnd;

  return (
    <div className={cn(!hideHeader && "app-page-scroll")}>
      {/*
       * Wider than the old max-w-3xl because the page is now two columns, not
       * one: the rail takes 13rem and the content column keeps roughly the
       * measure it always had. Inside the settings MODAL there is no room for a
       * rail, so `hideHeader` keeps the original single column — the modal shows
       * a subset and never got long enough to need an index.
       */}
      <div className={cn("mx-auto w-full", hideHeader ? "max-w-3xl px-0 py-0" : "max-w-5xl app-page-content")}>
        {!hideHeader && <AppPageHeader eyebrow="Settings" heading="Settings" lede={user.email} />}

        <div className={cn(!hideHeader && "lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12")}>
          {!hideHeader && (
            /*
             * Hidden below lg rather than collapsed into a horizontal scroller.
             * A tab strip that scrolls sideways hides most of its own options,
             * which is the problem the rail exists to fix — on a phone the
             * honest answer is the plain scroll the page already was.
             */
            <aside className="hidden lg:block">
              <div className="sticky top-2">
                <SettingsSectionNav sections={SETTINGS_SECTIONS} />
              </div>
            </aside>
          )}

          <div className="min-w-0">
        {(!filterGroup || filterGroup === "usage") && (
          <SettingsGroup
            id="usage"
            title="Plan & usage"
            description="What you are on, what you have spent, and the ceiling that stops it."
          >
          {/* Usage dashboard */}
          <Tile eyebrow="Usage" i={0}>
            <div className="grid grid-cols-1 overflow-hidden rounded-card border border-border/70 lg:grid-cols-[15rem_1fr]">
              {/* Plan info (Left) — `bg-secondary`, opaque, exactly one rung
                  apart from the `bg-card` panel beside it. `bg-muted/35`
                  resolved to ~3.3% lightness over pure black, so the two halves
                  of the card collapsed into one undifferentiated field and only
                  the divider survived. */}
              <div className="flex flex-col justify-between border-b border-border/70 bg-secondary p-5 lg:border-b-0 lg:border-r">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    {/* No hand tracking: its counterpart — the euro figure in
                        the pane beside it — is the same text-base font-semibold
                        without it, and the two head the two halves of one card. */}
                    <span className="text-base font-semibold">
                      {plan.name} Plan
                    </span>
                    {/* A green liveness pip only where the account can actually
                        generate. It used to render on every plan — including
                        FREE, 57 lines above a tile that says Free cannot use
                        models at all — and on an account whose ceiling has been
                        switched off, where the tile beside it is a warning.
                        motion-safe: the reduced-motion block in globals.css
                        enumerates the loops it stops and never included this. */}
                    {generating && (
                      <span className="relative flex size-2" aria-hidden>
                        <span className="absolute inline-flex size-full rounded-full bg-success opacity-75 motion-safe:animate-ping" />
                        <span className="relative inline-flex size-2 rounded-full bg-success" />
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {plan.tagline}
                  </p>

                  {/* Plan Features */}
                  <ul className="mt-4 space-y-1.5">
                    {plan.features.slice(0, 3).map((feat, idx) => (
                      <li key={idx} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusIcons.success className="size-3 text-primary shrink-0" />
                        <span className="truncate">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t border-border/60">
                  <span className="font-mono text-caption text-muted-foreground">
                    {plan.price > 0 ? `${plan.price} € HT/mo` : "Active tier"}
                  </span>
                  {/* Outline, because the pane on the right of this same card
                      renders a filled "Upgrade" for exactly the same condition
                      (FREE + billing) — so a free account was looking at two
                      identical primary CTAs 200px apart inside one border. The
                      one that keeps the fill is the one that comes with the
                      sentence explaining why you would press it; this one is
                      the shortcut beside the price. */}
                  {/* Plain size="sm" — the h-7 override sat below the button
                      ladder's smallest rung and silently fought the coarse:h-10
                      touch-target bump the primitive exists to guarantee. */}
                  {quota.plan === "FREE" && features.billing && (
                    <Button asChild variant="outline" size="sm">
                      <Link href="/upgrade">Upgrade</Link>
                    </Button>
                  )}
                </div>
              </div>

              {/* Usage windows (Right) — euros remaining this period, then the
                  rolling session + weekly percentages */}
              <div className="flex flex-col justify-center bg-card p-5">
                {unlimited ? (
                  <div>
                    <div className="flex items-center gap-[3.5px] py-1.5" aria-hidden>
                      {/* motion-safe + the shared stagger rung: this loop ran
                          forever under prefers-reduced-motion, and its offset was
                          a hand-written 65ms step with a literal 1.6s duration. */}
                      {Array.from({ length: 32 }).map((_, i) => (
                        <span
                          key={i}
                          className="h-[5px] w-[5px] rounded-full bg-primary/75 motion-safe:animate-pulse"
                          style={staggerDelay(i, "tight")}
                        />
                      ))}
                    </div>
                    {/* Reached ONLY when the ceiling has been switched off.
                        It used to also mean "this plan states no budget", and
                        conflating the two is how the personal account spent a
                        year looking generous rather than unguarded. */}
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      Nothing is metering this account right now.
                    </p>
                  </div>
                ) : quota.plan === "FREE" ? (
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Free is a browse-only tier. Upgrade to Pro to start using models.
                    </p>
                    {features.billing && (
                      <Button asChild size="sm">
                        <Link href="/upgrade">Upgrade</Link>
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {budgetEur != null && (
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-base font-semibold tabular-nums">
                          {formatEur(remainingEur ?? 0)}{" "}
                          <span className="font-sans text-caption font-normal text-muted-foreground">
                            left this month
                          </span>
                        </span>
                        <span className="font-mono text-caption tabular-nums text-muted-foreground">
                          {formatEur(spentEur)} of {formatEur(budgetEur)}
                        </span>
                      </div>
                    )}
                    <UsageMeter label="Current session" subtitle={sessionSubtitle} pct={windows.session.pct} />
                    <div className="border-t border-border/60" />
                    <span className="block font-mono text-caption text-muted-foreground">
                      Weekly limits
                    </span>
                    <UsageMeter label="All models" subtitle={weeklySubtitle} pct={windows.weekly.pct} />
                    {renewsAtMs != null && (
                      <p className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                        <CalendarClock className="size-3.5 opacity-70" />
                        {cancelAtPeriodEnd ? "Access ends" : "Budget renews"} {formatDate(renewsAtMs)}
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-4">
                  <SpendCeiling
                    ceilingEur={budgetEur}
                    storedCapEur={spend.userCapEur}
                    capSource={spend.capSource}
                    capDisabled={spend.capDisabled}
                    onSave={saveSpendCap}
                  />
                </div>
              </div>
            </div>
          </Tile>

          </SettingsGroup>
        )}

        {(!filterGroup || filterGroup === "appearance") && (
          <SettingsGroup
            id="appearance"
            title="Appearance"
            description="How Juno looks on this device, and the language its own chrome speaks."
          >
          {/* Appearance */}
          <Tile eyebrow="Appearance" i={1}>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Theme</Label>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                  {themeOptions.map((t, i) => {
                    const selected = settings.theme === t.value;
                    return (
                      <Pressable
                        key={t.value}
                        kind="tile"
                        role="radio"
                        selected={selected}
                        aria-checked={selected}
                        onClick={() => void setThemePref(t.value)}
                        className="items-center gap-1.5"
                        {...themeOption(i)}
                      >
                        <t.icon className="size-4" />
                        {t.label}
                      </Pressable>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Accent color</Label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent color">
                  {ACCENTS.map((a, i) => {
                    const selected = settings.accent === a.id;
                    return (
                      <AccentSwatch
                        key={a.id}
                        selected={selected}
                        background={a.color}
                        label={a.id}
                        onClick={() => void setAccent(a.id)}
                        {...accentOption(i)}
                      >
                        {selected && <StatusIcons.success className="size-4" />}
                      </AccentSwatch>
                    );
                  })}
                  <CustomPickerButton
                    selected={customAccent}
                    customColor={customAccent ? settings.accent : "#ea580c"}
                    onChange={(color) => void setAccent(color)}
                    {...accentOption(ACCENTS.length)}
                  />
                </div>
              </div>
            </div>
          </Tile>

          {/* Interface language — Juno's own chrome, not Juno's replies. */}
          <Tile eyebrow="Interface language" i={2}>
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

          </SettingsGroup>
        )}

        {(!filterGroup || filterGroup === "chat") && (
          <SettingsGroup
            id="chat"
            title="Chat defaults"
            description="The starting point for every new conversation. Anything here can still be overridden per message."
          >
          {/* Default model */}
          <Tile eyebrow="Default model" i={3}>
            <p className="mb-3 text-sm text-muted-foreground">
              Used for new conversations. Choose Auto to route each prompt to the cheapest capable model.
            </p>
            <Select
              value={resolveModel(settings.defaultModel)?.id ?? settings.defaultModel}
              onValueChange={(v) => save({ defaultModel: v })}
            >
              <SelectTrigger aria-label="Default model">
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
          <Tile eyebrow="Response language" i={4}>
            <p className="mb-3 text-sm text-muted-foreground">The language Juno replies in.</p>
            <Select value={settings.responseLanguage} onValueChange={(v) => save({ responseLanguage: v })}>
              <SelectTrigger aria-label="Response language">
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

          {/* Response style */}
          <Tile eyebrow="Response style" i={5}>
            <p className="mb-3 text-sm text-muted-foreground">
              How Juno writes. Your custom instructions below still take priority.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Response style">
              {PERSONALITIES.map((p, i) => {
                const selected = activePersonality === p.id;
                return (
                  <Pressable
                    key={p.id}
                    kind="tile"
                    role="radio"
                    selected={selected}
                    aria-checked={selected}
                    onClick={() => void save({ personality: p.id })}
                    // No `shadow-none`. Tailwind emits utilities after the
                    // components layer, so it beat the `tile` kind's own
                    // selected treatment (`shadow-pop`) and this grid lost the
                    // one cue that separates the chosen card from the rest —
                    // while the theme picker three tiles up, which passes no
                    // className at all, kept it. Two radiogroups in one page
                    // marking "selected" differently.
                    {...styleOption(i)}
                  >
                    <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                      {p.label}
                      {selected && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{p.description}</span>
                  </Pressable>
                );
              })}
            </div>
          </Tile>

          {/* Custom instructions — directly under the style presets on purpose:
              the presets' copy points at "your custom instructions below", and
              the two are one system (a named tone, then your own words on top),
              which is only legible when they sit together. */}
          <Tile
            eyebrow="Custom instructions"
            i={6}
            aside={<TileSaveStatus state={instructionsSave} failedMessage="Couldn't save. Your draft is still here." />}
          >
            <p className="mb-3 text-sm text-muted-foreground">
              Juno keeps these in mind in every conversation. No character cap — long system prompts and curricula are fine; the model context window is the only real limit.
            </p>
            <div className="relative">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={() => void saveInstructions()}
                placeholder="E.g. I'm a product manager. Keep answers concise and use bullet points."
                // min-h-28, not 110px: the 4pt grid's nearest rung, and the only
                // height on this page that was off it.
                className="min-h-28 pb-8"
              />
              {/* On the type scale and at full muted ink: it was 10px at half the ramp. */}
              <span className="absolute bottom-2.5 right-3 select-none font-mono text-caption text-muted-foreground">
                {instructions.length.toLocaleString()} chars
              </span>
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
            <Tile eyebrow="Read-aloud voice" i={7}>
              <p className="mb-3 text-sm text-muted-foreground">
                The voice Juno reads answers aloud in. Press play to hear one.
              </p>
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                role="radiogroup"
                aria-label="Read-aloud voice"
              >
                {VOICES.map((v, i) => {
                  const selected = activeVoice === v.id;
                  const active = preview?.id === v.id;
                  const loading = active && preview.loading;
                  return (
                    // The tile is the same `<Pressable kind="tile">` the Response
                    // style grid 30 lines up uses. It used to be a hand-copied
                    // radio card that had drifted on every axis — 12px radius vs
                    // 16, a different border, a different hover, a different
                    // selected treatment — with a full-bleed invisible overlay
                    // button whose focus ring was drawn on a different element
                    // than the card the user sees.
                    // The lift lives on the wrapper, not the tile: the play button
                    // is a sibling, so lifting only the tile would leave the two
                    // halves of one card moving apart. hover:z-10 so the lifted
                    // shadow lands on its neighbours rather than under them.
                    <div
                      key={v.id}
                      className="group relative hover:z-10"
                    >
                      <Pressable
                        kind="tile"
                        role="radio"
                        selected={selected}
                        aria-checked={selected}
                        aria-label={`Read aloud in the ${v.label} voice`}
                        onClick={() => void save({ voiceId: v.id })}
                        // pr-12 only — `shadow-none` here killed the same
                        // selected `shadow-pop` the Response style grid above
                        // was losing, so the two voice tiles in one row could
                        // differ from the style tiles beside them.
                        className="w-full pr-12"
                        {...voiceOption(i)}
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          {v.label}
                          {selected && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                        </span>
                        <span className="text-xs leading-relaxed text-muted-foreground">{v.description}</span>
                      </Pressable>
                      {/* A real sibling, not a child: nesting a button inside the
                          radio would be invalid HTML and unreachable by keyboard.
                          secondary, not ghost — a ghost button's hover:bg-accent
                          is the wash the tile itself takes on hover, leaving the
                          play control with no feedback of its own. */}
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        className="absolute right-3 top-1/2 z-10 -translate-y-1/2"
                        onClick={() => void playPreview(v.id)}
                        aria-label={active ? `Stop the ${v.label} preview` : `Preview the ${v.label} voice`}
                      >
                        {/* size-4 to match the [&_svg]:size-4 the Button base forces —
                            a smaller class here would be silently out-specified. */}
                        {loading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : active ? (
                          <Square className="size-4" />
                        ) : (
                          <Play className="size-4" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </Tile>
          )}
          </SettingsGroup>
        )}

        {(!filterGroup || filterGroup === "data" || filterGroup === "memory") && (
          <SettingsGroup
            id="data"
            title="Memory"
            description="What Juno is allowed to remember about you between conversations."
          >
          {/* Memory */}
          <Tile eyebrow="Memory" i={8}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <NotebookPen className="size-5 text-primary" />
                <div>
                  <p className="text-sm font-medium">Reference saved memories</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Manage what Juno remembers</p>
                </div>
              </div>
              <Switch checked={settings.memoryEnabled} onCheckedChange={(v) => save({ memoryEnabled: v })} aria-label="Toggle memory" />
            </div>

            {/* Background processing. This is the setting that decides whether
                memory work runs at all, and until now it had no control at
                all — so an account on the default mode watched "Regenerate
                summary" and every memory edit fail with nothing to change. */}
            <div className="mt-4">
              {/* The <Label> primitive at the same size and ink as every other
                  field label on this surface. A raw <label> at text-sm font-medium
                  was a third label voice inside one settings grid. */}
              <Label htmlFor="background-processing" className="block text-xs text-muted-foreground">
                Background processing
              </Label>
              <p id="background-processing-note" className="mb-2 mt-0.5 text-xs text-muted-foreground">
                Which providers may read your chats to build memory, titles and summaries — work you never see.
              </p>
              <Select
                value={settings.backgroundProviderMode}
                onValueChange={(v) => save({ backgroundProviderMode: v as ClientSettings["backgroundProviderMode"] })}
              >
                <SelectTrigger
                  id="background-processing"
                  aria-label="Background processing"
                  aria-describedby="background-processing-note"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="same_provider">Only the provider I chat with</SelectItem>
                  <SelectItem value="selected_provider">Only my selected provider</SelectItem>
                  <SelectItem value="any_allowed_provider">Any configured provider</SelectItem>
                  <SelectItem value="local_only">On-device models only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="mt-auto pt-4">
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/memory">Open memory manager</Link>
              </Button>
            </div>
          </Tile>

          </SettingsGroup>
        )}

        {(!filterGroup || filterGroup === "account") && (
          <SettingsGroup
            id="account"
            title="Account & access"
            description="Your identity, what reaches your inbox, and which connectors may act on your behalf."
          >
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
              {/* A real link to the page that owns the feature. This was a
                  `window.location.href` assignment dressed as a button — not
                  middle-clickable, not openable in a new tab — and it offered
                  only the JSON export, so a user who never visited Profile never
                  learned the Juno-package and CSV formats existed. */}
              <Button asChild variant="outline" size="sm" className="w-full gap-2">
                <Link href="/profile#account">
                  <ActionIcons.download className="size-4" /> Export my data
                </Link>
              </Button>
            </div>
          </Tile>

          {/* Email notifications */}
          <Tile eyebrow="Email notifications" i={10}>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/60">
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
                <p className="pt-3 border-t border-border/60 text-xs text-muted-foreground">
                  Email delivery isn&apos;t configured yet — your preferences are saved and take effect once it is.
                </p>
              )}
            </div>
          </Tile>

          {/* Connector permissions — owns its own tile (it loads its state from
              the server rather than from bootstrap settings). */}
          <PermissionsSection index={11} />

          </SettingsGroup>
        )}

        {(!filterGroup || filterGroup === "danger") && (
          <SettingsGroup
            id="danger"
            title="Danger zone"
            description="Irreversible. Each of these deletes data permanently."
          >
          {/* Danger zone — same calm container as every other section; the
              danger lives in the buttons (destructive-outline fills red on
              hover), not in a shouting border. */}
          {/* `border-b-destructive/40`, not `border-destructive/20`: <Tile>
              renders `border-0 border-b`, so the old class only recoloured a
              bottom hairline — and destructive at 20% over pure black is
              invisible, which made the override dead code. The one edge that
              actually exists now reads. */}
          <Tile eyebrow="Danger zone" i={12} className="border-b-destructive/40">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/60">
                <div>
                  <p className="text-sm font-medium">Delete all conversations</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete all your chat history.
                  </p>
                </div>
                <Button variant="destructive-outline" size="sm" onClick={() => setDeleteChatsOpen(true)} className="gap-2 shrink-0">
                  <ActionIcons.delete className="size-4" /> Delete all chats
                </Button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Delete account</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete your account, conversations, and memories.
                  </p>
                </div>
                {/* One entry point, one endpoint. This used to be a second,
                    weaker copy of the flow: a two-button dialog straight into
                    `DELETE /api/account`, which takes no confirmation at all, so
                    the account was gone in two clicks — while the Profile copy
                    made you type your email and posted to the guarded, rate-
                    limited `/api/account/delete`. The unguarded one was the one
                    styled as dangerous. It is now a link to the guarded one. */}
                <Button asChild variant="destructive-outline" size="sm" className="gap-2 shrink-0">
                  <Link href="/profile#account">
                    <ActionIcons.delete className="size-4" /> Delete account…
                  </Link>
                </Button>
              </div>
            </div>
          </Tile>
          </SettingsGroup>
        )}
        </div>
        </div>
      </div>

      <Dialog open={deleteChatsOpen} onOpenChange={setDeleteChatsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all conversations?</DialogTitle>
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

function SettingsPage() {
  return <SettingsContent />;
}

SettingsPage.Content = SettingsContent;

export default SettingsPage;
