"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  ArrowRight,
  NotebookPen,
  Check,
  ChevronDown,
  Copy,
  Globe,
  MessageSquareText,
  Monitor,
  Moon,
  PenLine,
  Search,
  Sun,
} from "lucide-react";
import { DotField } from "@/components/signature/dot-field";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApp } from "@/components/app/app-provider";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST } from "@/lib/providers";
import { PLAN_LIST } from "@/lib/plans";
import { cn } from "@/lib/utils";
import type { Plan } from "@prisma/client";
import type { ClientSettings } from "@/types/app";

const KEY = "juno:onboarded:v1";

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

const IMPORT_PROMPT =
  "Export all of my stored memories and any context you've learned about me from past conversations. " +
  "Preserve my words verbatim where possible, especially for instructions and preferences. " +
  "Return each as a short, standalone bullet point — one fact per line.";

/** Model picker for the welcome card. This used to be a hand-rolled dropdown with
 * a `fixed inset-0` click-catcher, because the old onboarding overlay was a bespoke
 * z-[60] layer that a z-50 popover could not escape. Now that the card is a real
 * Dialog the escape hatch is gone — and it had to go: DialogContent sets the
 * `translate` property, which makes it a containing block for `fixed` children, so
 * the catcher would have covered the panel rather than the page. */
function ModelField({
  models,
  valueId,
  onPick,
}: {
  models: ModelInfo[];
  valueId: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const current = models.find((m) => m.id === valueId);
  const ql = q.trim().toLowerCase();

  const groups = PROVIDER_LIST.map((p) => ({
    p,
    items: models.filter(
      (m) =>
        m.provider === p &&
        (!ql || m.name.toLowerCase().includes(ql) || (PROVIDERS[p]?.label ?? "").toLowerCase().includes(ql))
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* `hover:bg-secondary`, not `hover:bg-accent`. Everything on this card
            floats on --popover, and on the dark theme --accent IS --popover
            (both 48 5% 13%), so every accent hover inside a floating layer
            resolves to the panel's own colour and nothing happens. Nothing sits
            above a popover in the ladder, so a control on one answers by
            recessing a rung. */}
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-card border px-3.5 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-secondary"
        >
          <span className="flex min-w-0 items-center gap-2">
            {current && <ProviderLogo provider={current.provider} className="h-4 w-4 rounded-micro" />}
            <span className="truncate font-mono text-[13px]">{current?.name ?? "Select a model"}</span>
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft", open && "rotate-180")} />
        </button>
      </PopoverTrigger>

      {/* Opens upward — the field sits low in the card. 14px shell, the same menu
          radius the model picker uses everywhere else; the material and the
          pop-in/out pair come from PopoverContent. */}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-menu p-0"
      >
        <div className="relative border-b p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models…"
            autoFocus
            className="h-8 w-full bg-transparent pl-9 pr-2 text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1.5">
          {groups.length === 0 ? (
            <p className="px-2 py-8 text-center text-caption text-muted-foreground">No models found.</p>
          ) : (
            groups.map((g) => (
              <div key={g.p} className="mb-1.5 last:mb-0">
                <p className="px-2 pb-1 pt-1.5 font-mono text-caption uppercase text-muted-foreground">
                  {PROVIDERS[g.p]?.label ?? g.p}
                </p>
                {/* rounded-xs (6px) — the shell is rounded-menu (12px) and the
                    list insets it by p-1.5 (6px), which is the same sum every
                    other menu row in the product is drawn from. These were
                    rounded-field (10px), a radius wider than the 6px of panel
                    left beside them. */}
                {g.items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onPick(m.id);
                      setOpen(false);
                    }}
                    className="pressable flex w-full items-center gap-2 rounded-xs px-2.5 py-2 text-left hover:bg-secondary"
                  >
                    <ProviderLogo provider={m.provider} className="h-4 w-4 rounded-micro" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.name}</span>
                    {m.id === valueId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** First-run welcome. Self-gates: shows once, only for users with no history. */
export function Onboarding() {
  const { user, settings, setSettings, features, quota, conversations, models } = useApp();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [show, setShow] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const primaryRef = React.useRef<HTMLButtonElement>(null);

  // plan-checkout state (step 2)
  const [checkoutLoading, setCheckoutLoading] = React.useState<Plan | null>(null);

  // memory-import state (step 3)
  const [importText, setImportText] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [imported, setImported] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    try {
      // Already finished first-run — never reappear, even if the last chat is deleted.
      if (localStorage.getItem(KEY)) return;

      // Any existing history means they're past first-run. Persist so wiping the
      // conversation list later doesn't resurrect the welcome tour.
      if (conversations.length > 0) {
        localStorage.setItem(KEY, "1");
        return;
      }

      setShow(true);
    } catch {
      /* private mode / no storage — just skip onboarding */
    }
  }, [conversations.length]);

  // Let other first-run overlays (e.g. the announcement popup) stand down while
  // onboarding owns the screen, so nothing steals the "Next" button's clicks.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (show) {
      window.__junoOnboardingActive = true;
      window.dispatchEvent(new CustomEvent("juno:onboarding-start"));
    }
  }, [show]);

  const finish = React.useCallback(() => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
    if (typeof window !== "undefined") {
      window.__junoOnboardingActive = false;
      window.dispatchEvent(new CustomEvent("juno:onboarding-end"));
    }
  }, []);

  // No window keydown listener and no open-focus effect any more: Dialog supplies
  // Escape, the focus trap, the scroll lock, focus restoration to whatever was
  // focused before the card appeared, and a real exit animation. What Radix does
  // NOT cover is the step-to-step move, where the button that had focus unmounts —
  // so this narrows to `step` only, and the open case is handled by
  // onOpenAutoFocus below.
  React.useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  const save = (patch: Partial<ClientSettings>) => {
    setSettings(patch);
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  };
  const pickAccent = (id: string) => {
    document.documentElement.dataset.accent = id;
    save({ accent: id });
  };

  /**
   * The swatches, in the colours the app will actually use.
   *
   * ACCENTS stores only the LIGHT `:root[data-accent]` value, and the dark ramp
   * is materially different — juniper 31%→54%, teal 31.5%→49%, sage 42.5%→61%.
   * On the black theme the row was therefore advertising six muddy 31–46% discs
   * that no surface in the product ever renders, on the very step where the user
   * is also choosing Dark two fields below.
   *
   * Rather than duplicating the ramp into a second constant that can drift from
   * globals.css the way the first one already did, the real `--primary` is read
   * off the document: the attribute is swapped and restored inside ONE
   * synchronous layout effect, so no frame is ever painted with the wrong accent
   * applied. Re-runs on theme change because that is what the values depend on.
   */
  const [swatches, setSwatches] = React.useState<Record<string, string>>({});
  React.useLayoutEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    const previous = root.dataset.accent;
    const next: Record<string, string> = {};
    for (const a of ACCENTS) {
      root.dataset.accent = a.id;
      const value = getComputedStyle(root).getPropertyValue("--primary").trim();
      if (value) next[a.id] = `hsl(${value})`;
    }
    if (previous === undefined) delete root.dataset.accent;
    else root.dataset.accent = previous;
    setSwatches(next);
  }, [show, resolvedTheme]);

  const checkout = async (plan: Plan) => {
    setCheckoutLoading(plan);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        // leaving onboarding for Stripe — mark done so it doesn't reappear on return
        try {
          localStorage.setItem(KEY, "1");
        } catch {
          /* ignore */
        }
        window.location.href = data.url;
      } else throw new Error(data.error ?? "Could not start checkout.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Checkout failed.");
      setCheckoutLoading(null);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const runImport = async () => {
    const entries = importText
      .split(/\r?\n/)
      .map((s) => s.replace(/^[\s\-*••\d.)]+/, "").trim())
      .filter((s) => s.length > 2)
      .slice(0, 60);
    if (entries.length === 0) return;
    setImporting(true);
    const results = await Promise.allSettled(
      entries.map((content) =>
        fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: content.slice(0, 500) }),
        }).then((r) => {
          if (!r.ok) throw new Error("failed");
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    setImporting(false);
    setImported(ok);
    if (ok > 0) setImportText("");
  };

  // No early `return null` on !show: the Dialog has to stay mounted through the
  // close so the exit animation can run. Radix renders nothing while it is shut.
  const firstName = user.name?.split(" ")[0];
  const currentModelId = resolveModel(settings.defaultModel)?.id ?? settings.defaultModel;
  const labCount = new Set(models.map((m) => m.provider)).size;
  const activeTheme = theme ?? "system";

  const capabilities = [
    { icon: MessageSquareText, label: "Chat & code", desc: "Reason and build across the best models." },
    { icon: PenLine, label: "Live canvas", desc: "Docs and apps in a side-by-side artifact." },
    { icon: NotebookPen, label: "Remembers you", desc: "Context and preferences carry between chats." },
    features.webSearch
      ? { icon: Globe, label: "Web search", desc: "Answers grounded in live, cited sources." }
      : null,
  ].filter(Boolean) as { icon: typeof NotebookPen; label: string; desc: string }[];

  const currentPlan = quota.plan;
  // Default model must be a text/chat model — image & video models can't be defaults.
  const chatModels = models.filter((m) => (m.modality ?? "chat") === "chat");
  const STEP_LABELS = ["Welcome", "Make it yours", "Choose a plan", "Memory · optional"];

  return (
    // The first modal a new user ever meets used to dim by LIGHTENING
    // (bg-background/80) while every later modal dims by darkening, and it had no
    // focus trap, no scroll lock and no focus restore — it also vanished on a hard
    // cut. On the shared primitive it dims, traps, locks, restores and animates out
    // like the rest of the product, and `finish()` still runs on Escape and on a
    // backdrop click because both route through onOpenChange.
    <Dialog open={show} onOpenChange={(o) => { if (!o) finish(); }}>
      <DialogContent
        hideClose
        aria-label="Welcome to Juno"
        className="w-full max-w-[460px] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          primaryRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Welcome to Juno</DialogTitle>

        {/* The dot motif stays — it is the product signature; it just sits inside
            the panel now that there is no bespoke full-screen layer to paint on. */}
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <DotField spacing={26} />
        </div>

        {/* header: step label + dot pager */}
        <div className="relative flex items-center justify-between px-7 pt-6">
          <span className="font-mono text-label uppercase text-muted-foreground">
            {STEP_LABELS[step]}
          </span>
          <div className="flex items-center gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setStep(i)}
                aria-label={`Step ${i + 1}`}
                aria-current={step === i}
                // The two properties that actually change, named. `transition-all`
                // on an element whose WIDTH animates hands the browser every
                // inherited layout property as well, and it also ran the inactive
                // dots' hover fill at the 220ms travel rung instead of the 120ms
                // rung for a property changing under the pointer.
                className={cn(
                  "h-1.5 rounded-full transition-[width,background-color] duration-base ease-out-soft motion-reduce:transition-none",
                  step === i
                    ? "w-5 bg-primary"
                    : "w-1.5 bg-border transition-[width,background-color] duration-fast hover:bg-muted-foreground"
                )}
              />
            ))}
          </div>
        </div>

        {step === 0 && (
          <div key="intro" className="relative px-7 pb-7 pt-2 text-center motion-safe:animate-fade-in-up">
            <h2 className="mt-3 font-serif text-title font-medium leading-tight">
              Welcome to Juno
              {firstName ? (
                <>
                  , <span className="italic text-primary">{firstName}</span>
                </>
              ) : null}
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-body text-muted-foreground">
              A thoughtful AI for chat, code, and everything between.
            </p>
            {models.length > 1 && (
              <p className="mt-3 font-mono text-label uppercase text-muted-foreground/80">
                {models.length} models · {labCount} {labCount === 1 ? "lab" : "labs"} · one place
              </p>
            )}

            <div className="mt-6 space-y-1 text-left">
              {capabilities.map((c, i) => (
                <div
                  key={c.label}
                  // hover:bg-secondary at full strength: at /60 the fill landed
                  // ~1.4 points off the --popover card behind it, which is under
                  // the threshold where a fill is visible at all.
                  className="flex items-start gap-3 rounded-card p-2.5 transition-colors duration-fast ease-out-soft hover:bg-secondary motion-safe:animate-fade-in-up"
                  style={{ animationDelay: `${80 + i * 60}ms`, animationFillMode: "backwards" }}
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-field bg-secondary text-foreground">
                    <c.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  </div>
                  <div className="pt-0.5">
                    <p className="text-body font-medium leading-tight">{c.label}</p>
                    <p className="text-caption text-muted-foreground">{c.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <Button ref={primaryRef} onClick={() => setStep(1)} size="lg" className="mt-6 w-full">
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={finish}
              className="mt-2 text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 1 && (
          <div key="personalize" className="relative px-7 pb-7 pt-4 motion-safe:animate-fade-in-up">
            <h2 className="font-serif text-heading font-medium">Make Juno yours</h2>
            <p className="mt-1 text-caption text-muted-foreground">
              Tune the look and pick a default — change anything later in settings.
            </p>

            <div className="mt-5 space-y-5">
              <div>
                <p className="mb-2 font-mono text-label uppercase text-muted-foreground">Accent</p>
                <div className="flex gap-2.5">
                  {ACCENTS.map((a) => {
                    const color = swatches[a.id] ?? a.color;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => pickAccent(a.id)}
                        aria-label={a.id}
                        aria-pressed={settings.accent === a.id}
                        className={cn(
                          // ring-offset-popover: the gap a ring-offset leaves is
                          // filled with a SOLID named colour, and these swatches
                          // sit on a DialogContent (--popover), not on a card —
                          // so the selected accent wore a 6.5% disc of a surface
                          // that is nowhere near it on the dark theme.
                          "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-popover transition-transform duration-fast ease-out-soft hover:scale-110 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 coarse:h-11 coarse:w-11",
                          settings.accent === a.id && "ring-2 ring-foreground"
                        )}
                        style={{ backgroundColor: color }}
                      >
                        {/* Computed, not `text-white`. On the amber preset a white
                            tick measures 2.3:1 against its own swatch, so the only
                            confirmation that the accent took disappeared into it —
                            on the very screen where a new user is choosing one. */}
                        {settings.accent === a.id && (
                          <Check className="h-4 w-4" style={{ color: swatchInk(color) }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 font-mono text-label uppercase text-muted-foreground">Theme</p>
                <div className="grid grid-cols-3 gap-2">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTheme(t.id)}
                      aria-pressed={activeTheme === t.id}
                      className={cn(
                        "pressable flex flex-col items-center gap-1.5 rounded-card border px-2 py-3",
                        activeTheme === t.id
                          ? "border-primary/50 bg-primary/10 text-primary"
                          // hover:bg-secondary — see the model field above: on a
                          // popover, --accent resolves to the panel's own colour
                          // on dark, so the two unselected theme tiles answered
                          // the pointer with nothing.
                          : "text-muted-foreground hover:bg-secondary"
                      )}
                    >
                      <t.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                      <span className="font-mono text-caption uppercase">{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 font-mono text-label uppercase text-muted-foreground">Default model</p>
                <ModelField models={chatModels} valueId={currentModelId} onPick={(id) => save({ defaultModel: id })} />
              </div>
            </div>

            <Button ref={primaryRef} onClick={() => setStep(2)} size="lg" className="mt-7 w-full">
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={() => setStep(0)}
              className="mt-2 w-full text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
            >
              Back
            </button>
          </div>
        )}

        {step === 2 && (
          <div key="plan" className="relative px-7 pb-7 pt-4 motion-safe:animate-fade-in-up">
            <div className="flex items-center gap-2">
              <h2 className="font-serif text-heading font-medium">Choose a plan</h2>
              <span className="rounded-full border px-2 py-0.5 font-mono text-caption uppercase text-muted-foreground">
                Optional
              </span>
            </div>
            <p className="mt-1 text-caption text-muted-foreground">
              Start free — upgrade any time. Changes apply instantly.
            </p>

            <div className="mt-5 space-y-2.5">
              {PLAN_LIST.filter(
                // A tier with no configured Stripe price cannot be bought —
                // its checkout 503s — so it must not be offered here either.
                (plan) =>
                  plan.id === "FREE" ||
                  plan.id === currentPlan ||
                  features.purchasablePlans.includes(plan.id)
              ).map((plan) => {
                const isCurrent = plan.id === currentPlan;
                const popular = plan.id === "PRO";
                const msgs =
                  plan.id === "FREE"
                    ? "Browse & explore"
                    : plan.id === "MAX"
                      ? "All models · 5× Pro's tokens"
                      : plan.id === "MAX20"
                        ? "All models · highest token limit"
                        : "All models · token-based limit";
                return (
                  <div
                    key={plan.id}
                    className={cn(
                      "flex items-center gap-3 rounded-card border p-3.5 transition-colors duration-fast ease-out-soft",
                      popular ? "border-primary/50 bg-primary/10" : "border-border"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-serif text-body-lg font-medium leading-none">{plan.name}</h3>
                        {popular && (
                          <span className="rounded-full bg-primary px-2 py-0.5 font-mono text-caption uppercase text-primary-foreground">
                            Popular
                          </span>
                        )}
                        {isCurrent && (
                          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-caption uppercase text-muted-foreground">
                            Current
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-caption text-muted-foreground">{msgs}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <div className="font-serif text-heading font-medium leading-none">
                        {plan.price === 0 ? (
                          "Free"
                        ) : (
                          <>
                            ${plan.price}
                            <span className="font-mono text-caption text-muted-foreground">/mo</span>
                          </>
                        )}
                      </div>
                      {!isCurrent && plan.id !== "FREE" && (
                        <Button
                          size="sm"
                          variant={popular ? "default" : "outline"}
                          onClick={() => checkout(plan.id)}
                          disabled={!features.billing || checkoutLoading !== null}
                        >
                          {checkoutLoading === plan.id ? "Redirecting…" : "Upgrade"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {!features.billing && (
              <p className="mt-3 text-center text-caption text-muted-foreground/80">
                Billing isn’t set up on this deployment yet.
              </p>
            )}

            <Button
              ref={primaryRef}
              onClick={() => setStep(3)}
              size="lg"
              variant="outline"
              className="mt-6 w-full"
            >
              {currentPlan === "FREE" ? "Continue with Free" : "Continue"}
              <ArrowRight className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="mt-2 w-full text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
            >
              Back
            </button>
          </div>
        )}

        {step === 3 && (
          <div key="memory" className="relative px-7 pb-7 pt-4 motion-safe:animate-fade-in-up">
            <div className="flex items-center gap-2">
              <h2 className="font-serif text-heading font-medium">Bring your memory</h2>
              <span className="rounded-full border px-2 py-0.5 font-mono text-caption uppercase text-muted-foreground">
                Optional
              </span>
            </div>
            <p className="mt-1 text-caption text-muted-foreground">
              Already use another AI? Import what it knows about you so Juno starts warm.
            </p>

            <div className="mt-5 space-y-4">
              {/* step 1 — copy prompt */}
              <div>
                <p className="mb-1.5 flex items-center gap-2 font-mono text-label uppercase text-muted-foreground">
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-secondary text-caption font-semibold text-foreground">
                    1
                  </span>
                  Copy this into your other AI
                </p>
                {/* bg-secondary whole: at /40 the prompt well composited to
                    ~11.6% inside a 13% dialog, so the block the user is being
                    asked to copy out of had no edge but its border. */}
                <div className="relative rounded-card border bg-secondary p-3">
                  <p className="pr-8 text-caption leading-relaxed text-muted-foreground">{IMPORT_PROMPT}</p>
                  <button
                    type="button"
                    onClick={copyPrompt}
                    aria-label="Copy prompt"
                    // bg-accent, not bg-card. The copy button sits on the well
                    // above, which sits on a --popover dialog; --card is 6.5% on
                    // dark, i.e. six points BELOW its own panel, so the control
                    // read as a hole punched in the block rather than a button
                    // resting on it. --accent is level with the dialog and so
                    // lifts clear of the recessed well underneath it.
                    className="pressable absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-control border bg-accent text-muted-foreground hover:text-foreground coarse:h-9 coarse:w-9"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {/* step 2 — paste results */}
              <div>
                <p className="mb-1.5 flex items-center gap-2 font-mono text-label uppercase text-muted-foreground">
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-secondary text-caption font-semibold text-foreground">
                    2
                  </span>
                  Paste the results here
                </p>
                <textarea
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    setImported(null);
                  }}
                  rows={4}
                  placeholder={"- Prefers concise answers\n- Building a chatbot called Juno\n- Based in France"}
                  // No `outline-none`. This is one of four tab stops on the step
                  // and the only one that had switched the global
                  // `:focus-visible` outline off, leaving a keyboard user with a
                  // hairline border tint as the sole indication of where they
                  // were — on the field the step exists to fill in.
                  className="w-full resize-none rounded-card border bg-transparent p-3 text-[13px] leading-relaxed transition-colors duration-fast ease-out-soft placeholder:text-muted-foreground focus:border-primary/50"
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-caption text-muted-foreground">
                    {imported !== null ? (
                      <span className="flex items-center gap-1.5 text-primary">
                        <Check className="h-3.5 w-3.5" /> Added {imported} {imported === 1 ? "memory" : "memories"}
                      </span>
                    ) : (
                      "One fact per line."
                    )}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={runImport}
                    disabled={importing || importText.trim().length < 3}
                  >
                    <NotebookPen className="h-3.5 w-3.5" />
                    {importing ? "Adding…" : "Add to memory"}
                  </Button>
                </div>
              </div>
            </div>

            <Button ref={primaryRef} onClick={finish} size="lg" className="mt-6 w-full">
              Start chatting
            </Button>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="mt-2 w-full text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
            >
              Back
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
