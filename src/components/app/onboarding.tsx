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
  Sparkles,
  Sun,
} from "lucide-react";
import { DotField } from "@/components/signature/dot-field";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { ACCENTS } from "@/lib/accents";
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

/** Inline, self-contained model picker — lives inside the card (the composer's
 * popover selector is z-50 and would hide behind this z-[60] overlay). */
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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-2xl border px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          {current && <ProviderLogo provider={current.provider} className="h-4 w-4 rounded" />}
          <span className="truncate font-mono text-[13px]">{current?.name ?? "Select a model"}</span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft", open && "rotate-180")} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          {/* opens upward — the field sits low in the card, which clips overflow */}
          <div className="absolute bottom-full left-0 right-0 z-30 mb-2 origin-bottom overflow-hidden rounded-2xl border bg-popover/95 shadow-glass backdrop-blur-md motion-safe:animate-pop-in">
            <div className="relative border-b p-2">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search models…"
                autoFocus
                className="h-8 w-full rounded-md bg-transparent pl-9 pr-2 text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-56 overflow-y-auto p-1.5">
              {groups.length === 0 ? (
                <p className="px-2 py-8 text-center text-caption text-muted-foreground">No models found.</p>
              ) : (
                groups.map((g) => (
                  <div key={g.p} className="mb-1.5 last:mb-0">
                    <p className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {PROVIDERS[g.p]?.label ?? g.p}
                    </p>
                    {g.items.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onPick(m.id);
                          setOpen(false);
                        }}
                        className="pressable flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-accent"
                      >
                        <ProviderLogo provider={m.provider} className="h-4 w-4 rounded" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.name}</span>
                        {m.id === valueId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** First-run welcome. Self-gates: shows once, only for users with no history. */
export function Onboarding() {
  const { user, settings, setSettings, features, quota, conversations, models } = useApp();
  const { theme, setTheme } = useTheme();
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

  React.useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, finish]);

  React.useEffect(() => {
    if (show) primaryRef.current?.focus();
  }, [show, step]);

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

  if (!show) return null;

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Juno"
      className="fixed inset-0 z-[60] grid place-items-center overflow-hidden bg-background/80 p-4 backdrop-blur-md motion-safe:animate-fade-in"
    >
      <div className="pointer-events-none absolute inset-0 -z-0 opacity-70">
        <DotField spacing={26} />
      </div>

      <div className="relative w-full max-w-[460px] overflow-hidden rounded-panel border bg-card/95 shadow-glass backdrop-blur-xl motion-safe:animate-rise-in">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-52 w-52 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />

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
                className={cn(
                  "h-1.5 rounded-full transition-all duration-base ease-out-soft",
                  step === i ? "w-5 bg-primary" : "w-1.5 bg-border hover:bg-muted-foreground/50"
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
                  className="flex items-start gap-3 rounded-2xl p-2.5 transition-colors duration-fast hover:bg-secondary/60 motion-safe:animate-fade-in-up"
                  style={{ animationDelay: `${80 + i * 60}ms`, animationFillMode: "backwards" }}
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary text-foreground">
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
                  {ACCENTS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => pickAccent(a.id)}
                      aria-label={a.id}
                      aria-pressed={settings.accent === a.id}
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-fast ease-out-soft hover:scale-110 active:scale-95 coarse:h-11 coarse:w-11",
                        settings.accent === a.id && "ring-2 ring-foreground"
                      )}
                      style={{ backgroundColor: a.color }}
                    >
                      {settings.accent === a.id && <Check className="h-4 w-4 text-white" />}
                    </button>
                  ))}
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
                        "pressable flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3",
                        activeTheme === t.id
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent"
                      )}
                    >
                      <t.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                      <span className="font-mono text-[11px] uppercase tracking-wide">{t.label}</span>
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
              <span className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Optional
              </span>
            </div>
            <p className="mt-1 text-caption text-muted-foreground">
              Start free — upgrade any time. Changes apply instantly.
            </p>

            <div className="mt-5 space-y-2.5">
              {PLAN_LIST.map((plan) => {
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
                      "flex items-center gap-3 rounded-2xl border p-3.5 transition-colors",
                      popular ? "border-primary/50 bg-primary/[0.04]" : "border-border"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-serif text-body-lg font-medium leading-none">{plan.name}</h3>
                        {popular && (
                          <span className="rounded-full bg-primary px-2 py-0.5 font-mono text-[10px] uppercase text-primary-foreground">
                            Popular
                          </span>
                        )}
                        {isCurrent && (
                          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
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
              <span className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
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
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">
                    1
                  </span>
                  Copy this into your other AI
                </p>
                <div className="relative rounded-2xl border bg-secondary/40 p-3">
                  <p className="pr-8 text-caption leading-relaxed text-muted-foreground">{IMPORT_PROMPT}</p>
                  <button
                    type="button"
                    onClick={copyPrompt}
                    aria-label="Copy prompt"
                    className="pressable absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg border bg-card text-muted-foreground hover:text-foreground coarse:h-9 coarse:w-9"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {/* step 2 — paste results */}
              <div>
                <p className="mb-1.5 flex items-center gap-2 font-mono text-label uppercase text-muted-foreground">
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">
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
                  className="w-full resize-none rounded-2xl border bg-transparent p-3 text-[13px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50"
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
                    <Sparkles className="h-3.5 w-3.5" />
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
      </div>
    </div>
  );
}
