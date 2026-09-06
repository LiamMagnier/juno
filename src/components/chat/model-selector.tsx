"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  ChevronDown,
  Eye,
  Image as ImageIcon,
  LayoutGrid,
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
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo, type Modality } from "@/lib/models";
import {
  AUTO_MODEL_ID,
  AUTO_MODEL_INFO,
  isAutoModelId,
} from "@/lib/auto-model";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { PLANS, planRank, effectiveMinPlan } from "@/lib/plans";
import { useApp } from "@/components/app/app-provider";
import {
  contextScore,
  expensivenessScore,
  formatContext,
  formatPrice,
  getModelMetrics,
  hasLiveBenchmark,
  sortModelsForDisplay,
} from "@/lib/model-metrics";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

type Filter = "all" | Provider;

/**
 * The model picker: lab rail · list · detail panel.
 *
 * A 760×480 float above the composer chip, clamped to the viewport with a
 * 16px margin and never clipped. The list is grouped by AI lab in the rail's
 * order; inside a lab the rows run text → image → video, newest and strongest
 * generation first (the catalog's canonical order), with superseded
 * generations folded behind "Past models". A row is deliberately small — a
 * mark, a name, a modality tag when it is not a text model, and a price
 * glyph — because everything else about a model lives in the detail panel on
 * the right: description, capabilities, the four metric bars, pricing.
 * Thinking effort is not in here at all; it is its own chip on the composer.
 */

/** Most recently chosen models, newest first. Per browser, like a draft. */
const RECENT_KEY = "juno:models:recent";
const RECENT_MAX = 3;
/** Below this many rows the list is the answer; a "Recent" copy only pads it. */
const RECENT_MIN_LIST = 8;

const MODALITY_ORDER: Modality[] = ["chat", "image", "video"];

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

/** "Anthropic · Claude" → "Anthropic". */
function providerName(p: Provider): string {
  return PROVIDERS[p]?.label.split(" · ")[0] ?? p;
}

function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

/** Text → image → video, then the catalog's own order (generation, date, power). */
function sortByModality<T extends ModelInfo>(models: T[]): T[] {
  return [...models].sort(
    (a, b) => MODALITY_ORDER.indexOf(a.modality ?? "chat") - MODALITY_ORDER.indexOf(b.modality ?? "chat"),
  );
}

/** A lab label over a group of rows. aria-hidden: the group carries it. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="px-2.5 pb-1 pt-2.5 font-mono text-caption text-muted-foreground">
      {children}
    </div>
  );
}

/** A modality divider inside a lab: "Image" / "Video" with its own mark. */
function ModalityLabel({ modality }: { modality: Modality }) {
  const Icon = modality === "image" ? ImageIcon : Video;
  const label = modality === "image" ? "Image" : "Video";
  return (
    <div aria-hidden className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 font-mono text-micro text-muted-foreground/80">
      <Icon className="size-3" />
      {label}
    </div>
  );
}

/**
 * Ten segments, filled in the brand accent. Not the provider's accent: OpenAI's
 * is near-black, which on the dark ground made a filled bar and an empty one
 * the same colour.
 */
function MetricBars({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-micro text-muted-foreground">{label}</span>
        <span className="font-mono text-micro tabular-nums text-muted-foreground/70">{value}/10</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-3 w-full rounded-full ring-1 ring-inset ring-foreground/10 transition-colors duration-base ease-out-soft",
              i < value ? "bg-primary" : "bg-muted",
            )}
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
    <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/25 px-1.5 py-0.5 text-micro leading-none text-muted-foreground">
      <Icon className="size-2.5 text-muted-foreground/80" />
      <span>{label}</span>
    </span>
  );
}

/**
 * The detail panel. A fixed 272px column with its own scroll; the "Use this
 * model" button is pinned at the foot so it is reachable however long the
 * description runs.
 */
function DetailPanel({
  model,
  selected,
  locked,
  onUse,
}: {
  model: ModelInfo | null;
  selected: boolean;
  locked: boolean;
  onUse: () => void;
}) {
  const shell = "hidden w-[272px] shrink-0 flex-col border-l border-border/50 bg-card/70 md:flex";

  if (!model) {
    return (
      <div className={cn(shell, "items-center justify-center p-5")}>
        <p className="text-center text-caption text-muted-foreground">
          Hover a model to compare intelligence, speed, context and cost.
        </p>
      </div>
    );
  }

  const auto = isAutoModelId(model.id);
  const soon = !!model.comingSoon;
  const useLabel = soon
    ? "Coming soon"
    : locked
      ? `Upgrade to ${PLANS[effectiveMinPlan(model.minPlan)].name}`
      : selected
        ? "Current model"
        : auto
          ? "Use Auto"
          : "Use this model";

  let body: React.ReactNode;
  if (auto) {
    body = (
      <>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold leading-tight tracking-tight">Auto</h3>
            <span className="mt-1 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-micro font-semibold text-primary-ink">
              Recommended
            </span>
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary/15 text-primary">
            <JunoMark className="size-4.5" />
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Routes each message to the{" "}
          <span className="font-medium text-foreground">optimal model</span> and{" "}
          <span className="font-medium text-foreground">thinking depth</span> for
          speed, intelligence and cost.
        </p>
        <ul className="space-y-2 text-label leading-snug text-muted-foreground">
          <li className="flex gap-2">
            <span className="font-mono font-bold text-primary-ink">1</span>
            Everyday prompt → Fast models · Instant
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-primary-ink">2</span>
            Coding & analysis → Mid tier · Balanced
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-primary-ink">3</span>
            Deep reasoning → Flagship · Deep thinking
          </li>
        </ul>
        <p className="border-t border-border/40 pt-3 text-caption leading-snug text-muted-foreground/80">
          Respects your plan limits, image needs, and web search settings.
        </p>
      </>
    );
  } else {
    const metrics = getModelMetrics(model);
    const free = metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0;
    const generative = model.modality === "image" || model.modality === "video";
    const bars = generative
      ? [
          { label: "Quality", value: metrics.intelligence },
          { label: "Speed", value: metrics.speed },
          { label: "Cost", value: expensivenessScore(metrics) },
        ]
      : [
          { label: "Intelligence", value: metrics.intelligence },
          { label: "Speed", value: metrics.speed },
          { label: "Context", value: contextScore(metrics.contextTokens) },
          { label: "Cost", value: expensivenessScore(metrics) },
        ];
    const hasChips =
      model.vision || model.reasoning || model.webSearch || isFastModel(model) || generative;
    body = (
      <>
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-semibold leading-tight tracking-tight">{model.name}</h3>
            <div className="flex size-7 shrink-0 items-center justify-center rounded-control border border-border/60 bg-muted/40">
              <ProviderLogo provider={model.provider} className="size-4" />
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-muted-foreground">
            <span>{providerName(model.provider)}</span>
            {!generative && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">{formatContext(metrics.contextTokens)} context</span>
              </>
            )}
            {model.released && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">{model.released}</span>
              </>
            )}
          </div>
        </div>

        {model.status === "deprecated" && (
          <div className="flex items-start gap-1.5 rounded-control border border-warning/40 bg-warning/10 px-2 py-1.5 text-caption font-medium text-warning-foreground">
            <StatusIcons.warning className="mt-0.5 size-3 shrink-0" />
            <span>
              {model.retiresOn ? `Available until ${formatRetirementDate(model.retiresOn)}` : "Retiring soon"}
            </span>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          {model.description ?? "Capable foundation model."}
        </p>

        {hasChips && (
          <div className="flex flex-wrap gap-1">
            {model.modality === "image" && <CapabilityChip icon={ImageIcon} label="Image" />}
            {model.modality === "video" && <CapabilityChip icon={Video} label="Video" />}
            {model.vision && <CapabilityChip icon={Eye} label="Vision" />}
            {model.reasoning && <CapabilityChip icon={Brain} label="Thinking" />}
            {model.webSearch && <CapabilityChip icon={ComposerIcons.web} label="Search" />}
            {/* Raw `Zap`. This bolt is SPEED, not the Juno Work destination. */}
            {isFastModel(model) && <CapabilityChip icon={Zap} label="Fast" />}
          </div>
        )}

        <div className="space-y-2 border-t border-border/40 pt-2.5">
          {bars.map((b) => (
            <MetricBars key={b.label} label={b.label} value={b.value} />
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
          <div className="mb-0.5 font-mono text-micro text-muted-foreground">Pricing</div>
          {free ? (
            <p className="text-xs font-semibold">Free</p>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-1 text-xs tabular-nums">
              <span className="font-semibold">{formatPrice(metrics.inputUsdPerMTok)}</span>
              <span className="text-caption text-muted-foreground">in</span>
              <span className="text-muted-foreground/50" aria-hidden>·</span>
              <span className="font-semibold">{formatPrice(metrics.outputUsdPerMTok)}</span>
              <span className="text-caption text-muted-foreground">out / MTok</span>
            </p>
          )}
          {locked && (
            <p className="mt-1 text-caption text-muted-foreground">
              Requires the {PLANS[effectiveMinPlan(model.minPlan)].name} plan.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={shell}>
      <div key={model.id} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {body}
      </div>
      <div className="shrink-0 border-t border-border/50 p-3">
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={soon || selected}
          onClick={onUse}
        >
          {useLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A 32px flat tile on the lab rail. The selected one is the coral hairline
 * over the accent fill, the rest are bare marks that take the fill on hover.
 */
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          aria-pressed={active}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-control transition-[background-color,color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
            active
              ? "bg-accent text-foreground ring-1 ring-inset ring-primary/60"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            dimmed && "opacity-40",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}

/** One lab's rows: current models (already text → image → video) and its past ones. */
type Group = { key: string; label: string; models: ModelInfo[]; legacy: ModelInfo[] };

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const { quota, models } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [cursorId, setCursorId] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);
  const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

  React.useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    setQuery("");
    setCursorId(null);
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

  // Typing filters across every lab: a query clears the rail's filter rather
  // than searching inside one lab.
  const visible: ModelInfo[] = React.useMemo(
    () =>
      sortModelsForDisplay(
        models
          .filter((m) => (modelFilter ? modelFilter(m) : true))
          .filter((m) => (providerFilter && !q ? m.provider === providerFilter : true))
          .filter(
            (m) =>
              !q ||
              m.name.toLowerCase().includes(q) ||
              m.providerModel.toLowerCase().includes(q) ||
              (m.family ?? "").toLowerCase().includes(q) ||
              m.modality.includes(q) ||
              (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q),
          ),
      ),
    [models, modelFilter, providerFilter, q],
  );

  const showAutoRow =
    (filter === "all" || !!q) &&
    (modelFilter ? modelFilter(AUTO_MODEL_INFO) : true) &&
    (!q || ["auto", "cheap", "route", "smart", "default"].some((w) => w.includes(q)));

  /**
   * One group per lab, in the rail's order, whether the view is "All" or one
   * lab. Recents come first only in the unfiltered view, only up to three,
   * only when the list is long enough that they save a scroll, and never a
   * model already sitting in the first lab on screen.
   */
  const groups = React.useMemo<Group[]>(() => {
    const out: Group[] = [];
    for (const p of PROVIDER_LIST) {
      const mine = visible.filter((m) => m.provider === p);
      if (mine.length === 0) continue;
      out.push({
        key: p,
        label: providerName(p),
        models: sortByModality(mine.filter((m) => !m.legacy)),
        legacy: sortByModality(mine.filter((m) => m.legacy)),
      });
    }
    if (!q && filter === "all" && visible.length >= RECENT_MIN_LIST) {
      const firstGroup = new Set(out[0]?.models.map((m) => m.id) ?? []);
      const recents = recent
        .map((id) => visible.find((m) => m.id === id))
        .filter((m): m is ModelInfo => !!m && !m.comingSoon && !firstGroup.has(m.id))
        .slice(0, RECENT_MAX);
      if (recents.length > 0) out.unshift({ key: "recent", label: "Recent", models: recents, legacy: [] });
    }
    return out;
  }, [visible, filter, q, recent]);

  /** Every id in display order — the keyboard cursor walks this. */
  const order = React.useMemo(() => {
    const ids: string[] = [];
    if (showAutoRow) ids.push(AUTO_MODEL_ID);
    for (const g of groups) {
      for (const m of g.models) ids.push(m.id);
      if (q) for (const m of g.legacy) ids.push(m.id);
    }
    // A recent row and its lab row are distinct buttons, so an id may appear
    // twice; the cursor visits each once.
    return Array.from(new Set(ids));
  }, [showAutoRow, groups, q]);

  const sheetModel = React.useMemo(() => {
    if (cursorId === AUTO_MODEL_ID) return AUTO_MODEL_INFO;
    if (cursorId) return models.find((m) => m.id === cursorId) ?? null;
    return current ?? visible[0] ?? null;
  }, [cursorId, current, models, visible]);

  const isLocked = (m: ModelInfo) =>
    !isAutoModelId(m.id) && !m.comingSoon && planRank(plan) < planRank(effectiveMinPlan(m.minPlan));

  const select = (m: ModelInfo) => {
    if (disabled) return;
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      setOpen(false);
      return;
    }
    if (m.comingSoon) return;
    if (isLocked(m)) {
      setOpen(false);
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    onChange(m.id);
    setOpen(false);
  };

  /** ↑/↓ walk the list, Enter picks — from the search field or from a row. */
  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    if (order.length === 0) return;
    if (e.key === "Enter") {
      // A row is a button: its own click handles Enter.
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      const id = cursorId ?? order[0];
      const m = id === AUTO_MODEL_ID ? AUTO_MODEL_INFO : models.find((x) => x.id === id);
      if (m) select(m);
      return;
    }
    e.preventDefault();
    const at = cursorId ? order.indexOf(cursorId) : -1;
    const next =
      e.key === "ArrowDown"
        ? order[(at + 1) % order.length]
        : order[(at - 1 + order.length) % order.length];
    setCursorId(next);
    rowRefs.current.get(next)?.scrollIntoView({ block: "nearest" });
  };

  const renderRow = (m: ModelInfo, keyPrefix = "") => {
    const auto = isAutoModelId(m.id);
    const active = auto ? autoSelected : value === m.id;
    const soon = !!m.comingSoon;
    const locked = isLocked(m);
    const cursor = cursorId === m.id;
    const deprecated = m.status === "deprecated";

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
        onMouseEnter={() => setCursorId(m.id)}
        onFocus={() => setCursorId(m.id)}
        onClick={() => select(m)}
        data-cursor={cursor ? "" : undefined}
        className={cn(
          // Flat at rest. The cursor (pointer or arrow keys) lays the accent
          // fill; the SELECTED row is the fill plus a coral hairline. Both are
          // drawn with an inset ring so selection moves nothing.
          "group flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left outline-none transition-[background-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
          active
            ? "bg-accent ring-1 ring-inset ring-primary/60"
            : cursor
              ? "bg-accent"
              : "hover:bg-accent",
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {auto ? <JunoMark className="size-4" /> : <ProviderLogo provider={m.provider} className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
          {m.name}
          {auto && (
            <span className="ml-1.5 rounded-full bg-primary/12 px-1.5 py-px font-mono text-micro font-medium text-primary-ink">
              Smart
            </span>
          )}
        </span>
        {deprecated && (
          <span
            title={m.deprecationNote ?? "Deprecated by the provider"}
            className="shrink-0 font-mono text-micro text-warning-foreground"
          >
            {m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
          </span>
        )}
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
          {soon ? "Soon" : locked ? PLANS[effectiveMinPlan(m.minPlan)].name : auto ? "" : priceGlyph(m)}
        </span>
        {active && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
      </button>
    );
  };

  /** A lab's rows with a divider each time the modality changes. */
  const renderRows = (list: ModelInfo[], keyPrefix = "") => {
    const out: React.ReactNode[] = [];
    let lastModality: Modality | null = null;
    for (const m of list) {
      const modality = m.modality ?? "chat";
      if (modality !== "chat" && modality !== lastModality) {
        out.push(<ModalityLabel key={`${keyPrefix}label:${modality}`} modality={modality} />);
      }
      lastModality = modality;
      out.push(renderRow(m, keyPrefix));
    }
    return out;
  };

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model: ${current?.name ?? "Select model"}`}
          // The shared composer chip: flat text, accent fill on hover and while
          // open. The name is set in the UI face, not mono — it is a label on a
          // control, not a value in a table.
          className={cn(composerChipClass, "max-w-[9rem] px-2 sm:max-w-[16rem]")}
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
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions
        onKeyDown={onNavKeyDown}
        // Fixed 760×480, clamped to the viewport by Radix's available-height
        // var and a 16px margin on every side (collisionPadding does the
        // horizontal clamp by shifting the box, never by clipping it).
        style={{
          width: "min(760px, calc(100vw - 2rem))",
          height: "min(480px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 48px, folds under `sm`. */}
          <div className="hidden w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/50 p-2 sm:flex">
            <RailTile active={filter === "all"} title="All labs" onClick={() => setFilter("all")}>
              <LayoutGrid className="size-4" />
            </RailTile>
            <div className="my-1 h-px w-5 shrink-0 bg-border/70" />
            {PROVIDER_LIST.map((p) => (
              <RailTile
                key={p}
                active={filter === p}
                dimmed={!configuredProviders.has(p)}
                title={providerName(p)}
                onClick={() => setFilter(p)}
              >
                <ProviderLogo provider={p} className="size-4" />
              </RailTile>
            ))}
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/50 p-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursorId(null);
                  }}
                  placeholder="Search models…"
                  aria-label="Search models"
                  role="combobox"
                  aria-expanded
                  aria-controls="model-picker-list"
                  aria-activedescendant={cursorId ? `model-row-${cursorId}` : undefined}
                  autoFocus
                  className="surface-inset h-8 w-full rounded-control border border-input pl-8 pr-2 text-ui outline-none transition-[border-color] duration-base ease-out-soft placeholder:text-muted-foreground focus:border-foreground/60"
                />
              </label>
            </div>
            <ScrollFade className="min-h-0 flex-1 overflow-y-auto" viewportClassName="p-1.5">
              <div id="model-picker-list" role="listbox" aria-label="Models">
                {providerFilter && !q && !filterConfigured ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                    <ProviderLogo provider={providerFilter} className="size-8" />
                    <p className="text-ui font-medium">{PROVIDERS[providerFilter].label}</p>
                    <p className="text-caption text-muted-foreground">
                      Add{" "}
                      <span className="font-mono text-primary-ink">{PROVIDERS[providerFilter].apiKeyEnv}</span>{" "}
                      in Settings to enable these models.
                    </p>
                  </div>
                ) : visible.length === 0 && !showAutoRow ? (
                  <p className="px-2 py-10 text-center text-caption text-muted-foreground">No models found.</p>
                ) : (
                  <>
                    {showAutoRow && (
                      <div role="group" aria-label="Juno">
                        <GroupLabel>Juno</GroupLabel>
                        {renderRow(AUTO_MODEL_INFO)}
                      </div>
                    )}
                    {groups.map((g) => (
                      <div key={g.key} role="group" aria-label={g.label}>
                        <GroupLabel>{g.label}</GroupLabel>
                        {renderRows(g.models, g.key === "recent" ? "recent:" : "")}
                        {g.legacy.length > 0 && (
                          <details key={q ? "open" : "closed"} open={!!q} className="group/legacy pt-0.5">
                            <summary className="flex h-8 cursor-pointer items-center justify-between rounded-control px-2.5 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent">
                              <span>Past models · {g.legacy.length}</span>
                              <ChevronDown className="size-3 transition-transform duration-base group-open/legacy:rotate-180" />
                            </summary>
                            <div className="pt-0.5">{renderRows(g.legacy)}</div>
                          </details>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </ScrollFade>
          </div>

          {/* Detail panel — 272px, folds under `md`. */}
          <DetailPanel
            model={sheetModel}
            selected={!!sheetModel && (isAutoModelId(sheetModel.id) ? autoSelected : value === sheetModel.id)}
            locked={!!sheetModel && isLocked(sheetModel)}
            onUse={() => sheetModel && select(sheetModel)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
