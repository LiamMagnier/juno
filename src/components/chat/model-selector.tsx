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
  Star,
  Video,
  Zap,
} from "lucide-react";
import { ComposerIcons, StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { resolveModel, type ModelId, type ModelInfo, type Modality } from "@/lib/models";
import { AUTO_MODEL_ID, AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { PLANS, planRank, effectiveMinPlan } from "@/lib/plans";
import { useApp } from "@/components/app/app-provider";
import { useSettingsSave } from "@/components/settings/use-settings-save";
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

type Filter = "all" | "favorites" | Provider;

/**
 * The model picker: lab rail · list · spec sheet.
 *
 * Three panes, 760×520, clamped to the viewport. The RAIL on the left is one
 * mark per configured lab (plus All and Favorites); pick one and the LIST
 * shows that lab's models arranged by what they make — Text, then Image,
 * then Video — newest and strongest first, with superseded generations
 * folded behind "Past models". Hover or arrow onto a row and the SPEC SHEET
 * on the right fills in: intelligence, speed, context and cost as ten-segment
 * bars, the capability chips, the exact price per million tokens, and a
 * "Use this model" button. A row itself stays small — mark, name, one-line
 * description, price — so the list scans; everything else is the sheet's.
 *
 * Favorites are persisted to the account and lead the All view; the star on
 * a row toggles them. Recents stay per browser, like a draft. Auto leads All
 * as Juno's recommendation. Thinking effort is not in here: it is its own
 * chip on the composer.
 */

/** Most recently chosen models, newest first. Per browser, like a draft. */
const RECENT_KEY = "juno:models:recent";
const RECENT_MAX = 3;
/** Below this many rows the list is the answer; a "Recent" copy only pads it. */
const RECENT_MIN_LIST = 8;

const MODALITY_ORDER: Modality[] = ["chat", "image", "video"];
const MODALITY_LABEL: Record<Modality, string> = { chat: "Text", image: "Image", video: "Video" };

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

function isFastModel(m: ModelInfo) {
  return getModelMetrics(m).speed >= 8;
}

/** "Anthropic · Claude" → "Anthropic". */
function providerName(p: Provider): string {
  return PROVIDERS[p]?.label.split(" · ")[0] ?? p;
}

function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

/** Released within the last ~75 days: worth a quiet "New". */
function isNew(m: ModelInfo): boolean {
  if (!m.released) return false;
  const [y, mo] = m.released.split("-").map(Number);
  if (!y || !mo) return false;
  return Date.now() - Date.UTC(y, mo - 1, 1) < 75 * 24 * 60 * 60 * 1000;
}

/** "$3 · $15" — input and output per million tokens, or "Free". */
function priceLabel(m: ModelInfo): string {
  const metrics = getModelMetrics(m);
  if (metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0) return "Free";
  return `${formatPrice(metrics.inputUsdPerMTok)} · ${formatPrice(metrics.outputUsdPerMTok)}`;
}

/** The second line of a row: the description, or the facts when there is none. */
function rowCaption(m: ModelInfo): string {
  if (m.description) return m.description;
  const metrics = getModelMetrics(m);
  return [
    m.modality === "chat" && metrics.contextTokens ? `${formatContext(metrics.contextTokens)} context` : null,
    m.reasoning ? "Thinking" : null,
    m.vision ? "Vision" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A section label over a group of rows. aria-hidden: the group carries it. */
function GroupLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div aria-hidden className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 font-mono text-caption text-muted-foreground first:pt-1">
      <span>{children}</span>
      {count != null && <span className="tabular-nums text-muted-foreground/60">{count}</span>}
    </div>
  );
}

/** A modality heading inside a lab — Text / Image / Video with its own mark. */
function ModalityLabel({ modality, count }: { modality: Modality; count: number }) {
  const Icon = modality === "image" ? ImageIcon : modality === "video" ? Video : null;
  return (
    <div aria-hidden className="flex items-center gap-1.5 px-2.5 pb-1 pt-3 font-mono text-caption text-muted-foreground first:pt-1">
      {Icon && <Icon className="size-3" />}
      <span>{MODALITY_LABEL[modality]}</span>
      <span className="tabular-nums text-muted-foreground/60">{count}</span>
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
              "h-2.5 w-full rounded-full transition-colors duration-base ease-out-soft",
              i < value ? "bg-primary" : "bg-secondary",
            )}
            aria-hidden
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityChip({ icon: Icon, label }: { icon: typeof Brain; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-micro leading-none text-muted-foreground">
      <Icon className="size-2.5 text-muted-foreground/80" />
      <span>{label}</span>
    </span>
  );
}

/**
 * The spec sheet. A fixed 272px column with its own scroll; the "Use this
 * model" button is pinned at the foot so it is reachable however long the
 * description runs.
 */
function DetailPanel({
  model,
  selected,
  locked,
  starred,
  onUse,
  onToggleStar,
}: {
  model: ModelInfo | null;
  selected: boolean;
  locked: boolean;
  starred: boolean;
  onUse: () => void;
  onToggleStar: () => void;
}) {
  const shell = "hidden w-[272px] shrink-0 flex-col border-l border-border bg-background/60 md:flex";

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
          Routes each message to the <span className="font-medium text-foreground">best model</span> and{" "}
          <span className="font-medium text-foreground">thinking depth</span> for speed, intelligence and cost.
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
        <p className="border-t border-border pt-3 text-caption leading-snug text-muted-foreground/80">
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
    const hasChips = model.vision || model.reasoning || model.webSearch || isFastModel(model) || generative;
    body = (
      <>
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-semibold leading-tight tracking-tight">{model.name}</h3>
            <div className="flex size-7 shrink-0 items-center justify-center rounded-control border border-border bg-background">
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
            <span>{model.retiresOn ? `Available until ${formatRetirementDate(model.retiresOn)}` : "Retiring soon"}</span>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">{model.description ?? "Capable foundation model."}</p>

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

        <div className="space-y-2 border-t border-border pt-2.5">
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

        <div className="border-t border-border pt-2.5">
          <div className="mb-0.5 font-mono text-micro text-muted-foreground">Pricing per million tokens</div>
          {free ? (
            <p className="text-xs font-semibold">Free</p>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-1 text-xs tabular-nums">
              <span className="font-semibold">{formatPrice(metrics.inputUsdPerMTok)}</span>
              <span className="text-caption text-muted-foreground">in</span>
              <span className="text-muted-foreground/50" aria-hidden>·</span>
              <span className="font-semibold">{formatPrice(metrics.outputUsdPerMTok)}</span>
              <span className="text-caption text-muted-foreground">out</span>
            </p>
          )}
          {locked && (
            <p className="mt-1 text-caption text-muted-foreground">Requires the {PLANS[effectiveMinPlan(model.minPlan)].name} plan.</p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={shell}>
      <div key={model.id} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 motion-safe:animate-fade-in">
        {body}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-3">
        <Button type="button" size="sm" className="min-w-0 flex-1" disabled={soon || selected} onClick={onUse}>
          {useLabel}
        </Button>
        {!auto && !soon && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-pressed={starred}
                aria-label={starred ? "Remove from favorites" : "Add to favorites"}
                onClick={onToggleStar}
                className={cn(starred && "text-primary")}
              >
                <Star className={cn("size-3.5", starred && "fill-current")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{starred ? "Remove from favorites" : "Add to favorites"}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * A 32px flat tile on the lab rail. The selected one is the tonal fill with
 * the accent hairline; the rest are bare marks that take the fill on hover.
 */
function RailTile({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
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
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}

/** One group of rows in the list, with its past generations folded away. */
type Group = { key: string; label: string; models: ModelInfo[]; legacy: ModelInfo[]; byModality: boolean };

/** Text → image → video, then the catalog's own order (generation, date, power). */
function sortByModality<T extends ModelInfo>(models: T[]): T[] {
  return [...models].sort(
    (a, b) => MODALITY_ORDER.indexOf(a.modality ?? "chat") - MODALITY_ORDER.indexOf(b.modality ?? "chat"),
  );
}

/** The row key: a model can appear in Favorites, Recent AND its lab, and each copy is its own row. */
function rowKeyFor(prefix: string, id: string) {
  return `${prefix}${id}`;
}

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
  const { quota, models, settings } = useApp();
  const save = useSettingsSave();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  /** The row under the cursor (pointer or arrow keys), by ROW key. */
  const [cursorKey, setCursorKey] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);
  const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

  React.useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    setQuery("");
    setCursorKey(null);
  }, [open]);

  const favorites = React.useMemo(() => new Set(settings.favoriteModels ?? []), [settings.favoriteModels]);
  const toggleFavorite = (id: string) => {
    const next = favorites.has(id)
      ? (settings.favoriteModels ?? []).filter((m) => m !== id)
      : [...(settings.favoriteModels ?? []), id];
    void save({ favoriteModels: next });
  };

  const current = isAutoModelId(value) ? AUTO_MODEL_INFO : (models.find((m) => m.id === value) ?? resolveModel(value));
  const q = query.trim().toLowerCase();
  const autoSelected = isAutoModelId(value);

  const providerFilter = filter !== "all" && filter !== "favorites" ? (filter as Provider) : null;
  // The live model endpoint is authoritative for provider availability: a lab
  // with no key is not on the rail at all.
  const configuredProviders = React.useMemo(
    () => PROVIDER_LIST.filter((p) => models.some((model) => model.provider === p)),
    [models],
  );

  // Typing searches across every lab: a query clears the rail's filter rather
  // than searching inside one lab.
  const visible: ModelInfo[] = React.useMemo(
    () =>
      sortModelsForDisplay(
        models
          .filter((m) => (modelFilter ? modelFilter(m) : true))
          .filter((m) => (providerFilter && !q ? m.provider === providerFilter : true))
          .filter((m) => (filter === "favorites" && !q ? favorites.has(m.id) : true))
          .filter(
            (m) =>
              !q ||
              m.name.toLowerCase().includes(q) ||
              m.providerModel.toLowerCase().includes(q) ||
              (m.family ?? "").toLowerCase().includes(q) ||
              (m.description ?? "").toLowerCase().includes(q) ||
              m.modality.includes(q) ||
              (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q),
          ),
      ),
    [models, modelFilter, providerFilter, filter, favorites, q],
  );

  const showAutoRow =
    (filter === "all" || !!q) &&
    (modelFilter ? modelFilter(AUTO_MODEL_INFO) : true) &&
    (!q || ["auto", "cheap", "route", "smart", "default", "recommended"].some((w) => w.includes(q)));

  /**
   * In the All view: Favorites, then Recent (only when the list is long enough
   * that they save a scroll), then one group per lab. In a lab's view: that
   * lab alone, its rows arranged by modality. Superseded generations fold
   * behind "Past models" in every group.
   */
  const groups = React.useMemo<Group[]>(() => {
    const out: Group[] = [];
    const starred = filter === "all" && !q ? visible.filter((m) => favorites.has(m.id)) : [];
    if (starred.length) out.push({ key: "favorites:", label: "Favorites", models: sortByModality(starred), legacy: [], byModality: false });
    if (filter === "all" && !q && visible.length >= RECENT_MIN_LIST) {
      const seen = new Set(starred.map((m) => m.id));
      const rows = recent.map((id) => visible.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m && !seen.has(m.id));
      if (rows.length) out.push({ key: "recent:", label: "Recent", models: rows, legacy: [], byModality: false });
    }
    for (const p of PROVIDER_LIST) {
      const mine = visible.filter((m) => m.provider === p);
      if (!mine.length) continue;
      out.push({
        key: "",
        label: providerName(p),
        models: sortByModality(mine.filter((m) => !m.legacy)),
        legacy: sortByModality(mine.filter((m) => m.legacy)),
        byModality: true,
      });
    }
    return out;
  }, [visible, recent, favorites, filter, q]);

  /** Every row in render order, by row key, with the model each stands for. */
  const { order, byKey } = React.useMemo(() => {
    const order: string[] = [];
    const byKey = new Map<string, ModelInfo>();
    const push = (prefix: string, m: ModelInfo) => {
      const key = rowKeyFor(prefix, m.id);
      order.push(key);
      byKey.set(key, m);
    };
    if (showAutoRow) push("", AUTO_MODEL_INFO);
    for (const g of groups) {
      for (const m of g.models) push(g.key, m);
      if (q) for (const m of g.legacy) push(g.key, m);
    }
    return { order, byKey };
  }, [groups, showAutoRow, q]);

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
      const m = byKey.get(cursorKey ?? order[0]);
      if (m) select(m);
      return;
    }
    e.preventDefault();
    const at = cursorKey ? order.indexOf(cursorKey) : -1;
    const next = e.key === "ArrowDown" ? order[(at + 1) % order.length] : order[(at - 1 + order.length) % order.length];
    setCursorKey(next);
    rowRefs.current.get(next)?.scrollIntoView({ block: "nearest" });
  };

  /** The model the spec sheet shows: the row under the cursor, else the current one. */
  const sheetModel: ModelInfo | null = (cursorKey && byKey.get(cursorKey)) || current || null;

  const renderRow = (m: ModelInfo, prefix: string) => {
    const key = rowKeyFor(prefix, m.id);
    const auto = isAutoModelId(m.id);
    const active = auto ? autoSelected : value === m.id;
    const soon = !!m.comingSoon;
    const locked = isLocked(m);
    const cursor = cursorKey === key;
    const deprecated = m.status === "deprecated";
    const caption = auto ? "Picks the best model and thinking depth for each message." : rowCaption(m);
    const trailing = soon ? "Soon" : locked ? PLANS[effectiveMinPlan(m.minPlan)].name : auto ? "" : priceLabel(m);

    return (
      <button
        key={key}
        ref={(el) => {
          if (el) rowRefs.current.set(key, el);
          else rowRefs.current.delete(key);
        }}
        id={`model-row-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`}
        type="button"
        role="option"
        aria-selected={active}
        disabled={soon}
        onMouseEnter={() => setCursorKey(key)}
        onFocus={() => setCursorKey(key)}
        onClick={() => select(m)}
        data-cursor={cursor ? "" : undefined}
        className={cn(
          // Flat at rest; the cursor (pointer or arrow keys) lays the tonal
          // fill. Selection is the check on the right, not a second fill.
          "flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left outline-none transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          cursor ? "bg-accent" : "hover:bg-accent",
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {auto ? <JunoMark className="size-4" /> : <ProviderLogo provider={m.provider} className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium text-foreground">{m.name}</span>
            {auto && (
              <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-px font-mono text-micro font-medium text-primary-ink">
                Recommended
              </span>
            )}
            {!auto && favorites.has(m.id) && <Star aria-label="Favorite" className="size-3 shrink-0 fill-current text-primary" />}
            {!auto && isNew(m) && (
              <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px font-mono text-micro font-medium text-muted-foreground">
                New
              </span>
            )}
            {deprecated && (
              <span title={m.deprecationNote ?? "Deprecated by the provider"} className="shrink-0 font-mono text-micro text-warning-foreground">
                {m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
              </span>
            )}
          </span>
          {caption && <span className="block truncate text-caption text-muted-foreground">{caption}</span>}
        </span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{trailing}</span>
        <span className="flex w-4 shrink-0 items-center justify-center">
          {active && <StatusIcons.success className="size-3.5 text-primary" />}
        </span>
      </button>
    );
  };

  /** A group's rows, with a Text / Image / Video heading each time the modality changes. */
  const renderRows = (list: ModelInfo[], prefix: string, byModality: boolean) => {
    if (!byModality) return list.map((m) => renderRow(m, prefix));
    const out: React.ReactNode[] = [];
    let last: Modality | null = null;
    for (const m of list) {
      const modality = m.modality ?? "chat";
      if (modality !== last) {
        const count = list.filter((x) => (x.modality ?? "chat") === modality).length;
        out.push(<ModalityLabel key={`${prefix}label:${modality}`} modality={modality} count={count} />);
      }
      last = modality;
      out.push(renderRow(m, prefix));
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
          <span key={current?.id ?? "no-model"} aria-hidden="true" className="min-w-0 truncate motion-safe:animate-fade-in max-[359px]:hidden">
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
        // Fixed 760×520, clamped to the viewport by Radix's available-height
        // var and a 16px margin on every side (collisionPadding does the
        // horizontal clamp by shifting the box, never by clipping it).
        style={{
          width: "min(760px, calc(100vw - 2rem))",
          height: "min(520px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 48px, folds under `sm`. Only configured labs. */}
          <div className="hidden w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border p-2 sm:flex">
            <RailTile active={filter === "all"} title="All labs" onClick={() => setFilter("all")}>
              <LayoutGrid className="size-4" />
            </RailTile>
            <RailTile active={filter === "favorites"} title="Favorites" onClick={() => setFilter("favorites")}>
              <Star className={cn("size-4", filter === "favorites" && "fill-current")} />
            </RailTile>
            <div className="my-1 h-px w-5 shrink-0 bg-border" />
            {configuredProviders.map((p) => (
              <RailTile key={p} active={filter === p} title={providerName(p)} onClick={() => setFilter(p)}>
                <ProviderLogo provider={p} className="size-4" />
              </RailTile>
            ))}
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border p-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursorKey(null);
                  }}
                  placeholder={providerFilter ? `Search ${providerName(providerFilter)} models…` : "Search models…"}
                  aria-label="Search models"
                  role="combobox"
                  aria-expanded
                  aria-controls="model-picker-list"
                  aria-activedescendant={cursorKey ? `model-row-${cursorKey.replace(/[^A-Za-z0-9_-]/g, "_")}` : undefined}
                  autoFocus
                  className="h-8 w-full rounded-control bg-transparent pl-8 pr-2 text-ui outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
            <ScrollFade className="min-h-0 flex-1 overflow-y-auto" viewportClassName="p-1.5">
              <div id="model-picker-list" role="listbox" aria-label="Models">
                {visible.length === 0 && !showAutoRow ? (
                  <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                    <p className="text-ui font-medium text-foreground">
                      {filter === "favorites" && !q ? "No favorites yet" : "No models found"}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {filter === "favorites" && !q
                        ? "Open a model and press the star to keep it here."
                        : "Try another name, lab or capability."}
                    </p>
                  </div>
                ) : (
                  <>
                    {showAutoRow && (
                      <div role="group" aria-label="Juno">
                        {renderRow(AUTO_MODEL_INFO, "")}
                      </div>
                    )}
                    {groups.map((g) => (
                      <div key={g.key || g.label} role="group" aria-label={g.label}>
                        {/* One lab in view: the modality headings carry the list, no lab label above them. */}
                        {!(providerFilter && !q && g.byModality) && <GroupLabel count={g.byModality ? undefined : g.models.length}>{g.label}</GroupLabel>}
                        {renderRows(g.models, g.key, g.byModality)}
                        {g.legacy.length > 0 && (
                          <details key={q ? "open" : "closed"} open={!!q} className="group/legacy pt-0.5">
                            <summary className="flex h-8 cursor-pointer list-none items-center justify-between rounded-control px-2.5 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent [&::-webkit-details-marker]:hidden">
                              <span>Past models · {g.legacy.length}</span>
                              <ChevronDown className="size-3 transition-transform duration-base group-open/legacy:rotate-180" />
                            </summary>
                            <div className="pt-0.5">{renderRows(g.legacy, `${g.key}legacy:`, g.byModality)}</div>
                          </details>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </ScrollFade>
          </div>

          {/* Spec sheet — 272px, folds under `md`. */}
          <DetailPanel
            model={sheetModel}
            selected={!!sheetModel && (isAutoModelId(sheetModel.id) ? autoSelected : value === sheetModel.id)}
            locked={!!sheetModel && isLocked(sheetModel)}
            starred={!!sheetModel && favorites.has(sheetModel.id)}
            onUse={() => sheetModel && select(sheetModel)}
            onToggleStar={() => sheetModel && toggleFavorite(sheetModel.id)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
