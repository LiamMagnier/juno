"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Brain, Check, ChevronDown, Clock, Eye, Globe, Image as ImageIcon, LayoutGrid, Lock, MessageSquare, Search, TriangleAlert, Video, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
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
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{value}/10</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className="h-4 w-2 rounded-full bg-muted ring-1 ring-inset ring-foreground/10 transition-colors duration-base ease-out-soft"
            style={i < value ? { backgroundColor: accent } : undefined}
            aria-hidden
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityChip({ icon: Icon, label }: { icon: typeof Brain; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
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
        "inline-flex shrink-0 items-center gap-1 rounded-full border bg-background/60 px-1.5 py-px text-[9px] font-medium leading-4",
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
              <h3 className="text-lg font-semibold leading-tight tracking-tight">{model.name}</h3>
              <ProviderLogo provider={model.provider} className="mt-0.5 h-6 w-6 shrink-0 rounded-[28%]" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>{PROVIDERS[model.provider].label.split(" · ")[0]}</span>
              <span aria-hidden>·</span>
              <span className="font-mono">{formatContext(metrics.contextTokens)} context</span>
              {model.status === "legacy" && (
                <span className="rounded-full border border-border/70 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/80">
                  Legacy
                </span>
              )}
            </div>
          </div>

          {model.status === "deprecated" && (
            <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] font-medium leading-snug text-warning">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{model.deprecationNote ?? "Retiring — deprecated by the provider."}</span>
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
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                Scores by{" "}
                <a href="https://artificialanalysis.ai" target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground">
                  Artificial Analysis
                </a>
              </p>
            )}
          </div>

          {/* Pricing — tracks the thinking preview like the bars (reasoning burns output tokens). */}
          <div className="border-t border-dashed border-border/60 pt-3">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Pricing</div>
            {free ? (
              <p className="text-sm font-semibold">Free</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-1 text-sm tabular-nums">
                <span className="font-semibold">{formatPrice(metrics.inputUsdPerMTok)}</span>
                <span className="text-[11px] text-muted-foreground">in</span>
                <span className="text-muted-foreground/50" aria-hidden>
                  ·
                </span>
                <span className="font-semibold">{formatPrice(metrics.outputUsdPerMTok)}</span>
                <span className="text-[11px] text-muted-foreground">out</span>
                <span className="text-[11px] text-muted-foreground/70">/ MTok</span>
              </p>
            )}
          </div>
        </div>

        {/* Thinking — the same slider as the composer; dragging previews the
            metrics live and commits without closing the picker. */}
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
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Thinking</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
                  {model.reasoning ? "Always on" : "Instant"}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
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
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-fast ease-out-soft hover:scale-105 active:scale-95",
        active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-accent",
        dimmed && "opacity-30 hover:scale-100 active:scale-100"
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
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;
}) {
  const router = useRouter();
  const { quota, features, models } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const current = models.find((m) => m.id === value) ?? resolveModel(value);
  const q = query.trim().toLowerCase();

  const providerFilter = filter !== "all" ? (filter as Provider) : null;
  const filterConfigured = providerFilter ? features.providers.includes(providerFilter) : true;

  // Sort [lab asc, intelligence desc, released desc, name asc] to match the
  // /api/models payload order (the Mac app trusts that order verbatim), so the
  // web selector looks identical even before the API response lands.
  const visible: ModelInfo[] = sortModelsForDisplay(
    models
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
  const hoveredModel = React.useMemo(
    () => visible.find((m) => m.id === hoveredId) ?? visible.find((m) => m.id === value) ?? current ?? visible[0] ?? null,
    [current, hoveredId, value, visible]
  );

  const select = (m: ModelInfo) => {
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
        style={{ animationDelay: `${Math.min(i, 12) * 16}ms` }}
        onMouseEnter={() => setHoveredId(m.id)}
        onFocus={() => setHoveredId(m.id)}
        className={cn(
          "group relative flex flex-col justify-between rounded-[10px] border p-3 transition-all duration-base ease-out-soft animate-rise-in [animation-fill-mode:backwards]",
          soon
            ? "border-border/60 bg-card/40 opacity-60"
            : "active:scale-[0.99] " + (active
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border/70 bg-card/65 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-accent/40 hover:shadow-soft active:translate-y-0 active:shadow-none")
        )}
      >
        <button
          type="button"
          onClick={() => select(m)}
          className="flex min-w-0 flex-col items-start gap-2 text-left outline-none w-full h-full"
        >
          {/* Logo & Name Row */}
          <div className="flex items-center gap-2.5 w-full pr-6">
            <ProviderLogo provider={m.provider} className="h-6 w-6 rounded-[32%]" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold tracking-tight">{m.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{PROVIDERS[m.provider].label.split(" · ")[0]}</span>
            </div>
          </div>
          
          {/* Description */}
          {m.description && (
            <p className="line-clamp-2 h-8 w-full text-[11px] leading-relaxed text-muted-foreground/90 md:hidden">
              {m.description}
            </p>
          )}
          
          {/* Bottom attributes */}
          <div className="flex items-center justify-between gap-2 w-full mt-auto pt-1 border-t border-dashed border-border/40">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {m.status === "deprecated" && (
                <RowChip icon={TriangleAlert} label="Retiring" warn title={m.deprecationNote ?? "Deprecated by the provider"} />
              )}
              {m.modality === "image" && <RowChip icon={ImageIcon} label="Image" tint />}
              {m.modality === "video" && <RowChip icon={Video} label="Video" tint />}
              {m.reasoning && <RowChip icon={Brain} label="Reasoning" />}
              {m.vision && <RowChip icon={Eye} label="Vision" />}
              {m.webSearch && <RowChip icon={Globe} label="Search" />}
              {isFastModel(m) && <RowChip icon={Zap} label="Fast" />}
              <span className="font-mono text-[9px] uppercase font-semibold text-muted-foreground/60 tracking-wider">
                {"$".repeat(m.cost)}
              </span>
            </div>
            {soon ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-amber-500">
                <Clock className="h-3 w-3" /> Soon
              </span>
            ) : locked ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-primary">
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
          className="group inline-flex h-8 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-[10px] px-2 text-[13px] font-medium text-foreground/80 transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent hover:text-foreground active:scale-[0.97] data-[state=open]:bg-accent data-[state=open]:text-foreground sm:max-w-[16rem] coarse:h-11"
        >
          {current && <ProviderLogo provider={current.provider} className="h-4 w-4 shrink-0 rounded transition-transform duration-base ease-out-soft group-hover:scale-110" />}
          <span className="truncate font-mono">{current?.name ?? "Select model"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
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
          <div className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-muted/30 py-3">
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
                className="h-8 rounded-[10px] pl-8 focus-visible:ring-1 focus-visible:ring-ring/30"
                autoFocus
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {providerFilter && !filterConfigured ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <ProviderLogo provider={providerFilter} className="h-8 w-8" />
                  <p className="text-sm font-medium">{PROVIDERS[providerFilter].label}</p>
                  <p className="text-xs text-muted-foreground">
                    Add <span className="font-mono">{PROVIDERS[providerFilter].apiKeyEnv}</span> to enable these models.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <p className="px-2 py-10 text-center text-sm text-muted-foreground">No models found.</p>
              ) : (
                MODALITY_GROUPS.map((g) => {
                  const items = visible.filter((m) => (m.modality ?? "chat") === g.key);
                  if (items.length === 0) return null;

                  const standardItems = items.filter((m) => !m.legacy);
                  const legacyItems = items.filter((m) => m.legacy);

                  return (
                    <div key={g.key} className="mb-4">
                      <div className="flex items-center gap-1.5 px-3 pb-2 pt-1">
                        <g.icon className="h-3.5 w-3.5 text-muted-foreground/75" />
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">{g.label}</span>
                      </div>

                      {standardItems.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1">
                          {standardItems.map((m, i) => renderRow(m, i))}
                        </div>
                      )}

                      {legacyItems.length > 0 && (
                        <div className="mt-2.5">
                          {/* Auto-expand while searching so legacy matches are visible. */}
                          <details key={q ? "open" : "closed"} open={!!q} className="group/legacy rounded-[10px] border border-border/40 bg-muted/10 overflow-hidden">
                            <summary className="cursor-pointer flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/30 transition-colors duration-fast ease-out-soft">
                              <span>Legacy Models ({legacyItems.length})</span>
                              <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-open/legacy:rotate-180" />
                            </summary>
                            <div className="p-2 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 border-t border-dashed border-border/45 bg-background/45">
                              {legacyItems.map((m, i) => renderRow(m, i + standardItems.length))}
                            </div>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
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
