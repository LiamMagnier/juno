"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Brain, Check, ChevronDown, Clock, Eye, Globe, Image as ImageIcon, LayoutGrid, Lock, MessageSquare, Search, TriangleAlert, Video, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { PLANS, planRank, effectiveMinPlan } from "@/lib/plans";
import { useApp } from "@/components/app/app-provider";
import {
  applyReasoning,
  contextScore,
  expensivenessScore,
  formatContext,
  formatPrice,
  getModelMetrics,
  hasLiveBenchmark,
  reasoningOptions,
  sortModelsForDisplay,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { providerAccent } from "@/lib/provider-colors";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

type Filter = "all" | Provider;

type MetricKey = "intelligence" | "speed" | "context" | "cost";

function metricScore(model: ModelInfo, key: MetricKey, effort: ReasoningEffort) {
  const metrics = applyReasoning(getModelMetrics(model), effort, model.reasoning);
  switch (key) {
    case "intelligence":
      return metrics.intelligence;
    case "speed":
      return metrics.speed;
    case "context":
      return contextScore(metrics.contextTokens);
    case "cost":
      return expensivenessScore(metrics);
  }
}

function MetricBars({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    // role="meter", not a decorated div: the ten segments are the whole story
    // for a sighted reader and nothing at all for a screen reader — this hands
    // AT the same value/scale the segments draw, on the element that draws it.
    <div role="meter" aria-label={label} aria-valuemin={1} aria-valuemax={10} aria-valuenow={value}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-micro uppercase text-muted-foreground">{label}</span>
        <span className="font-mono text-micro tabular-nums text-muted-foreground/70">{value}/10</span>
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className="h-4 w-2 rounded-full bg-muted ring-1 ring-inset ring-foreground/10 transition-colors duration-base ease-out-soft"
            style={i < value ? { backgroundColor: accent } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityChip({ icon: Icon, label }: { icon: typeof Brain; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// Tiny row-sized variant of CapabilityChip — must not blow up card height.
function RowChip({ icon: Icon, label, tint, warn, title }: { icon: typeof Brain; label: string; tint?: boolean; warn?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border bg-background/60 px-1.5 py-px text-micro font-medium",
        warn ? "border-warning/50 text-warning" : tint ? "border-source/40 text-source" : "border-border/70 text-muted-foreground"
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      {label}
    </span>
  );
}

// Derived capability: quick models get a "Fast" chip (same bar data as the panel).
function isFastModel(m: ModelInfo) {
  return getModelMetrics(m).speed >= 8;
}

/**
 * The plain-outcome line under a model's name — what this one is FOR, in the
 * words a person choosing between 130 models is actually asking in. Derived
 * from the same metric tables the detail bars read, never a new registry
 * field; the buckets are deliberately coarse because a row needs one
 * glanceable clause, and the exact grades stay in the panel. It replaces the
 * lab name that used to sit here, which the logo and the lab eyebrow above
 * each group already said twice.
 */
function outcomeDescriptor(m: ModelInfo): string {
  if (m.modality === "image") return "Generates images";
  if (m.modality === "video") return "Generates video";
  const { intelligence, speed } = getModelMetrics(m);
  // Speed 5 is the frontier's own median (Sonnet 5, GPT-5.6 Sol) — only the
  // genuinely slow flagships (Fable, Opus, the Pro reasoners) earn the wait.
  if (intelligence >= 9) return speed >= 5 ? "Top-tier for complex work" : "Deepest reasoning — worth the wait";
  if (intelligence >= 7) return speed >= 8 ? "Fast and capable — an everyday pick" : "Strong all-rounder for everyday work";
  if (speed >= 8) return "Quick replies for simple tasks";
  return "For lighter, simpler tasks";
}

/** "2026-10-23" → "23 Oct 2026". Formatted from the parts, not through `Date`:
 *  the string is a calendar day, and parsing it would shift it by a timezone. */
function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

/** "in 16 days" / "tomorrow" — only once it is close enough to matter. A date
 *  four months out is information; a date next week is a decision. */
function retirementCountdown(iso: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0 || days > 30) return null;
  if (days === 0) return "last day";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function ModelDetailPanel({
  model,
  reasoningEffort,
  onCommit,
}: {
  model: ModelInfo | null;
  reasoningEffort: ReasoningEffort;
  // Clicking a thinking pill commits: select THIS model + apply the effort + close.
  onCommit?: (effort: ReasoningEffort) => void;
}) {
  // null = not previewing; { effort } = previewing that effort (Instant is effort=null).
  const [preview, setPreview] = React.useState<{ effort: ReasoningEffort } | null>(null);

  React.useEffect(() => {
    setPreview(null);
  }, [model?.id]);

  if (!model) {
    return (
      <div className="flex w-full shrink-0 snap-start items-center border-l bg-card/80 p-5 md:w-60">
        <p className="text-sm text-muted-foreground">Hover a model to compare intelligence, speed, context, and cost.</p>
      </div>
    );
  }

  if (isAutoModelId(model.id)) {
    return (
      <div className="flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l bg-card/85 p-5 shadow-soft backdrop-blur-xl md:w-60">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-heading">Auto</h3>
          <JunoMark className="size-7 shrink-0 rounded-field" />
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Routes each message to the <span className="font-medium text-foreground">cheapest model</span> and{" "}
          <span className="font-medium text-foreground">thinking depth</span> that can handle it — based on length, code, multi-step work, and how hard the ask looks.
        </p>
        <ul className="mt-4 space-y-2 text-ui leading-snug text-muted-foreground">
          <li className="flex gap-2"><span className="font-mono text-primary">1</span> Short / simple → budget models · Instant</li>
          <li className="flex gap-2"><span className="font-mono text-primary">2</span> Coding & analysis → mid tier · light thinking</li>
          <li className="flex gap-2"><span className="font-mono text-primary">3</span> Hard reasoning → flagship · deep thinking</li>
        </ul>
        <p className="mt-4 text-caption leading-snug text-muted-foreground/80">
          Respects your plan, vision needs (images), and web search. Model and thinking for each answer still show on the receipt.
        </p>
      </div>
    );
  }

  const accent = providerAccent(model.provider);
  const effectiveEffort: ReasoningEffort = preview ? preview.effort : reasoningEffort;
  const metrics = applyReasoning(getModelMetrics(model), effectiveEffort, model.reasoning);
  // Only the thinking modes this model actually supports (real per-model data).
  const options = reasoningOptions(model);
  const free = metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0;

  const bars: { label: string; key: MetricKey }[] = [
    { label: "Intelligence", key: "intelligence" },
    { label: "Speed", key: "speed" },
    { label: "Context", key: "context" },
    { label: "Cost", key: "cost" },
  ];

  return (
    <div className="flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l bg-card/85 shadow-soft backdrop-blur-xl md:w-60">
      {/* Keyed per model: hovering the list cross-fades the spec sheet in place (fixed width, no layout jump). */}
      <div key={model.id} className="flex min-h-full flex-col animate-fade-in-up [animation-fill-mode:backwards]">
        <div className="space-y-4 p-5">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-heading">{model.name}</h3>
              <ProviderLogo provider={model.provider} className="mt-0.5 h-6 w-6 shrink-0" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>{PROVIDERS[model.provider].label.split(" · ")[0]}</span>
              <span aria-hidden>·</span>
              <span className="font-mono">{formatContext(metrics.contextTokens)} context</span>
              {model.status === "legacy" && (
                <span className="rounded-full border border-border/70 px-1.5 py-px font-mono text-micro text-muted-foreground/80">
                  Legacy
                </span>
              )}
            </div>
          </div>

          {model.status === "deprecated" && (
            <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-caption font-medium leading-snug text-warning">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {model.retiresOn ? (
                  <>
                    <span className="font-semibold">Available until {formatRetirementDate(model.retiresOn)}</span>
                    {retirementCountdown(model.retiresOn) ? <> · {retirementCountdown(model.retiresOn)}</> : null}
                    {model.deprecationNote?.replace(/^Retires [^—]*— /, "") ? (
                      <> · {model.deprecationNote.replace(/^Retires [^—]*— /, "")}</>
                    ) : null}
                  </>
                ) : (
                  (model.deprecationNote ?? "Retiring — deprecated by the provider.")
                )}
              </span>
            </div>
          )}

          <p className="text-sm leading-6 text-muted-foreground">
            {model.description ?? "A capable model in your configured providers."}
          </p>

          {(model.vision || model.reasoning || model.webSearch || isFastModel(model)) && (
            <div className="flex flex-wrap gap-1.5">
              {model.vision && <CapabilityChip icon={Eye} label="Vision" />}
              {model.reasoning && <CapabilityChip icon={Brain} label="Reasoning" />}
              {model.webSearch && <CapabilityChip icon={Globe} label="Web search" />}
              {isFastModel(model) && <CapabilityChip icon={Zap} label="Fast" />}
            </div>
          )}

          <div className="space-y-2.5">
            {bars.map((b) => (
              <MetricBars key={b.key} label={b.label} value={metricScore(model, b.key, effectiveEffort)} accent={accent} />
            ))}
            {/* Attribution required by the Artificial Analysis API terms. */}
            {hasLiveBenchmark(model) && (
              <p className="font-mono text-micro text-muted-foreground">
                Scores by{" "}
                <a href="https://artificialanalysis.ai" target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground">
                  Artificial Analysis
                </a>
              </p>
            )}
          </div>

          {/* Pricing — tracks the thinking preview like the bars (reasoning burns output tokens). */}
          <div className="border-t border-dashed border-border/60 pt-3">
            <div className="mb-1 font-mono text-micro uppercase text-muted-foreground">Pricing</div>
            {free ? (
              <p className="text-sm font-semibold">Free</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-1 text-sm tabular-nums">
                <span className="font-semibold">{formatPrice(metrics.inputUsdPerMTok)}</span>
                <span className="text-caption text-muted-foreground">in</span>
                <span className="text-muted-foreground/50" aria-hidden>
                  ·
                </span>
                <span className="font-semibold">{formatPrice(metrics.outputUsdPerMTok)}</span>
                <span className="text-caption text-muted-foreground">out</span>
                <span className="text-caption text-muted-foreground">/ MTok</span>
              </p>
            )}
          </div>
        </div>

        {/* Thinking — the same slider as the composer; dragging previews the
            metrics live and commits without closing the picker.

            This panel carried a `showReasoning` prop for a while, so that Juno
            Work could hide the slider on a surface whose executor had nowhere
            to put an effort. Both ends exist now — `ProviderRequest.reasoningEffort`
            reaches every adapter and `WorkSessionOptions` carries it — so every
            caller wanted it shown, and a switch with one setting is a switch
            somebody has to read before discovering it does nothing. */}
        <div className="mt-auto border-t p-5 pt-4">
          {options.length > 1 ? (
            <ReasoningSlider
              options={options}
              value={effectiveEffort}
              onChange={(v) => {
                setPreview({ effort: v });
                onCommit?.(v);
              }}
            />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="font-mono text-micro uppercase text-muted-foreground">Thinking</span>
                <span className="font-mono text-micro text-muted-foreground/80">
                  {model.reasoning ? "Always on" : "Instant"}
                </span>
              </div>
              <p className="mt-2 text-caption leading-snug text-muted-foreground">
                {model.reasoning ? "This model always reasons — no effort control." : "This model replies instantly."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RailButton({
  active,
  dimmed,
  title,
  onClick,
  children,
}: {
  active: boolean;
  dimmed?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // Hover is a fill, never a scale: fourteen of these sit in one column,
        // and a rail whose icons grow under the pointer reads as jitter, not
        // affordance. The press keeps its scale — that one is feedback.
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-field transition-[transform,background-color,box-shadow,opacity] duration-fast ease-out-soft active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100",
        active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-accent",
        dimmed && "opacity-30 active:scale-100"
      )}
    >
      {children}
    </button>
  );
}

export function ModelSelector({
  value,
  onChange,
  reasoningEffort = null,
  onReasoningChange,
  // Destructured under a second name because `filter` is already this
  // component's provider-rail state. The prop keeps the plain name — callers
  // are asking to filter models, not to filter something called a model filter.
  filter: modelFilter,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /**
   * Narrows the catalog to the models this surface's runtime can actually drive.
   *
   * Juno Work is the case it was added for. A Work run is an agent loop against
   * `/chat/completions` or `/v1/messages`, so the image models, the video
   * models, the entries that are listed but not yet callable and OpenAI's
   * Responses-only models are not a poor choice there — the runner cannot call
   * them at all, and offering one produces a task that dies before its first
   * token. `isWorkCapableModel` (src/lib/work/models.ts) draws that line once;
   * this prop is how the picker is told about it, rather than by growing a
   * second copy of this component with two of its panes missing.
   *
   * It is not a permissions mechanism and must not be used as one. A model the
   * reader is entitled to and would go looking for — a plan-locked flagship, a
   * lab they hold a key for — stays in the list wearing its lock and sending
   * them to /upgrade, because a row that is simply absent answers "where is
   * Opus?" with nothing at all. Hide a model only when choosing it could not
   * have worked.
   */
  filter?: (model: ModelInfo) => boolean;
}) {
  const router = useRouter();
  const { quota, features, models } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const current = isAutoModelId(value)
    ? AUTO_MODEL_INFO
    : models.find((m) => m.id === value) ?? resolveModel(value);
  const q = query.trim().toLowerCase();
  const autoSelected = isAutoModelId(value);

  const providerFilter = filter !== "all" ? (filter as Provider) : null;
  const filterConfigured = providerFilter ? features.providers.includes(providerFilter) : true;

  // Sort [lab asc, intelligence desc, released desc, name asc] to match the
  // /api/models payload order (the Mac app trusts that order verbatim), so the
  // web selector looks identical even before the API response lands.
  const visible: ModelInfo[] = sortModelsForDisplay(
    models
      .filter((m) => (modelFilter ? modelFilter(m) : true))
      .filter((m) => (providerFilter ? m.provider === providerFilter : true))
      .filter(
        (m) =>
          !q ||
          m.name.toLowerCase().includes(q) ||
          m.providerModel.toLowerCase().includes(q) ||
          (m.family ?? "").toLowerCase().includes(q) ||
          m.modality.includes(q) ||
          (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q)
      )
  );
  // Auto is a real `ModelInfo` and is put through the same test as the rest: a
  // surface that cannot drive every model cannot promise "whichever is best"
  // either, and an Auto row left standing above a filtered list would be the
  // one row in the picker whose outcome nobody had checked.
  const showAutoRow =
    filter === "all" &&
    (modelFilter ? modelFilter(AUTO_MODEL_INFO) : true) &&
    (!q || "auto".includes(q) || "cheap".includes(q) || "route".includes(q) || "smart".includes(q) || "default".includes(q));
  const hoveredModel = React.useMemo(() => {
    if (hoveredId === AUTO_MODEL_ID || (!hoveredId && autoSelected)) return AUTO_MODEL_INFO;
    return visible.find((m) => m.id === hoveredId) ?? visible.find((m) => m.id === value) ?? current ?? visible[0] ?? null;
  }, [autoSelected, current, hoveredId, value, visible]);

  const select = (m: ModelInfo) => {
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      setOpen(false);
      return;
    }
    if (m.comingSoon) return; // not callable yet — no live API
    if (planRank(plan) < planRank(effectiveMinPlan(m.minPlan))) {
      setOpen(false);
      router.push("/upgrade");
      return;
    }
    onChange(m.id);
    setOpen(false);
  };

  // Group the visible models by modality so image/video sit in their own sections.
  const MODALITY_GROUPS: { key: "chat" | "image" | "video"; label: string; icon: typeof Brain }[] = [
    { key: "chat", label: "Chat", icon: MessageSquare },
    { key: "image", label: "Image", icon: ImageIcon },
    { key: "video", label: "Video", icon: Video },
  ];

  const renderRow = (m: ModelInfo, i: number) => {
    const soon = !!m.comingSoon;
    const locked = !soon && planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
    const active = value === m.id;
    return (
      <div
        key={m.id}
        style={staggerDelay(i, "tight")}
        onMouseEnter={() => setHoveredId(m.id)}
        onFocus={() => setHoveredId(m.id)}
        className={cn(
          // Hover is a fill, not a lift: a grid of cards that each rise and
          // cast shadow under the pointer turns browsing 130 models into a
          // ripple. The border tint + accent wash carry the state; transform
          // stays in the list only for the press.
          "group relative flex flex-col justify-between rounded-control border p-3 transition-[transform,background-color,border-color,box-shadow] duration-base ease-out-soft motion-safe:animate-rise-in [animation-fill-mode:backwards] motion-reduce:transition-none",
          soon
            ? "border-border/60 bg-card/40 opacity-60"
            : "active:scale-[0.99] " + (active
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border/70 bg-card/65 hover:border-primary/30 hover:bg-accent/50 focus-within:border-primary/40 focus-within:bg-accent/50")
        )}
      >
        <button
          type="button"
          onClick={() => select(m)}
          aria-current={active ? "true" : undefined}
          className="flex h-full w-full min-w-0 flex-col items-start gap-2 rounded-control text-left"
        >
          {/* Logo & Name Row */}
          <div className="flex items-center gap-2.5 w-full pr-6">
            <ProviderLogo provider={m.provider} className="h-6 w-6" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold tracking-tight">{m.name}</span>
              {/* Outcome, not lab: the logo and the group eyebrow already name
                  the lab, so this line answers the question they can't. */}
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{outcomeDescriptor(m)}</span>
            </div>
          </div>

          {/* Description — the rung's own 1.45 leading, no leading-relaxed:
              two relaxed lines run 35.8px against this fixed h-8 box and the
              clamp was shaving the second line's descenders. 2 × 11px × 1.45
              = 31.9px fits exactly. */}
          {m.description && (
            <p className="line-clamp-2 h-8 w-full text-caption text-muted-foreground/90 md:hidden">
              {m.description}
            </p>
          )}

          {/* Bottom attributes */}
          <div className="flex items-center justify-between gap-2 w-full mt-auto pt-1 border-t border-dashed border-border/40">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {m.status === "deprecated" && (
                <RowChip
                  icon={TriangleAlert}
                  label={m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
                  warn
                  title={m.deprecationNote ?? "Deprecated by the provider"}
                />
              )}
              {m.modality === "image" && <RowChip icon={ImageIcon} label="Image" tint />}
              {m.modality === "video" && <RowChip icon={Video} label="Video" tint />}
              {m.reasoning && <RowChip icon={Brain} label="Reasoning" />}
              {m.vision && <RowChip icon={Eye} label="Vision" />}
              {m.webSearch && <RowChip icon={Globe} label="Search" />}
              {isFastModel(m) && <RowChip icon={Zap} label="Fast" />}
              <span className="font-mono text-micro font-semibold text-muted-foreground">
                {"$".repeat(m.cost)}
              </span>
            </div>
            {soon ? (
              // The only raw palette class in the chat surface — no retheme could
              // reach it, and its two sibling states in this same ternary are
              // already tokenised. `warning-foreground` rather than `warning`:
              // the fill ramp fails AA at caption size.
              <span className="flex shrink-0 items-center gap-1 text-caption font-semibold text-warning-foreground">
                <Clock className="h-3 w-3" /> Soon
              </span>
            ) : locked ? (
              <span className="flex shrink-0 items-center gap-1 text-caption font-semibold text-primary">
                <Lock className="h-3 w-3" /> {PLANS[effectiveMinPlan(m.minPlan)].name}
              </span>
            ) : active ? (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            ) : null}
          </div>
        </button>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${current?.name ?? "Select model"}`}
          // rounded-composer-control (11), not rounded-control (10): this trigger
          // sits inline with the composer's + and mic buttons, which use the rung
          // that exists for exactly that row. One radius across the satellites;
          // composer-action stays reserved for the primary send.
          /*
           * `.composer-chip` (globals.css) carries the fill, hairline, hover,
           * open and press states — shared with the thinking-effort trigger
           * beside it, because the two are the same kind of control and were
           * drifting apart one hand-written state at a time.
           *
           * Text is full strength, not `foreground/80`. The model in play is the
           * single most consequential thing on this row — it decides what the
           * answer costs and how good it is — and it was the dimmest text in the
           * composer, quieter than the placeholder above it.
           *
           * No focus override here, deliberately. This is a bare <button>, so
           * the global `:focus-visible` rule in globals.css already reaches it
           * and is authoritative. An earlier pass through this line added
           * `focus-visible:outline-none` plus a ring — which SUPPRESSES that
           * rule and repaints the 2px gap in a solid `ring-offset-card`, a
           * colour that belongs to no surface once the composer sits on
           * anything else. button.tsx:7 documents why four hand-forked offset
           * colours accumulated the last time that pattern spread; outline-offset
           * leaves the real surface showing and is correct by construction.
           */
          className="composer-chip group inline-flex h-8 w-full min-w-0 max-w-[12rem] items-center gap-1 rounded-composer-control px-2 text-ui font-medium text-foreground max-[359px]:w-auto max-[359px]:px-2 sm:w-auto sm:max-w-[16rem] sm:gap-1.5 sm:px-2.5 coarse:h-11"
        >
          {autoSelected ? (
            <JunoMark className="size-3.5 shrink-0 rounded-sm transition-transform duration-base ease-out-soft group-hover:scale-110 sm:size-4" />
          ) : current ? (
            <ProviderLogo provider={current.provider} className="size-3.5 shrink-0 rounded-sm transition-transform duration-base ease-out-soft group-hover:scale-110 sm:size-4" />
          ) : null}
          <span
            key={current?.id ?? "no-model"}
            aria-hidden="true"
            className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono [mask-image:linear-gradient(to_right,#000_calc(100%_-_10px),transparent)] motion-safe:animate-fade-in max-[359px]:hidden sm:flex-none sm:[mask-image:none]"
          >
            {current?.name ?? "Select model"}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180 sm:size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        style={{ maxHeight: "min(26rem, var(--radix-popover-content-available-height))" }}
        className="flex w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0 sm:w-[36rem] sm:max-w-[90vw] md:w-[42rem] md:max-w-[88vw]"
      >
        {features.billing && plan !== "MAX" && plan !== "OWNER" && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/upgrade");
            }}
            className="flex w-full shrink-0 items-center justify-between border-b bg-primary/5 px-4 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-primary/10"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-primary" /> Unlock every model
            </span>
            <span className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">Upgrade</span>
          </button>
        )}

        <div className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto md:snap-none md:overflow-x-visible">
          {/* Pane 1: rail + list — one full-width swipe page on mobile, side panes on desktop. */}
          <div className="flex w-full shrink-0 snap-start md:w-auto md:flex-1 md:shrink">
          {/* Rail */}
          <div className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-card py-3">
            <RailButton active={filter === "all"} title="All models" onClick={() => setFilter("all")}>
              <LayoutGrid className={cn("h-5 w-5", filter === "all" ? "text-primary" : "text-muted-foreground")} />
            </RailButton>
            <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
            {PROVIDER_LIST.map((p) => (
              <RailButton key={p} active={filter === p} dimmed={!features.providers.includes(p)} title={PROVIDERS[p].label} onClick={() => setFilter(p)}>
                <ProviderLogo provider={p} className="h-6 w-6" />
              </RailButton>
            ))}
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative border-b p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="h-8 rounded-control pl-8 focus-visible:ring-1 focus-visible:ring-ring/30"
                autoFocus
              />
            </div>
            <ScrollFade className="min-h-0 flex-1" viewportClassName="p-2">
              {providerFilter && !filterConfigured ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <ProviderLogo provider={providerFilter} className="h-8 w-8" />
                  <p className="text-sm font-medium">{PROVIDERS[providerFilter].label}</p>
                  <p className="text-xs text-muted-foreground">
                    Add <span className="font-mono">{PROVIDERS[providerFilter].apiKeyEnv}</span> to enable these models.
                  </p>
                </div>
              ) : visible.length === 0 && !showAutoRow ? (
                <p className="px-2 py-10 text-center text-sm text-muted-foreground">No models found.</p>
              ) : (
                <>
                  {/* Auto leads the whole catalog, outside any group: it is the
                      answer for everyone who did not open this picker to
                      compare labs, and filing the default under "Chat › lab"
                      made it one card among 130. The primary wash (and nothing
                      louder) is what marks it apart from the neutral cards
                      below without shouting over the selected state. */}
                  {showAutoRow && (
                    <div
                      onMouseEnter={() => setHoveredId(AUTO_MODEL_ID)}
                      onFocus={() => setHoveredId(AUTO_MODEL_ID)}
                      className={cn(
                        "group relative mb-3 flex flex-col justify-between rounded-control border p-3 transition-[transform,background-color,border-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none",
                        "active:scale-[0.99] " +
                          (autoSelected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-primary/25 bg-primary/[0.04] hover:border-primary/40 hover:bg-primary/[0.08] focus-within:border-primary/40 focus-within:bg-primary/[0.08]")
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => select(AUTO_MODEL_INFO)}
                        aria-current={autoSelected ? "true" : undefined}
                        className="flex w-full items-start gap-2.5 text-left"
                      >
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-field bg-muted/80 ring-1 ring-border/60">
                          <JunoMark className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">Auto</span>
                            <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-micro font-semibold text-primary">
                              Default
                            </span>
                          </span>
                          {/* The registry's own sentence, not a paraphrase —
                              one copy of the routing promise to keep true. */}
                          <span className="mt-0.5 line-clamp-2 text-caption leading-snug text-muted-foreground">
                            {AUTO_MODEL_INFO.description}
                          </span>
                        </span>
                        {autoSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                      </button>
                    </div>
                  )}

                  {MODALITY_GROUPS.map((g) => {
                    const items = visible.filter((m) => (m.modality ?? "chat") === g.key);
                    if (items.length === 0) return null;

                    const standardItems = items.filter((m) => !m.legacy);
                    const legacyItems = items.filter((m) => m.legacy);

                    // Consecutive runs by lab — the sort is lab-major, so one
                    // pass suffices. The eyebrows these produce are what makes
                    // a 130-model list scannable: the eye finds the lab first,
                    // then reads two or three names, instead of matching tiny
                    // logos card by card. `start` carries the stagger index
                    // across runs so the entrance stays one cascade.
                    const labRuns: { provider: Provider; start: number; items: ModelInfo[] }[] = [];
                    for (const m of standardItems) {
                      const run = labRuns[labRuns.length - 1];
                      if (run && run.provider === m.provider) run.items.push(m);
                      else labRuns.push({ provider: m.provider, start: labRuns.reduce((n, r) => n + r.items.length, 0), items: [m] });
                    }

                    return (
                      <div key={g.key} className="mb-4">
                        <div className="flex items-center gap-1.5 px-3 pb-2 pt-1">
                          <g.icon className="h-3.5 w-3.5 text-muted-foreground/75" />
                          <span className="font-mono text-label uppercase text-muted-foreground/80">{g.label}</span>
                        </div>

                        {labRuns.map((run) => (
                          <div key={`${g.key}-${run.provider}-${run.start}`} className="mb-2.5 last:mb-0">
                            {/* Skipped under a rail filter: the whole pane is
                                that lab, and a header repeating it is noise. */}
                            {filter === "all" && (
                              <div className="flex items-center gap-1.5 px-3 pb-1.5">
                                <ProviderLogo provider={run.provider} className="h-3.5 w-3.5" />
                                <span className="font-mono text-micro uppercase text-muted-foreground">
                                  {PROVIDERS[run.provider].label.split(" · ")[0]}
                                </span>
                                <span className="h-px min-w-4 flex-1 bg-border/50" aria-hidden="true" />
                              </div>
                            )}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1">
                              {run.items.map((m, i) => renderRow(m, run.start + i))}
                            </div>
                          </div>
                        ))}

                        {legacyItems.length > 0 && (
                          <div className="mt-2.5">
                            {/* Auto-expand while searching so past matches are visible. */}
                            <details key={q ? "open" : "closed"} open={!!q} className="group/legacy overflow-hidden rounded-control border border-border/40 bg-card">
                              <summary className="cursor-pointer flex items-center justify-between px-3 py-2 font-mono text-micro uppercase font-medium text-muted-foreground hover:bg-accent/30 transition-colors duration-fast ease-out-soft">
                                <span>Past models ({legacyItems.length})</span>
                                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-base group-open/legacy:rotate-180" />
                              </summary>
                              <div className="p-2 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 border-t border-dashed border-border/45 bg-secondary">
                                {legacyItems.map((m, i) => renderRow(m, i + standardItems.length))}
                              </div>
                            </details>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </ScrollFade>
          </div>
          </div>
          <ModelDetailPanel
            model={hoveredModel}
            reasoningEffort={reasoningEffort}
            onCommit={(effort) => {
              // Slider drag: apply effort AND the hovered model, but keep the
              // picker open so the user can keep comparing tiers.
              if (!hoveredModel || hoveredModel.comingSoon) return;
              if (planRank(plan) < planRank(effectiveMinPlan(hoveredModel.minPlan))) {
                setOpen(false);
                router.push("/upgrade");
                return;
              }
              onReasoningChange?.(effort);
              onChange(hoveredModel.id);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
