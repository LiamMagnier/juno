"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LayoutGrid, Search } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  formatContext,
  formatPrice,
  getModelMetrics,
  hasLiveBenchmark,
  reasoningOptions,
  sortModelsForDisplay,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

type Filter = "all" | Provider;

/**
 * The model picker: provider rail · list · spec sheet.
 *
 * Calm on purpose. Every capability used to wear its own icon chip on every
 * row — brains, bolts, eyes — so the list read as a wall of badges and the
 * one thing that mattered (which model, at what cost) was the hardest to find.
 * Now a row is a name, a price glyph and one line of description; the spec
 * sheet on the right carries the capabilities as plain mono tags and the
 * numbers as a small table. Nothing sparkles.
 */

/** Most recently chosen models, newest first. Per browser, like a draft. */
const RECENT_KEY = "juno:models:recent";
const RECENT_MAX = 4;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode, quota); the list is a courtesy.
  }
}

/** `$` · `$$` · `$$$` — the relative cost tier, as a glyph the eye can scan. */
function priceGlyph(m: ModelInfo): string {
  return "$".repeat(Math.max(1, Math.min(3, m.cost)));
}

function isFastModel(m: ModelInfo) {
  return getModelMetrics(m).speed >= 8;
}

function capabilityTags(m: ModelInfo): string[] {
  const tags: string[] = [];
  if (m.modality === "image") tags.push("Image");
  if (m.modality === "video") tags.push("Video");
  if (m.reasoning) tags.push("Thinking");
  if (m.vision) tags.push("Vision");
  if (m.webSearch) tags.push("Search");
  if (m.agenticTools) tags.push("Tools");
  if (isFastModel(m)) tags.push("Fast");
  return tags;
}

const MODALITY_GROUPS = [
  { key: "chat", label: "Chat & reasoning" },
  { key: "image", label: "Image generation" },
  { key: "video", label: "Video generation" },
] as const;

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1 font-mono text-label text-muted-foreground">{children}</div>;
}

function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

/**
 * A capability tag: mono caption on the spec sheet's inset well. 22px tall,
 * no icon — the word is the whole message.
 */
function Tag({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "primary" | "warning" }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center rounded-xs border px-1.5 font-mono text-caption leading-none",
        tone === "primary"
          ? "border-primary/40 bg-primary/8 text-primary-ink"
          : tone === "warning"
            ? "border-warning/40 bg-warning/10 text-warning-foreground"
            : "border-border/70 bg-card text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** One line of the spec table: label left, value right, both mono. */
function SpecRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="font-mono text-caption text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-caption tabular-nums text-foreground">{value}</dd>
    </div>
  );
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
  const [preview, setPreview] = React.useState<{ effort: ReasoningEffort } | null>(null);

  React.useEffect(() => {
    setPreview(null);
  }, [model?.id]);

  const shell = "flex w-full shrink-0 snap-start flex-col overflow-y-auto border-l border-border/50 bg-card/60 md:w-64";

  if (!model) {
    return (
      <div className={cn(shell, "items-center justify-center p-5")}>
        <p className="text-center text-caption text-muted-foreground">
          Hover or arrow through the list to compare models.
        </p>
      </div>
    );
  }

  if (isAutoModelId(model.id)) {
    return (
      <div className={shell}>
        <div className="space-y-3.5 p-4">
          <div>
            <div className="font-mono text-label text-muted-foreground">Juno</div>
            <div className="mt-1 flex items-center gap-2">
              <h3 className="text-body-lg font-semibold leading-tight tracking-tight">Auto</h3>
              <Tag tone="primary">Recommended</Tag>
            </div>
          </div>
          <p className="text-ui leading-relaxed text-muted-foreground">
            Routes each message to the model and thinking depth that fit it — fast
            for the everyday, deep when it counts — within your plan.
          </p>
          <dl className="surface-inset rounded-control px-3 py-1">
            <SpecRow label="Everyday" value="Fast models" />
            <SpecRow label="Coding, analysis" value="Mid tier" />
            <SpecRow label="Deep reasoning" value="Flagship" />
          </dl>
          <p className="text-caption leading-snug text-muted-foreground">
            Respects image needs and web search settings.
          </p>
        </div>
      </div>
    );
  }

  const effectiveEffort: ReasoningEffort = preview ? preview.effort : reasoningEffort;
  const metrics = applyReasoning(getModelMetrics(model), effectiveEffort, model.reasoning);
  const options = reasoningOptions(model);
  const free = metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0;
  const tags = capabilityTags(model);

  return (
    <div className={shell}>
      <div key={model.id} className="flex min-h-full flex-col">
        <div className="space-y-3.5 p-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-label text-muted-foreground">
              <ProviderLogo provider={model.provider} className="size-3.5" />
              {PROVIDERS[model.provider].label.split(" · ")[0]}
            </div>
            <h3 className="mt-1 text-body-lg font-semibold leading-tight tracking-tight">{model.name}</h3>
          </div>

          {model.status === "deprecated" && (
            <div className="flex items-start gap-1.5 rounded-control border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption text-warning-foreground">
              <StatusIcons.warning className="mt-px size-3 shrink-0" />
              <span>
                {model.retiresOn ? `Available until ${formatRetirementDate(model.retiresOn)}` : "Retiring soon"}
              </span>
            </div>
          )}

          <p className="text-ui leading-relaxed text-muted-foreground">
            {model.description ?? "Capable foundation model."}
          </p>

          {tags.length > 0 && (
            <div className="surface-inset flex flex-wrap gap-1.5 rounded-control p-2">
              {tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          )}

          <dl className="divide-y divide-border/50 border-t border-border/50">
            <SpecRow label="Context" value={formatContext(metrics.contextTokens)} />
            <SpecRow label="Speed" value={`${metrics.speed}/10`} />
            <SpecRow label="Intelligence" value={`${metrics.intelligence}/10`} />
            <SpecRow
              label="Cost / MTok"
              value={
                free ? "Free" : `${formatPrice(metrics.inputUsdPerMTok)} in · ${formatPrice(metrics.outputUsdPerMTok)} out`
              }
            />
          </dl>
          {hasLiveBenchmark(model) && (
            <p className="font-mono text-micro text-muted-foreground/70">
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

        {/* Thinking depth */}
        <div className="mt-auto border-t border-border/50 p-3">
          {options.length > 1 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-caption text-muted-foreground">Thinking depth</span>
                <span className="font-mono text-caption text-foreground">
                  {options.find((o) => o.value === effectiveEffort)?.label ?? "Auto"}
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
            <div className="flex items-center justify-between font-mono text-caption text-muted-foreground">
              <span>Thinking</span>
              <span>{model.reasoning ? "Always on" : "Instant"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A 36px raised tile on the provider rail; selected = coral hairline. */
function RailTile({
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
      aria-label={title}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "control-neu flex size-9 shrink-0 items-center justify-center rounded-control transition-[background-color,color,box-shadow,border-color,transform] duration-fast ease-out-soft motion-reduce:transition-none",
        active ? "border-primary/70 text-foreground" : "text-muted-foreground hover:text-foreground",
        dimmed && "opacity-40",
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
  const [recent, setRecent] = React.useState<string[]>([]);
  const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

  React.useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);

  const current = isAutoModelId(value)
    ? AUTO_MODEL_INFO
    : (models.find((m) => m.id === value) ?? resolveModel(value));
  const q = query.trim().toLowerCase();
  const autoSelected = isAutoModelId(value);

  const providerFilter = filter !== "all" ? (filter as Provider) : null;
  // The live model endpoint is authoritative for provider availability.
  const configuredProviders = React.useMemo(
    () => new Set(models.map((model) => model.provider)),
    [models],
  );
  const filterConfigured = providerFilter ? configuredProviders.has(providerFilter) : true;

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
    (!q || ["auto", "cheap", "route", "smart", "default"].some((w) => w.includes(q)));

  // Recently used comes first, only in the unfiltered view — under a query or
  // a provider filter the list IS the answer and a second copy just pads it.
  const recentItems = React.useMemo(() => {
    if (q || filter !== "all") return [];
    return recent
      .map((id) => visible.find((m) => m.id === id))
      .filter((m): m is ModelInfo => !!m && !m.comingSoon);
  }, [recent, visible, q, filter]);

  /** Every id in display order — the keyboard cursor walks this. */
  const order = React.useMemo(() => {
    const ids: string[] = [];
    if (showAutoRow) ids.push(AUTO_MODEL_ID);
    for (const m of recentItems) ids.push(m.id);
    for (const g of MODALITY_GROUPS) {
      for (const m of visible) if ((m.modality ?? "chat") === g.key && !m.legacy) ids.push(m.id);
    }
    for (const m of visible) if (m.legacy) ids.push(m.id);
    // Recent rows and their group rows are distinct buttons, so an id may
    // appear twice; the cursor visits each once.
    return Array.from(new Set(ids));
  }, [showAutoRow, recentItems, visible]);

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
    pushRecent(m.id);
    onChange(m.id);
    setOpen(false);
  };

  /** Arrow keys from the search field walk the list; Enter picks. */
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    if (order.length === 0) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const id = hoveredId ?? order[0];
      const m = id === AUTO_MODEL_ID ? AUTO_MODEL_INFO : models.find((x) => x.id === id);
      if (m) select(m);
      return;
    }
    e.preventDefault();
    const at = hoveredId ? order.indexOf(hoveredId) : -1;
    const next =
      e.key === "ArrowDown"
        ? order[(at + 1) % order.length]
        : order[(at - 1 + order.length) % order.length];
    setHoveredId(next);
    rowRefs.current.get(next)?.scrollIntoView({ block: "nearest" });
  };

  const renderRow = (m: ModelInfo, keyPrefix = "") => {
    const auto = isAutoModelId(m.id);
    const active = auto ? autoSelected : value === m.id;
    const soon = !!m.comingSoon;
    const locked = !auto && !soon && planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
    const cursor = hoveredId === m.id;
    const provider = PROVIDERS[m.provider]?.label.split(" · ")[0];

    return (
      <button
        key={keyPrefix + m.id}
        ref={(el) => {
          if (el) rowRefs.current.set(m.id, el);
          else rowRefs.current.delete(m.id);
        }}
        id={keyPrefix ? undefined : `model-row-${m.id}`}
        type="button"
        role="option"
        aria-selected={active}
        disabled={soon}
        onMouseEnter={() => setHoveredId(m.id)}
        onFocus={() => setHoveredId(m.id)}
        onClick={() => select(m)}
        data-cursor={cursor ? "" : undefined}
        className={cn(
          // A flat row at rest; the pointer/cursor lays a flat accent wash on
          // it; the SELECTED row is the one raised object in the list, with a
          // coral hairline. The border is always drawn (transparent at rest)
          // so selection moves nothing.
          "group flex w-full items-center gap-2.5 rounded-control border px-2.5 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
          active
            ? "surface-raised border-primary/60"
            : cursor
              ? "border-transparent bg-accent/70"
              : "border-transparent hover:bg-accent/50",
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-xs border border-border/60",
            auto ? "bg-primary/10 text-primary" : "bg-secondary/70",
          )}
        >
          {auto ? <JunoMark className="size-4" /> : <ProviderLogo provider={m.provider} className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-ui font-medium text-foreground">{m.name}</span>
            <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
              {soon ? "Soon" : locked ? PLANS[effectiveMinPlan(m.minPlan)].name : auto ? "" : priceGlyph(m)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">
            {auto
              ? "Routes each message to the model that fits it"
              : m.status === "deprecated"
                ? m.retiresOn
                  ? `Retiring ${formatRetirementDate(m.retiresOn)} · ${provider}`
                  : `Retiring · ${provider}`
                : (m.description ?? provider)}
          </span>
        </span>
        {active && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
      </button>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${current?.name ?? "Select model"}`}
          // The shared composer chip: flat text, accent fill on hover and while
          // open. The name is set in the UI face, not mono — it is a label on a
          // control, not a value in a table.
          className={cn(composerChipClass, "max-w-[13rem] px-2 sm:max-w-[16rem]")}
        >
          {autoSelected ? (
            <JunoMark className="size-3.5 shrink-0 rounded-sm sm:size-4" />
          ) : current ? (
            <ProviderLogo provider={current.provider} className="size-3.5 shrink-0 rounded-sm sm:size-4" />
          ) : null}
          <span
            key={current?.id ?? "no-model"}
            aria-hidden="true"
            className="min-w-0 truncate motion-safe:animate-fade-in max-[359px]:hidden"
          >
            {current?.name ?? "Select model"}
          </span>
          <ChevronDown className={composerChevronClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions={true}
        style={{ maxHeight: "min(30rem, var(--radix-popover-content-available-height))" }}
        className="flex w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-panel p-0 sm:w-[40rem] sm:max-w-[90vw] md:w-[48rem] md:max-w-[88vw]"
      >
        {features.billing && plan !== "MAX" && plan !== "OWNER" && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/upgrade");
            }}
            className="flex w-full shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-2 text-left transition-colors duration-fast hover:bg-accent/50"
          >
            <span className="text-ui text-muted-foreground">
              Frontier models are on <span className="font-medium text-foreground">Pro</span>.
            </span>
            <span className="font-mono text-caption text-primary-ink">Upgrade →</span>
          </button>
        )}

        <div className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto md:snap-none md:overflow-x-visible">
          {/* Pane 1: rail + list */}
          <div className="flex w-full shrink-0 snap-start md:w-auto md:flex-1 md:shrink">
            {/* Provider rail */}
            <div className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border/50 bg-sidebar p-2.5">
              <RailTile active={filter === "all"} title="All providers" onClick={() => setFilter("all")}>
                <LayoutGrid className="size-4" />
              </RailTile>
              <div className="my-0.5 h-px w-5 shrink-0 bg-border/70" />
              {PROVIDER_LIST.map((p) => (
                <RailTile
                  key={p}
                  active={filter === p}
                  dimmed={!configuredProviders.has(p)}
                  title={PROVIDERS[p].label}
                  onClick={() => setFilter(p)}
                >
                  <ProviderLogo provider={p} className="size-4.5" />
                </RailTile>
              ))}
            </div>

            {/* List */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="border-b border-border/50 p-2">
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setHoveredId(null);
                    }}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Search models…"
                    aria-label="Search models"
                    aria-controls="model-picker-list"
                    aria-activedescendant={hoveredId ? `model-row-${hoveredId}` : undefined}
                    autoFocus
                    className="surface-inset h-8 w-full rounded-control border border-input pl-8 pr-2 text-xs outline-none transition-[border-color] duration-base ease-out-soft placeholder:text-muted-foreground focus:border-foreground/60"
                  />
                </label>
              </div>
              <ScrollFade className="min-h-0 flex-1 overflow-y-auto" viewportClassName="p-2 space-y-3">
                <div id="model-picker-list" role="listbox" aria-label="Models" className="space-y-3">
                  {providerFilter && !filterConfigured ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                      <ProviderLogo provider={providerFilter} className="size-8" />
                      <p className="text-sm font-medium">{PROVIDERS[providerFilter].label}</p>
                      <p className="text-xs text-muted-foreground">
                        Add{" "}
                        <span className="font-mono text-primary-ink">{PROVIDERS[providerFilter].apiKeyEnv}</span>{" "}
                        in Settings to enable these models.
                      </p>
                    </div>
                  ) : visible.length === 0 && !showAutoRow ? (
                    <p className="px-2 py-10 text-center text-xs text-muted-foreground">No models found.</p>
                  ) : (
                    <>
                      {recentItems.length > 0 && (
                        <div className="space-y-0.5">
                          <GroupLabel>Recently used</GroupLabel>
                          {recentItems.map((m) => renderRow(m, "recent:"))}
                        </div>
                      )}
                      {MODALITY_GROUPS.map((g) => {
                        const items = visible.filter((m) => (m.modality ?? "chat") === g.key);
                        if (items.length === 0 && !(g.key === "chat" && showAutoRow)) return null;
                        const standardItems = items.filter((m) => !m.legacy);
                        const legacyItems = items.filter((m) => m.legacy);
                        return (
                          <div key={g.key} className="space-y-0.5">
                            <GroupLabel>{g.label}</GroupLabel>
                            {g.key === "chat" && showAutoRow && renderRow(AUTO_MODEL_INFO)}
                            {standardItems.map((m) => renderRow(m))}
                            {legacyItems.length > 0 && (
                              <details key={q ? "open" : "closed"} open={!!q} className="group/legacy pt-1">
                                <summary className="flex cursor-pointer items-center justify-between rounded-control px-2.5 py-1.5 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent/50">
                                  <span>Past models · {legacyItems.length}</span>
                                  <ChevronDown className="size-3 transition-transform duration-base group-open/legacy:rotate-180" />
                                </summary>
                                <div className="space-y-0.5 pt-0.5">{legacyItems.map((m) => renderRow(m))}</div>
                              </details>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </ScrollFade>
            </div>
          </div>

          {/* Pane 2: the spec sheet */}
          <ModelDetailPanel
            model={hoveredModel}
            reasoningEffort={reasoningEffort}
            onCommit={(effort) => {
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
