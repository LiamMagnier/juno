"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  ChevronDown,
  Clock,
  Eye,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  MessageCircle,
  Search,
  Video,
  Zap,
} from "lucide-react";
import { ComposerIcons, StatusIcons } from "@/lib/app-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import {
  AUTO_MODEL_ID,
  AUTO_MODEL_INFO,
  isAutoModelId,
} from "@/lib/auto-model";
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

function metricScore(
  model: ModelInfo,
  key: MetricKey,
  effort: ReasoningEffort,
) {
  const metrics = applyReasoning(
    getModelMetrics(model),
    effort,
    model.reasoning,
  );
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

function MetricBars({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-micro text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-micro tabular-nums text-muted-foreground/70">
          {value}/10
        </span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className="h-3.5 w-2 rounded-full bg-muted ring-1 ring-inset ring-foreground/10 transition-colors duration-base ease-out-soft"
            style={i < value ? { backgroundColor: accent } : undefined}
            aria-hidden
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityChip({
  icon: Icon,
  label,
}: {
  icon: typeof Brain;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-border/40 bg-muted/20 px-1 py-[0.5px] text-micro font-normal leading-none text-muted-foreground/80">
      <Icon className="size-2 text-muted-foreground/70" />
      <span>{label}</span>
    </span>
  );
}

function RowChip({
  icon: Icon,
  label,
  tint,
  warn,
  title,
}: {
  icon: typeof Brain;
  label: string;
  tint?: boolean;
  warn?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border bg-muted/20 px-1 py-[0.5px] text-micro font-normal leading-none text-muted-foreground/80",
        warn
          ? "border-warning/40 bg-warning/10 text-warning"
          : tint
            ? "border-source/40 text-source"
            : "border-border/40",
      )}
    >
      <Icon className="size-2 shrink-0 text-muted-foreground/70" />
      <span>{label}</span>
    </span>
  );
}

function isFastModel(m: ModelInfo) {
  return getModelMetrics(m).speed >= 8;
}

function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

function ModelDetailPanel({
  model,
  reasoningEffort,
  onCommit,
}: {
  model: ModelInfo | null;
  reasoningEffort: ReasoningEffort;
  onCommit?: (effort: ReasoningEffort) => void;
}) {
  const [preview, setPreview] = React.useState<{
    effort: ReasoningEffort;
  } | null>(null);

  React.useEffect(() => {
    setPreview(null);
  }, [model?.id]);

  if (!model) {
    return (
      <div className="flex w-full shrink-0 snap-start items-center border-l border-border/50 bg-card/60 p-5 md:w-64">
        <p className="text-xs text-muted-foreground">
          Hover a model to compare intelligence, speed, context, and cost.
        </p>
      </div>
    );
  }

  if (isAutoModelId(model.id)) {
    return (
      <div className="flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l border-border/50 bg-card/75 p-4 md:w-64">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold leading-tight tracking-tight">
              Auto Router
            </h3>
            <span className="mt-0.5 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-micro font-semibold text-primary">
              Recommended
            </span>
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <JunoMark className="size-4.5" />
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Routes each message to the{" "}
          <span className="font-medium text-foreground">optimal model</span> and{" "}
          <span className="font-medium text-foreground">thinking depth</span>{" "}
          for speed, intelligence and cost.
        </p>
        <ul className="mt-4 space-y-2 text-label leading-snug text-muted-foreground">
          <li className="flex gap-2">
            <span className="font-mono text-primary font-bold">1</span> Everyday
            prompt → Fast models · Instant
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-primary font-bold">2</span> Coding &
            analysis → Mid tier · Balanced
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-primary font-bold">3</span> Deep
            reasoning → Flagship · Deep thinking
          </li>
        </ul>
        <p className="mt-4 text-caption leading-snug text-muted-foreground/80 border-t border-border/40 pt-3">
          Respects your plan limits, image needs, and web search settings.
        </p>
      </div>
    );
  }

  const accent = providerAccent(model.provider);
  const effectiveEffort: ReasoningEffort = preview
    ? preview.effort
    : reasoningEffort;
  const metrics = applyReasoning(
    getModelMetrics(model),
    effectiveEffort,
    model.reasoning,
  );
  const options = reasoningOptions(model);
  const free = metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0;

  const bars: { label: string; key: MetricKey }[] = [
    { label: "Intelligence", key: "intelligence" },
    { label: "Speed", key: "speed" },
    { label: "Context", key: "context" },
    { label: "Cost", key: "cost" },
  ];

  return (
    <div className="flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l border-border/50 bg-card/75 md:w-64">
      <div key={model.id} className="flex min-h-full flex-col">
        <div className="space-y-3.5 p-4">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-semibold leading-tight tracking-tight">
                {model.name}
              </h3>
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <ProviderLogo provider={model.provider} className="size-4" />
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-muted-foreground">
              <span>{PROVIDERS[model.provider].label.split(" · ")[0]}</span>
              <span aria-hidden>·</span>
              <span className="font-mono">
                {formatContext(metrics.contextTokens)} context
              </span>
            </div>
          </div>

          {model.status === "deprecated" && (
            <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-caption font-medium text-warning">
              <StatusIcons.warning className="mt-0.5 size-3 shrink-0" />
              <span>
                {model.retiresOn
                  ? `Available until ${formatRetirementDate(model.retiresOn)}`
                  : "Retiring soon"}
              </span>
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {model.description ?? "Capable foundation model."}
          </p>

          {(model.vision ||
            model.reasoning ||
            model.webSearch ||
            isFastModel(model)) && (
            <div className="flex flex-wrap gap-1">
              {model.vision && <CapabilityChip icon={Eye} label="Vision" />}
              {model.reasoning && (
                <CapabilityChip icon={Brain} label="Thinking" />
              )}
              {model.webSearch && (
                <CapabilityChip icon={ComposerIcons.web} label="Search" />
              )}
              {/* Raw `Zap`. This bolt is SPEED, not the Juno Work destination. */}
              {isFastModel(model) && <CapabilityChip icon={Zap} label="Fast" />}
            </div>
          )}

          <div className="space-y-2 border-t border-border/40 pt-2.5">
            {bars.map((b) => (
              <MetricBars
                key={b.key}
                label={b.label}
                value={metricScore(model, b.key, effectiveEffort)}
                accent={accent}
              />
            ))}
            {hasLiveBenchmark(model) && (
              <p className="font-mono text-micro text-muted-foreground/60">
                Scores by{" "}
                <a
                  href="https://artificialanalysis.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted hover:text-muted-foreground"
                >
                  Artificial Analysis
                </a>
              </p>
            )}
          </div>

          <div className="border-t border-dashed border-border/50 pt-2.5">
            <div className="mb-0.5 font-mono text-micro text-muted-foreground">
              Pricing
            </div>
            {free ? (
              <p className="text-xs font-semibold">Free</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-1 text-xs tabular-nums">
                <span className="font-semibold">
                  {formatPrice(metrics.inputUsdPerMTok)}
                </span>
                <span className="text-caption text-muted-foreground">in</span>
                <span className="text-muted-foreground/50" aria-hidden>
                  ·
                </span>
                <span className="font-semibold">
                  {formatPrice(metrics.outputUsdPerMTok)}
                </span>
                <span className="text-caption text-muted-foreground">
                  out / MTok
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Thinking Tier Control */}
        <div className="mt-auto border-t border-border/60 bg-muted/20 p-3">
          {options.length > 1 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-micro text-muted-foreground">
                  Thinking depth
                </span>
                <span className="font-mono text-micro font-medium text-primary">
                  {options.find((o) => o.value === effectiveEffort)?.label ??
                    "Auto"}
                </span>
              </div>
              <ReasoningSlider
                options={options}
                value={effectiveEffort}
                onChange={(effort) => {
                  setPreview({ effort });
                  onCommit?.(effort);
                }}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between text-micro text-muted-foreground">
              <span>Thinking: {model.reasoning ? "Always on" : "Instant"}</span>
            </div>
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
        "flex size-9 shrink-0 items-center justify-center rounded-field transition-all duration-fast hover:scale-105 active:scale-95",
        active
          ? "bg-primary/15 text-primary ring-1 ring-primary/30 shadow-xs"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        dimmed && "opacity-35 hover:scale-100 active:scale-100",
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
  filter: modelFilter,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;
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
    : (models.find((m) => m.id === value) ?? resolveModel(value));
  const q = query.trim().toLowerCase();
  const autoSelected = isAutoModelId(value);

  const providerFilter = filter !== "all" ? (filter as Provider) : null;
  const filterConfigured = providerFilter
    ? features.providers.includes(providerFilter)
    : true;

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
          (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q),
      ),
  );

  const showAutoRow =
    filter === "all" &&
    (modelFilter ? modelFilter(AUTO_MODEL_INFO) : true) &&
    (!q ||
      "auto".includes(q) ||
      "cheap".includes(q) ||
      "route".includes(q) ||
      "smart".includes(q) ||
      "default".includes(q));

  const hoveredModel = React.useMemo(() => {
    if (hoveredId === AUTO_MODEL_ID) return AUTO_MODEL_INFO;
    if (hoveredId) return models.find((m) => m.id === hoveredId) ?? null;
    return current ?? visible[0] ?? null;
  }, [hoveredId, current, models, visible]);

  const select = (m: ModelInfo) => {
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      setOpen(false);
      return;
    }
    if (m.comingSoon) return;
    if (planRank(plan) < planRank(effectiveMinPlan(m.minPlan))) {
      setOpen(false);
      router.push("/upgrade");
      return;
    }
    onChange(m.id);
    setOpen(false);
  };

  const renderRow = (m: ModelInfo) => {
    const active = value === m.id;
    const soon = !!m.comingSoon;
    const locked =
      !soon && planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
    const isHovered = hoveredId === m.id;

    return (
      <div
        key={m.id}
        onMouseEnter={() => setHoveredId(m.id)}
        onFocus={() => setHoveredId(m.id)}
        className={cn(
          "group relative flex flex-col justify-between rounded-card border p-2.5 transition-all duration-fast ease-out-soft",
          "active:scale-[0.99] " +
            (soon
              ? "opacity-45 cursor-not-allowed border-border/40 bg-card/20"
              : active
                ? "border-primary/60 bg-primary/10 shadow-xs ring-1 ring-primary/30"
                : isHovered
                  ? "border-border/80 bg-accent/60 shadow-soft"
                  : "border-border/50 bg-card/40 hover:border-border hover:bg-accent/40"),
        )}
      >
        <button
          type="button"
          disabled={soon}
          onClick={() => select(m)}
          className="flex min-w-0 flex-col items-start gap-1.5 text-left outline-none size-full"
        >
          {/* Logo & Name Row */}
          <div className="flex items-center gap-2.5 w-full pr-6">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-xs border border-border/60 bg-muted/40">
              <ProviderLogo provider={m.provider} className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold tracking-tight">
                {m.name}
              </span>
              <span className="block truncate text-caption text-muted-foreground">
                {PROVIDERS[m.provider].label.split(" · ")[0]}
              </span>
            </div>
          </div>

          {/* Bottom attributes */}
          <div className="flex items-center justify-between gap-1.5 w-full mt-auto pt-1 border-t border-dashed border-border/40">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {m.status === "deprecated" && (
                <RowChip
                  icon={StatusIcons.warning}
                  label={
                    m.retiresOn
                      ? `Until ${formatRetirementDate(m.retiresOn)}`
                      : "Retiring"
                  }
                  warn
                  title={m.deprecationNote ?? "Deprecated by the provider"}
                />
              )}
              {m.modality === "image" && (
                <RowChip icon={ImageIcon} label="Image" tint />
              )}
              {m.modality === "video" && (
                <RowChip icon={Video} label="Video" tint />
              )}
              {m.reasoning && <RowChip icon={Brain} label="Thinking" />}
              {m.vision && <RowChip icon={Eye} label="Vision" />}
              {m.webSearch && (
                <RowChip icon={ComposerIcons.web} label="Search" />
              )}
              {isFastModel(m) && <RowChip icon={Zap} label="Fast" />}
            </div>
            {soon ? (
              <span className="flex shrink-0 items-center gap-1 text-micro font-semibold text-amber-500">
                <Clock className="size-3" /> Soon
              </span>
            ) : locked ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-micro font-semibold text-primary">
                <Lock className="size-2.5" />{" "}
                {PLANS[effectiveMinPlan(m.minPlan)].name}
              </span>
            ) : active ? (
              <StatusIcons.success className="size-3.5 shrink-0 text-primary" />
            ) : null}
          </div>
        </button>
      </div>
    );
  };

  const MODALITY_GROUPS = [
    { key: "chat", label: "Chat & reasoning", icon: MessageCircle },
    { key: "image", label: "Image generation", icon: ImageIcon },
    { key: "video", label: "Video generation", icon: Video },
  ] as const;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${current?.name ?? "Select model"}`}
          className="composer-chip group inline-flex h-8 w-full min-w-0 max-w-[13rem] items-center gap-1.5 rounded-composer-control px-2.5 text-label font-medium text-foreground/80 transition-all duration-fast hover:bg-accent hover:text-foreground active:scale-[0.97] data-[state=open]:bg-accent data-[state=open]:text-foreground max-[359px]:w-auto max-[359px]:px-2 sm:w-auto sm:max-w-[16rem] sm:gap-1.5 sm:px-2 sm:text-ui coarse:h-11"
        >
          {autoSelected ? (
            <JunoMark className="size-3.5 shrink-0 rounded-sm transition-transform duration-base ease-out-soft group-hover:scale-110 sm:size-4" />
          ) : current ? (
            <ProviderLogo
              provider={current.provider}
              className="size-3.5 shrink-0 rounded-sm transition-transform duration-base ease-out-soft group-hover:scale-110 sm:size-4"
            />
          ) : null}
          <span
            key={current?.id ?? "no-model"}
            aria-hidden="true"
            className="min-w-0 flex-1 truncate font-mono motion-safe:animate-fade-in max-[359px]:hidden sm:flex-none"
          >
            {current?.name ?? "Select model"}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-60 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180 sm:size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions={true}
        style={{
          maxHeight:
            "min(28rem, var(--radix-popover-content-available-height))",
        }}
        className="flex w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-panel border border-border/80 bg-popover/98 p-0 text-popover-foreground shadow-2xl backdrop-blur-2xl sm:w-[38rem] sm:max-w-[90vw] md:w-[46rem] md:max-w-[88vw]"
      >
        {features.billing && plan !== "MAX" && plan !== "OWNER" && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/upgrade");
            }}
            className="flex w-full shrink-0 items-center justify-between border-b border-border/50 bg-primary/8 px-4 py-2 text-left transition-colors duration-fast hover:bg-primary/12"
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-primary">
              <Zap className="size-3.5 fill-current" /> Upgrade to unlock
              frontier models
            </span>
            <span className="rounded-md bg-primary px-2 py-0.5 text-micro font-semibold text-primary-foreground shadow-xs">
              Upgrade
            </span>
          </button>
        )}

        <div className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto md:snap-none md:overflow-x-visible">
          {/* Pane 1: Rail + List */}
          <div className="flex w-full shrink-0 snap-start md:w-auto md:flex-1 md:shrink">
            {/* Rail */}
            <div className="flex w-14 shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r border-border/50 bg-muted/25 p-2">
              <RailButton
                active={filter === "all"}
                title="All models"
                onClick={() => setFilter("all")}
              >
                <LayoutGrid
                  className={cn(
                    "size-4.5",
                    filter === "all" ? "text-primary" : "text-muted-foreground",
                  )}
                />
              </RailButton>
              <div className="my-1 h-px w-5 shrink-0 bg-border/60" />
              {PROVIDER_LIST.map((p) => (
                <RailButton
                  key={p}
                  active={filter === p}
                  dimmed={!features.providers.includes(p)}
                  title={PROVIDERS[p].label}
                  onClick={() => setFilter(p)}
                >
                  <ProviderLogo provider={p} className="size-5" />
                </RailButton>
              ))}
            </div>

            {/* List */}
            <div className="flex min-w-0 flex-1 flex-col bg-background/50">
              <div className="relative border-b border-border/50 p-2">
                {/* Raw `Search`: this narrows the model list in place, it does
                    not open `AppIcons.search`'s destination. */}
                <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models and capabilities…"
                  className="h-8 rounded-field border-border/60 bg-background/70 pl-8 text-xs focus-visible:ring-1 focus-visible:ring-primary/30"
                  autoFocus
                />
              </div>
              <ScrollFade
                className="min-h-0 flex-1 overflow-y-auto"
                viewportClassName="p-2 space-y-3"
              >
                {providerFilter && !filterConfigured ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                    <ProviderLogo
                      provider={providerFilter}
                      className="size-8"
                    />
                    <p className="text-sm font-medium">
                      {PROVIDERS[providerFilter].label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Add{" "}
                      <span className="font-mono text-primary font-semibold">
                        {PROVIDERS[providerFilter].apiKeyEnv}
                      </span>{" "}
                      in Settings to enable these models.
                    </p>
                  </div>
                ) : visible.length === 0 && !showAutoRow ? (
                  <p className="px-2 py-10 text-center text-xs text-muted-foreground">
                    No models found.
                  </p>
                ) : (
                  MODALITY_GROUPS.map((g) => {
                    const items = visible.filter(
                      (m) => (m.modality ?? "chat") === g.key,
                    );
                    if (
                      items.length === 0 &&
                      !(g.key === "chat" && showAutoRow)
                    )
                      return null;

                    const standardItems = items.filter((m) => !m.legacy);
                    const legacyItems = items.filter((m) => m.legacy);

                    return (
                      <div key={g.key} className="space-y-1.5">
                        <div className="flex items-center gap-1.5 px-1 pt-0.5">
                          <g.icon className="size-3 text-muted-foreground/75" />
                          <span className="text-caption font-medium text-muted-foreground/80">
                            {g.label}
                          </span>
                        </div>

                        {g.key === "chat" && showAutoRow && (
                          <div
                            onMouseEnter={() => setHoveredId(AUTO_MODEL_ID)}
                            onFocus={() => setHoveredId(AUTO_MODEL_ID)}
                            className={cn(
                              "group relative flex flex-col justify-between rounded-card border p-2.5 transition-all duration-fast ease-out-soft",
                              "active:scale-[0.99] " +
                                (autoSelected
                                  ? "border-primary/60 bg-primary/10 shadow-xs ring-1 ring-primary/30"
                                  : hoveredId === AUTO_MODEL_ID
                                    ? "border-border/80 bg-accent/60 shadow-soft"
                                    : "border-border/50 bg-card/40 hover:border-border hover:bg-accent/40"),
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => select(AUTO_MODEL_INFO)}
                              className="flex w-full items-start gap-2.5 text-left"
                            >
                              <div className="flex size-7 shrink-0 items-center justify-center rounded-xs bg-primary/15 text-primary">
                                <JunoMark className="size-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-xs font-semibold">
                                    Auto
                                  </span>
                                  <span className="rounded-full bg-primary/15 px-1.5 py-px text-micro font-semibold text-primary">
                                    Smart
                                  </span>
                                </div>
                                <span className="mt-0.5 line-clamp-1 text-caption text-muted-foreground">
                                  Automatically routes each prompt to the
                                  optimal model
                                </span>
                              </div>
                              {autoSelected ? (
                                <StatusIcons.success className="size-4 shrink-0 text-primary" />
                              ) : null}
                            </button>
                          </div>
                        )}

                        {standardItems.length > 0 && (
                          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-1">
                            {standardItems.map((m) => renderRow(m))}
                          </div>
                        )}

                        {legacyItems.length > 0 && (
                          <div className="mt-2">
                            <details
                              key={q ? "open" : "closed"}
                              open={!!q}
                              className="group/legacy rounded-card border border-border/40 bg-muted/10 overflow-hidden"
                            >
                              <summary className="cursor-pointer flex items-center justify-between px-3 py-1.5 text-micro font-bold text-muted-foreground hover:bg-accent/30 transition-colors duration-fast">
                                <span>Past models ({legacyItems.length})</span>
                                <ChevronDown className="size-3 transition-transform duration-base group-open/legacy:rotate-180" />
                              </summary>
                              <div className="p-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-1 border-t border-dashed border-border/45 bg-background/45">
                                {legacyItems.map((m) => renderRow(m))}
                              </div>
                            </details>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </ScrollFade>
            </div>
          </div>

          {/* Pane 2: Detail Panel */}
          <ModelDetailPanel
            model={hoveredModel}
            reasoningEffort={reasoningEffort}
            onCommit={(effort) => {
              if (!hoveredModel || hoveredModel.comingSoon) return;
              if (
                planRank(plan) <
                planRank(effectiveMinPlan(hoveredModel.minPlan))
              ) {
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
