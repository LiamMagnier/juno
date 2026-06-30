"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Brain, Check, ChevronDown, Eye, Globe, Image as ImageIcon, LayoutGrid, Lock, Search, Sparkles, Star, Video } from "lucide-react";
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
  getModelMetrics,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { providerAccent } from "@/lib/provider-colors";
import { cn } from "@/lib/utils";

type Filter = "all" | "favorites" | Provider;

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
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className="h-4 w-2 rounded-full bg-muted"
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

const THINKING_OPTIONS: { effort: ReasoningEffort; label: string }[] = [
  { effort: null, label: "Instant" },
  { effort: "low", label: "Low" },
  { effort: "medium", label: "Medium" },
  { effort: "high", label: "High" },
];

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
  const thinking = model.reasoning && !!effectiveEffort;

  const bars: { label: string; key: MetricKey }[] = [
    { label: "Intelligence", key: "intelligence" },
    { label: "Speed", key: "speed" },
    { label: "Context", key: "context" },
    { label: "Cost", key: "cost" },
  ];

  return (
    <div className="flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l bg-card/85 shadow-soft backdrop-blur-xl md:w-60">
      <div className="space-y-4 p-5">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-lg font-semibold leading-tight tracking-tight">{model.name}</h3>
            <ProviderLogo provider={model.provider} className="mt-0.5 h-6 w-6 shrink-0 rounded-[28%]" />
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{PROVIDERS[model.provider].label.split(" · ")[0]}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{formatContext(metrics.contextTokens)} context</span>
          </div>
        </div>

        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {model.description ?? "A capable model in your configured providers."}
        </p>

        {(model.vision || model.reasoning || model.webSearch) && (
          <div className="flex flex-wrap gap-1.5">
            {model.vision && <CapabilityChip icon={Eye} label="Vision" />}
            {model.reasoning && <CapabilityChip icon={Brain} label="Reasoning" />}
            {model.webSearch && <CapabilityChip icon={Globe} label="Web search" />}
          </div>
        )}

        <div className="space-y-2.5">
          {bars.map((b) => (
            <MetricBars key={b.key} label={b.label} value={metricScore(model, b.key, effectiveEffort)} accent={accent} />
          ))}
        </div>
      </div>

      {/* Thinking mode — drives the metrics above. Hover to preview, click to set. */}
      <div className="mt-auto border-t p-5 pt-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Thinking</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
            {thinking ? `${effectiveEffort} effort` : "Instant"}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {THINKING_OPTIONS.map((o) => {
            const disabled = o.effort !== null && !model.reasoning;
            const active = effectiveEffort === o.effort;
            return (
              <button
                key={o.label}
                type="button"
                disabled={disabled}
                onMouseEnter={() => !disabled && setPreview({ effort: o.effort })}
                onFocus={() => !disabled && setPreview({ effort: o.effort })}
                onMouseLeave={() => setPreview(null)}
                onBlur={() => setPreview(null)}
                onClick={() => !disabled && onCommit?.(o.effort)}
                className={cn(
                  "rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                    : "bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-40 hover:bg-muted/60 hover:text-muted-foreground"
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {model.reasoning
            ? "Pick a level to switch to this model with that thinking effort."
            : "This model replies instantly. Click Instant to use it."}
        </p>
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
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-all duration-fast ease-out-soft hover:scale-105 active:scale-95",
        active ? "bg-primary/20 ring-2 ring-primary/50 shadow-sm" : "hover:bg-accent",
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
  const { quota, features, models, settings, setSettings } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const favSet = React.useMemo(() => new Set(settings.favoriteModels), [settings.favoriteModels]);
  const current = models.find((m) => m.id === value) ?? resolveModel(value);
  const q = query.trim().toLowerCase();

  const toggleFavorite = (id: string) => {
    const next = favSet.has(id) ? settings.favoriteModels.filter((m) => m !== id) : [...settings.favoriteModels, id];
    setSettings({ favoriteModels: next });
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favoriteModels: next }),
    }).catch(() => {});
  };

  const providerFilter = filter !== "all" && filter !== "favorites" ? (filter as Provider) : null;
  const filterConfigured = providerFilter ? features.providers.includes(providerFilter) : true;

  const visible: ModelInfo[] = models
    .filter((m) => (filter === "favorites" ? favSet.has(m.id) : providerFilter ? m.provider === providerFilter : true))
    .filter((m) => !q || m.name.toLowerCase().includes(q) || (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q));
  const hoveredModel = React.useMemo(
    () => visible.find((m) => m.id === hoveredId) ?? visible.find((m) => m.id === value) ?? current ?? visible[0] ?? null,
    [current, hoveredId, value, visible]
  );

  const select = (m: ModelInfo) => {
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
    { key: "chat", label: "Chat", icon: Sparkles },
    { key: "image", label: "Image", icon: ImageIcon },
    { key: "video", label: "Video", icon: Video },
  ];

  const renderRow = (m: ModelInfo, i: number) => {
    const locked = planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
    const fav = favSet.has(m.id);
    const active = value === m.id;
    return (
      <div
        key={m.id}
        style={{ animationDelay: `${Math.min(i, 12) * 16}ms` }}
        onMouseEnter={() => setHoveredId(m.id)}
        onFocus={() => setHoveredId(m.id)}
        className={cn(
          "group relative flex flex-col justify-between rounded-xl border p-3 transition-all duration-base ease-out-soft animate-rise-in [animation-fill-mode:backwards]",
          active
            ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
            : "border-border/70 bg-card/65 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-accent/40 hover:shadow-soft"
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
          <div className="flex items-center justify-between w-full mt-auto pt-1 border-t border-dashed border-border/40">
            <div className="flex items-center gap-1.5">
              {m.modality === "image" && <ImageIcon className="h-3.5 w-3.5 shrink-0 text-source" aria-label="Image generation" />}
              {m.modality === "video" && <Video className="h-3.5 w-3.5 shrink-0 text-source" aria-label="Video generation" />}
              {m.vision && <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-label="Accepts images" />}
              {m.reasoning && <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-label="Reasoning" />}
              {m.webSearch && <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" aria-label="Web search" />}
              <span className="font-mono text-[9px] uppercase font-semibold text-muted-foreground/60 tracking-wider">
                {"$".repeat(m.cost)}
              </span>
            </div>
            {locked ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-primary">
                <Lock className="h-3 w-3" /> {PLANS[effectiveMinPlan(m.minPlan)].name}
              </span>
            ) : active ? (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            ) : null}
          </div>
        </button>
        
        {/* Favorite Star */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(m.id);
          }}
          aria-label={fav ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={fav}
          className="absolute top-2.5 right-2.5 rounded-md p-1.5 opacity-45 hover:opacity-100 group-hover:opacity-100 transition-opacity"
        >
          <Star className={cn("h-4 w-4 transition-colors", fav ? "fill-primary text-primary opacity-100" : "text-muted-foreground/70")} />
        </button>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group inline-flex min-w-0 max-w-[10rem] items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-foreground/80 transition-all hover:bg-accent hover:text-foreground active:scale-95 sm:max-w-[14rem]"
        >
          {current && <ProviderLogo provider={current.provider} className="h-4 w-4 rounded transition-transform group-hover:scale-110" />}
          <span className="truncate font-mono">{current?.name ?? "Select model"}</span>
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
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
            className="flex w-full shrink-0 items-center justify-between border-b bg-primary/5 px-4 py-2.5 text-left transition-colors hover:bg-primary/10"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" /> Unlock every model
            </span>
            <span className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">Upgrade</span>
          </button>
        )}

        <div className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto md:snap-none md:overflow-x-visible">
          {/* Pane 1: rail + list — one full-width swipe page on mobile, side panes on desktop. */}
          <div className="flex w-full shrink-0 snap-start md:w-auto md:flex-1 md:shrink">
          {/* Rail */}
          <div className="flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-muted/30 py-3">
            <RailButton active={filter === "all"} title="All models" onClick={() => setFilter("all")}>
              <LayoutGrid className={cn("h-5 w-5", filter === "all" ? "text-primary" : "text-muted-foreground")} />
            </RailButton>
            <RailButton active={filter === "favorites"} title="Favorites" onClick={() => setFilter("favorites")}>
              <Star className={cn("h-5 w-5", filter === "favorites" ? "fill-primary text-primary" : "text-muted-foreground")} />
            </RailButton>
            <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
            {PROVIDER_LIST.map((p) => (
              <RailButton key={p} active={filter === p} dimmed={!features.providers.includes(p)} title={PROVIDERS[p].label} onClick={() => setFilter(p)}>
                <ProviderLogo provider={p} className="h-7 w-7" />
              </RailButton>
            ))}
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative border-b p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models…" className="h-8 pl-10" autoFocus />
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
                <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                  {filter === "favorites" ? "No favorites yet — tap a star to add one." : "No models found."}
                </p>
              ) : (
                MODALITY_GROUPS.map((g) => {
                  const items = visible.filter((m) => (m.modality ?? "chat") === g.key);
                  if (items.length === 0) return null;
                  return (
                    <div key={g.key} className="mb-4">
                      <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
                        <g.icon className="h-3.5 w-3.5 text-muted-foreground/75" />
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">{g.label}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1">
                        {items.map((m, i) => renderRow(m, i))}
                      </div>
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
              if (!hoveredModel) return;
              onReasoningChange?.(effort);
              select(hoveredModel); // plan-gates, applies the model, and closes
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
