"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Lock,
  Search,
  SearchX,
  Star,
  X,
  type LucideIcon,
} from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  sortModelsForDisplay,
} from "@/lib/model-metrics";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

type Filter = "all" | "favorites" | Provider;

/**
 * The model control, in two stages.
 *
 * STAGE ONE is what the composer chip opens, and it is the only thing most
 * turns need: the model you are on, and how hard it should think. Effort is
 * the setting that changes between messages; which model you are using changes
 * a few times a day. Opening a 680px catalogue to move a slider was answering
 * the rare question first — ChatGPT's menu has the same shape for the same
 * reason.
 *
 * STAGE TWO is the catalogue, and the model row in stage one is its door: a
 * row carrying the current model with an arrow pointing UP, which is where the
 * bigger surface comes from. Two popovers rather than one with swapping
 * content, because the two sizes are far apart (a ~150px card against a 460px
 * panel) and a box that resizes by 300px under the pointer reads as a glitch.
 *
 * THE CATALOGUE IS THREE PANES: a 48px rail of lab marks (names in the
 * tooltip — see `RailTile`), a narrow column of MODEL NAMES, and a scrollable
 * detail panel. The names column is deliberately just names: a list you scan
 * for one you recognise, at one line each, so a lab's whole range is visible
 * without scrolling. Everything a choice actually turns on — how capable, how
 * fast, how much, what it can do, how much context — is in the panel beside
 * it, which fills in as the cursor moves and scrolls on its own.
 *
 * ONE ACCENT, AND IT IS ALWAYS STATE: the selected check, a filled star, the
 * focus edge. Nothing else here may be coral (FLAT_UI.md §2.4).
 *
 * Favorites persist to the account and lead the All view; recents stay per
 * browser, like a draft.
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

/** "Anthropic · Claude" → "Anthropic". */
function providerName(p: Provider): string {
  return PROVIDERS[p]?.label.split(" · ")[0] ?? p;
}

function formatRetirementDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}


/** "$3 · $15" — input and output per million tokens, or "Free". */
function priceLabel(m: ModelInfo): string {
  const metrics = getModelMetrics(m);
  if (metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0) return "Free";
  return `${formatPrice(metrics.inputUsdPerMTok)} · ${formatPrice(metrics.outputUsdPerMTok)}`;
}


/** Does this model answer the query? One predicate, so the rail's counts and
 *  the list can never disagree about what a search matches. */
function matchesQuery(m: ModelInfo, q: string): boolean {
  if (!q) return true;
  return (
    m.name.toLowerCase().includes(q) ||
    m.providerModel.toLowerCase().includes(q) ||
    (m.family ?? "").toLowerCase().includes(q) ||
    (m.description ?? "").toLowerCase().includes(q) ||
    m.modality.includes(q) ||
    (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q)
  );
}

/**
 * The one heading shape in the list: a mono word, a hairline running to the
 * right edge, and an optional count landing on the same x as the row prices.
 * It draws the lab groups, the modality groups and "Past models" alike —
 * three ad-hoc treatments used to draw what is one idea, a divider with a
 * name on it.
 */
function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div aria-hidden className="flex h-8 items-center gap-2 px-2 pt-1">
      <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/60">{children}</span>
      {count != null && (
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/45">{count}</span>
      )}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** A bare, centred empty state. Deliberately NOT `EmptyState`: that draws a
 *  dashed inset well, which is a second box inside a pane that has none. */
function EmptyBlock({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-8 py-14 text-center">
      <Icon aria-hidden className="size-5 text-muted-foreground/50" />
      <p className="text-ui font-medium text-foreground">{title}</p>
      <p className="text-caption text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

/**
 * One graded fact in the detail panel: the number, then a rule under it.
 *
 * The number is what a person reads; the rule is what lets four of them be
 * compared down a column without reading any. It is `bg-foreground/55` on
 * `bg-secondary` — over 3:1 in both themes — and never the accent, which in
 * this surface means "selected" and nothing else.
 */
function Stat({ label, value, unit, score }: { label: string; value: string; unit?: string; score: number }) {
  return (
    <div>
      <div className="font-mono text-micro uppercase text-muted-foreground/60">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-ui font-medium tabular-nums text-foreground">{value}</span>
        {unit && <span className="font-mono text-micro text-muted-foreground/60">{unit}</span>}
      </div>
      <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-secondary">
        {/* An inline width percentage: this is DATA, not a colour — the same
            precedent as the popover's own inline size below. */}
        <div
          aria-hidden
          className="h-full rounded-full bg-foreground/55 transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
          style={{ width: `${Math.max(0, Math.min(10, score)) * 10}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The detail panel: everything the names column deliberately does not say.
 *
 * It fills in from the cursor — pointer or arrow keys — and scrolls on its
 * own, so a long description never pushes the list around. Scroll resets on
 * model change rather than remounting the pane: a `key` here re-faded 300px of
 * column on every arrow keypress, which flickers when you hold the key down
 * and prevents the meters from ever animating.
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
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const modelId = model?.id;
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [modelId]);

  const shell = "hidden w-[268px] shrink-0 flex-col border-l border-border/70 md:flex";
  if (!model) {
    return (
      <div className={cn(shell, "items-center justify-center p-5")}>
        <p className="text-center text-caption text-muted-foreground">Point at a model to see what it does.</p>
      </div>
    );
  }

  const auto = isAutoModelId(model.id);
  const metrics = getModelMetrics(model);
  const caps = [
    model.vision ? "Vision" : null,
    model.reasoning ? "Thinking" : null,
    model.webSearch ? "Web search" : null,
    model.agenticTools ? "Tools" : null,
  ].filter((c): c is string => !!c);

  return (
    <div className={shell}>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <div className="flex items-center gap-2">
          {auto ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card">
              <JunoMark className="size-3" />
            </span>
          ) : (
            <ProviderLogo provider={model.provider} className="size-5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{model.name}</span>
        </div>
        <p className="mt-0.5 font-mono text-micro text-muted-foreground/60">
          {auto ? "Juno" : model.providerModel}
        </p>

        {model.description && (
          <p className="mt-3 text-caption leading-relaxed text-muted-foreground">{model.description}</p>
        )}

        {model.status === "deprecated" && (
          <p className="mt-3 text-caption text-warning">
            {model.deprecationNote ??
              (model.retiresOn ? `Retires ${formatRetirementDate(model.retiresOn)}` : "Deprecated by the provider")}
          </p>
        )}

        {!auto && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3.5">
              <Stat label="Intelligence" value={String(metrics.intelligence)} unit="/10" score={metrics.intelligence} />
              <Stat label="Speed" value={String(metrics.speed)} unit="/10" score={metrics.speed} />
              {model.modality === "chat" && metrics.contextTokens > 0 && (
                <Stat
                  label="Context"
                  value={formatContext(metrics.contextTokens)}
                  score={contextScore(metrics.contextTokens)}
                />
              )}
              {/* Inverted: the rule reads "how cheap", so a long bar is good news
                      on every row in the panel rather than on some of them. */}
              <Stat label="Cost" value={priceLabel(model)} score={11 - expensivenessScore(metrics)} />
            </div>

            {metrics.inputUsdPerMTok + metrics.outputUsdPerMTok > 0 && (
              <dl className="mt-4 space-y-1 font-mono text-micro tabular-nums text-muted-foreground">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="uppercase text-muted-foreground/60">In / MTok</dt>
                  <dd>{formatPrice(metrics.inputUsdPerMTok)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="uppercase text-muted-foreground/60">Out / MTok</dt>
                  <dd>{formatPrice(metrics.outputUsdPerMTok)}</dd>
                </div>
              </dl>
            )}

            {caps.length > 0 && (
              <p className="mt-4 font-mono text-micro uppercase leading-relaxed text-muted-foreground/70">
                {caps.join(" · ")}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-3 py-2.5">
        {/* The accent is an ACTION here, not a status. A full-width coral bar
            reading "Selected" spends the brand colour on the one state that
            needs no button at all — and invites a press that does nothing.
            Selected is a quiet, inert label; only "use this" and "upgrade to
            reach this" are things to press. */}
        <Button
          type="button"
          size="sm"
          variant={selected ? "secondary" : "default"}
          disabled={selected || !!model.comingSoon}
          onClick={onUse}
          className="min-w-0 flex-1"
        >
          {selected
            ? "Selected"
            : model.comingSoon
              ? "Not available yet"
              : locked
                ? `Get ${PLANS[effectiveMinPlan(model.minPlan)].name}`
                : "Use this model"}
        </Button>
        {!auto && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={starred ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={starred}
                onClick={onToggleStar}
              >
                <Star className={cn("size-3.5", starred && "fill-current text-primary")} />
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
 * One tile on the lab rail: the mark, and the name on hover.
 *
 * Named rows were tried and taken back out. They cost 168px of a 680px box —
 * a quarter of the surface spent on sixteen words a person reads once — and
 * the list is where the choosing happens. The objection to an icon rail is
 * real (a logo with no name is a memory test, and a tooltip delay on the
 * primary navigation of a surface is a bad trade), so the tooltip carries
 * MORE than the name did: the lab and how many models it has, which is the
 * count the named row printed at its right edge.
 *
 * Active is the tonal `bg-secondary` — the accent is reserved for the
 * selected MODEL, never for which lab you are browsing.
 */
function RailTile({
  active,
  label,
  count,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={count == null ? label : `${label}, ${count} models`}
          onClick={onClick}
          aria-pressed={active}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-control outline-none",
            "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {count != null && (
          <span className="ml-1.5 font-mono text-micro tabular-nums text-muted-foreground">{count}</span>
        )}
      </TooltipContent>
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

function rowDomId(key: string) {
  return `model-row-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
  disabled = false,
  thinking,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
  disabled?: boolean;
  /** The thinking-effort control for the chosen model, drawn as a footer
   *  under the panes. Omit it (or pass null) when the model has one effort. */
  thinking?: React.ReactNode;
}) {
  const router = useRouter();
  const { quota, models, settings } = useApp();
  const save = useSettingsSave();
  const plan = quota.plan;
  /** Stage one: the model + effort card the composer chip opens. */
  const [open, setOpen] = React.useState(false);
  /** Stage two: the catalogue, opened from stage one's model row. */
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  /** The row under the cursor (pointer or arrow keys), by ROW key. */
  const [cursorKey, setCursorKey] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);
  const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  /**
   * Whether the pointer has genuinely MOVED since the last arrow key.
   *
   * Without it the two cursors fight: ↓ scrolls a new row under a stationary
   * pointer, the browser replays a pointer event over it, and the keyboard
   * cursor is handed straight back. Arrow keys clear the flag; the first
   * genuine `pointermove` over the list sets it again.
   */
  const pointerActive = React.useRef(false);

  // The catalogue's transient state — the query, the cursor — resets when the
  // catalogue opens, not when the chip does: stage one has neither.
  React.useEffect(() => {
    if (!pickerOpen) return;
    setRecent(readRecent());
    setQuery("");
    setCursorKey(null);
    pointerActive.current = false;
  }, [pickerOpen]);

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

  /**
   * Everything this surface may offer, before the rail's own filter.
   *
   * Which labs the rail draws is decided from HERE — through `modelFilter`
   * (the caller's capability predicate) and the query, never through `filter`.
   * Reading it through `filter` would empty every lab but the picked one;
   * ignoring `modelFilter` is the bug that let the Work composer offer labs
   * whose every model it then refused to show.
   */
  const searchable = React.useMemo(
    () => models.filter((m) => (modelFilter ? modelFilter(m) : true)).filter((m) => matchesQuery(m, q)),
    [models, modelFilter, q],
  );

  const countsByProvider = React.useMemo(() => {
    const out = new Map<Provider, number>();
    for (const m of searchable) out.set(m.provider, (out.get(m.provider) ?? 0) + 1);
    return out;
  }, [searchable]);

  // A lab with no key is not on the rail at all, and neither is one whose
  // models this surface cannot use.
  const railProviders = React.useMemo(
    () => PROVIDER_LIST.filter((p) => (countsByProvider.get(p) ?? 0) > 0),
    [countsByProvider],
  );

  // Typing searches across every lab: a query shows the whole catalog rather
  // than searching inside one lab.
  const visible: ModelInfo[] = React.useMemo(
    () =>
      sortModelsForDisplay(
        searchable
          .filter((m) => (providerFilter && !q ? m.provider === providerFilter : true))
          .filter((m) => (filter === "favorites" && !q ? favorites.has(m.id) : true)),
      ),
    [searchable, providerFilter, filter, favorites, q],
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

  const closeAll = () => {
    setPickerOpen(false);
    setOpen(false);
  };

  const select = (m: ModelInfo) => {
    if (disabled) return;
    if (isAutoModelId(m.id)) {
      onChange(AUTO_MODEL_ID);
      closeAll();
      return;
    }
    if (m.comingSoon) return;
    if (isLocked(m)) {
      closeAll();
      router.push("/upgrade");
      return;
    }
    pushRecent(m.id);
    onChange(m.id);
    closeAll();
  };

  /** Move the keyboard cursor without letting a stationary pointer take it back. */
  const moveCursorTo = (key: string | undefined) => {
    if (!key) return;
    pointerActive.current = false;
    setCursorKey(key);
    rowRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  };

  /** ↑/↓ walk the list, Home/End jump to its ends, Enter picks. */
  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(e.key)) return;
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
    if (e.key === "Home") return moveCursorTo(order[0]);
    if (e.key === "End") return moveCursorTo(order[order.length - 1]);
    const at = cursorKey ? order.indexOf(cursorKey) : -1;
    moveCursorTo(e.key === "ArrowDown" ? order[(at + 1) % order.length] : order[(at - 1 + order.length) % order.length]);
  };

  /** What the detail panel describes: the row under the cursor, else the
   *  model you are on, so the pane is never blank on open. */
  const detailModel: ModelInfo | null = (cursorKey ? byKey.get(cursorKey) : null) ?? current ?? null;

  /**
   * One model row: a mark and a name.
   *
   * That is the whole row, and the restraint is the point. It carried a name,
   * a badge, a description line and a price column, which made it ~46px tall
   * and meant a lab with eleven models could show six. A list you scan for a
   * name you recognise wants to be a list of names — every fact a choice turns
   * on is in the panel to the right, which fills in from this row's cursor.
   *
   * The trailing slot holds one thing and usually nothing: the selected check,
   * or a lock for a model the plan cannot reach. `New`, the price, the
   * capabilities and the deprecation all moved to the panel.
   */
  const renderRow = (m: ModelInfo, prefix: string) => {
    const key = rowKeyFor(prefix, m.id);
    const auto = isAutoModelId(m.id);
    const active = auto ? autoSelected : value === m.id;
    const soon = !!m.comingSoon;
    const locked = isLocked(m);
    const cursor = cursorKey === key;
    const starred = !auto && favorites.has(m.id);
    const caps = [m.vision ? "Vision" : null, m.reasoning ? "Thinking" : null, m.webSearch ? "Search" : null].filter(
      (c): c is string => !!c,
    );
    const price = auto || soon ? "" : priceLabel(m);

    return (
      <button
        key={key}
        ref={(el) => {
          if (el) rowRefs.current.set(key, el);
          else rowRefs.current.delete(key);
        }}
        id={rowDomId(key)}
        type="button"
        role="option"
        aria-selected={active}
        // The row shows a name; the label carries what the panel shows, so a
        // screen reader is not made to travel to a second pane for the facts.
        aria-label={`${m.name}, ${auto ? "Juno" : providerName(m.provider)}${caps.length ? `, ${caps.join(", ")}` : ""}${price ? `, ${price} per million tokens` : ""}${locked ? `, needs ${PLANS[effectiveMinPlan(m.minPlan)].name}` : ""}`}
        disabled={soon}
        onPointerMove={() => {
          if (pointerActive.current) setCursorKey(key);
        }}
        onFocus={() => setCursorKey(key)}
        onClick={() => select(m)}
        data-cursor={cursor ? "" : undefined}
        className={cn(
          // ONE cursor, one fill. `hover:bg-accent` used to survive alongside
          // it, so a stationary pointer and the arrow keys painted two rows
          // with the identical fill at once.
          "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left outline-none",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          cursor && "bg-accent",
          // Locked rows are NOT dimmed: somebody comparing plans has to be able
          // to read the row they cannot use. Only "coming soon" is inert.
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        {auto ? (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card">
            <JunoMark className="size-2.5" />
          </span>
        ) : (
          <ProviderLogo provider={m.provider} className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{m.name}</span>
        {starred && <Star aria-hidden className="size-3 shrink-0 fill-current text-primary" />}
        <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">
          {active ? (
            <StatusIcons.success className="size-3.5 text-primary" />
          ) : locked ? (
            <Lock className="size-3 text-muted-foreground/70" />
          ) : null}
        </span>
      </button>
    );
  };

  /**
   * A group's rows, with a Text / Image / Video heading each time the modality
   * changes — but only when there is more than one to change BETWEEN.
   *
   * A lab showing four chat models used to draw "TEXT" above them, which names
   * a distinction nothing on screen contrasts with. In the All view it landed
   * directly under the lab's own heading, so one group of rows carried two
   * headings stacked.
   */
  const renderRows = (list: ModelInfo[], prefix: string, byModality: boolean) => {
    const modalities = new Set(list.map((m) => m.modality ?? "chat"));
    if (!byModality || modalities.size < 2) return list.map((m) => renderRow(m, prefix));
    const out: React.ReactNode[] = [];
    let last: Modality | null = null;
    for (const m of list) {
      const modality = m.modality ?? "chat";
      if (modality !== last) {
        const count = list.filter((x) => (x.modality ?? "chat") === modality).length;
        out.push(
          <SectionLabel key={`${prefix}label:${modality}`} count={count}>
            {MODALITY_LABEL[modality]}
          </SectionLabel>,
        );
      }
      last = modality;
      out.push(renderRow(m, prefix));
    }
    return out;
  };

  const chip = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Model: ${current?.name ?? "Select model"}`}
      // The shared composer chip: flat text, accent fill on hover and while
      // open. The name is set in the UI face, not mono — it is a label on a
      // control, not a value in a table.
      className={cn(composerChipClass, "max-w-[9rem] sm:max-w-[16rem]")}
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
  );

  return (
    // Stage two WRAPS stage one, so its anchor is the span around the chip.
    // Anchoring it to the chip itself is not possible — the chip is already
    // stage one's trigger, and two Radix triggers on one element fight over
    // its `data-state`, leaving the chip stuck open-looking after a close.
    <Popover open={pickerOpen && !disabled} onOpenChange={setPickerOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex min-w-0">
      {/* ── Stage one ──────────────────────────────────────────────────
          What the chip opens, and all most turns need: which model, and how
          hard it thinks. The model row is the door to stage two, and its
          arrow points UP because that is where the catalogue appears. */}
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={16}
          className="w-[min(24rem,calc(100vw-2rem))] max-w-none rounded-popover p-1.5"
        >
          <button
            type="button"
            onClick={() => {
              // Stage one closes as stage two opens: two popovers anchored to
              // one chip must never be on screen together.
              setOpen(false);
              setPickerOpen(true);
            }}
            className={cn(
              "flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left outline-none",
              "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
              "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          >
            {autoSelected ? (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card">
                <JunoMark className="size-3" />
              </span>
            ) : current ? (
              <ProviderLogo provider={current.provider} className="size-5 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-foreground">
                {current?.name ?? "Select model"}
              </span>
              <span className="block font-mono text-micro uppercase text-muted-foreground/60">Change model</span>
            </span>
            <ChevronUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>

          {thinking && (
            <>
              <div aria-hidden className="mx-2 my-1.5 h-px bg-border/70" />
              {/* No eyebrow here any more: the slider draws its own, on the
                  same line as the rung it names. Two surfaces cannot both own
                  one label without one of them eventually saying something
                  the other does not. */}
              <div className="px-2 pb-1">{thinking}</div>
            </>
          )}
        </PopoverContent>
      </Popover>

        </span>
      </PopoverAnchor>

      {/* ── Stage two: the catalogue ───────────────────────────────── */}
      <PopoverContent
        // `end`, not `start`. The model chip sits at the right of the
        // composer, so aligning the box's LEFT edge to it threw 680px
        // rightward into a viewport edge that was only ~18px away — the
        // collision clamp then did the positioning, which is why the panel
        // always sat hard against the right of the window whatever the width.
        // Anchoring its right edge to the chip's puts the box back over the
        // conversation, where there is room for it, and keeps it tied to the
        // control that opened it rather than to a screen edge.
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions
        onKeyDown={onNavKeyDown}
        // 600 wide: a 48px rail, a ~284px names column and a 268px panel.
        // Names at one line each mean a lab's whole current range is visible
        // at once, so the list no longer needs the width it used to.
        //
        // A HEIGHT RANGE, not a fixed height. Fixed was wrong in both
        // directions — too short and a lab showed a third of itself, too tall
        // and a four-model lab left a dead panel under its last row — and free
        // content-sizing is worse: the box is anchored at its bottom edge, so
        // it would re-lay the whole list upward under a pointer that has not
        // moved every time you pick a lab. Both bounds clamp to the viewport.
        style={{
          width: "min(600px, calc(100vw - 2rem))",
          minHeight: "min(360px, var(--radix-popover-content-available-height))",
          maxHeight: "min(480px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 48px of marks, folds under `sm`. Only labs with
              something in them; a tile can never lead to an empty list. */}
          <div className="hidden w-12 shrink-0 flex-col border-r border-border/70 bg-muted/25 sm:flex">
            {/* ScrollFade, not a bare `overflow-y-auto`: sixteen marks need
                more than a short column has, and the strip used to scroll
                with no affordance saying so. */}
            <ScrollFade className="min-h-0 flex-1" viewportClassName="flex flex-col items-center gap-1 p-2">
              {/* While a query is running the list shows every lab, so the rail
                  has to read as "All models" — it used to claim a lab that was
                  not the one on screen. `filter` itself is untouched, so
                  clearing the query restores it. */}
              <RailTile
                active={q ? true : filter === "all"}
                label="All models"
                count={searchable.length}
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                <LayoutGrid className="size-4" />
              </RailTile>
              <RailTile
                active={q ? false : filter === "favorites"}
                label="Favorites"
                count={favorites.size || undefined}
                onClick={() => {
                  setFilter("favorites");
                  setQuery("");
                }}
              >
                <Star className={cn("size-4", !q && filter === "favorites" && "fill-current")} />
              </RailTile>
              <div aria-hidden className="my-1 h-px w-5 shrink-0 bg-border" />
              {railProviders.map((p) => (
                <RailTile
                  key={p}
                  active={q ? false : filter === p}
                  label={providerName(p)}
                  count={countsByProvider.get(p)}
                  onClick={() => {
                    // A lab click means "show me this lab", so it clears the
                    // query that would otherwise keep showing all of them.
                    setFilter(p);
                    setQuery("");
                  }}
                >
                  <ProviderLogo provider={p} className="size-4" />
                </RailTile>
              ))}
            </ScrollFade>
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/70 p-3">
              {/* `.surface-inset` is the material FLAT_UI.md §3.3 assigns to a
                  search field, and `focus-within:border-ring` is the accent's
                  one decorative home in this popover. The field had neither:
                  the control the popover autofocuses was the one that looked
                  inert. */}
              <div className="surface-inset flex h-9 items-center gap-2 rounded-control px-2.5 transition-colors duration-fast ease-out-soft focus-within:border-ring motion-reduce:transition-none">
                <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursorKey(null);
                  }}
                  // Always global: a per-lab placeholder was a lie, since a
                  // query has always searched every lab.
                  placeholder="Search models…"
                  aria-label="Search models"
                  role="combobox"
                  aria-expanded
                  aria-controls="model-picker-list"
                  aria-activedescendant={cursorKey ? rowDomId(cursorKey) : undefined}
                  autoFocus
                  className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground"
                />
                {q && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                    className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            </div>
            <ScrollFade className="min-h-0 flex-1" viewportClassName="px-2 pb-3 pt-1.5">
              <div
                id="model-picker-list"
                role="listbox"
                aria-label="Models"
                onPointerMove={() => {
                  pointerActive.current = true;
                }}
              >
                {/* Keyed on `filter` ONLY, never on `query`: typing has to feel
                    instant, and a fade on every keystroke reads as flicker. */}
                <div key={filter} className="motion-safe:animate-fade-in">
                  {visible.length === 0 && !showAutoRow ? (
                    filter === "favorites" && !q ? (
                      <EmptyBlock
                        icon={Star}
                        title="No favorites yet"
                        body="Press the star in the panel on the right to keep a model here."
                      />
                    ) : (
                      <EmptyBlock
                        icon={SearchX}
                        title={q ? `No models match “${query.trim()}”` : "No models found"}
                        body="Try a lab name, a family like “sonnet”, or a capability like “vision”."
                        action={
                          q ? (
                            <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                              Clear search
                            </Button>
                          ) : undefined
                        }
                      />
                    )
                  ) : (
                    <>
                      {showAutoRow && (
                        // No label of its own; the first section's hairline is
                        // the separator.
                        <div role="group" aria-label="Juno" className="pb-2">
                          {renderRow(AUTO_MODEL_INFO, "")}
                        </div>
                      )}
                      {groups.map((g) => (
                        <div key={g.key || g.label} role="group" aria-label={g.label}>
                          {/* One lab in view: the modality headings carry the list, no lab label above them. */}
                          {!(providerFilter && !q && g.byModality) && (
                            <SectionLabel count={g.byModality ? undefined : g.models.length}>{g.label}</SectionLabel>
                          )}
                          {renderRows(g.models, g.key, g.byModality)}
                          {g.legacy.length > 0 && (
                            <details key={q ? "open" : "closed"} open={!!q} className="group/legacy">
                              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-control px-2 text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                                <span className="shrink-0 font-mono text-micro uppercase">Past models</span>
                                <span className="h-px flex-1 bg-border/70" />
                                <span className="shrink-0 font-mono text-micro tabular-nums">{g.legacy.length}</span>
                                {/* `ease-in-out` is the curve for an A-to-B move
                                    with both endpoints visible; an ease-out makes
                                    the chevron look like it arrives from off-screen. */}
                                <ChevronDown className="size-3 shrink-0 transition-transform duration-base ease-in-out group-open/legacy:rotate-180 motion-reduce:transition-none" />
                              </summary>
                              <div>{renderRows(g.legacy, `${g.key}legacy:`, g.byModality)}</div>
                            </details>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </ScrollFade>
          </div>

          {/* Everything the names column does not say. Effort is NOT here:
              it belongs to stage one, which is where you go to change it, and
              a second copy would be two controls for one setting. */}
          <DetailPanel
            model={detailModel}
            selected={!!detailModel && (isAutoModelId(detailModel.id) ? autoSelected : value === detailModel.id)}
            locked={!!detailModel && isLocked(detailModel)}
            starred={!!detailModel && favorites.has(detailModel.id)}
            onUse={() => detailModel && select(detailModel)}
            onToggleStar={() => detailModel && toggleFavorite(detailModel.id)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
