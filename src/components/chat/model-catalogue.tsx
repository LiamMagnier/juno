"use client";

/**
 * The model catalogue, in its own module so it can be fetched when it is
 * opened.
 *
 * The composer's model chip (model-selector.tsx) opens this directly: three
 * panes, sixteen lab marks, a detail panel, keyboard navigation, favourites
 * and recents, and at the foot of the list how hard the selected model should
 * think. It opens on the selected model, scrolled to its section (Google's
 * Video rows for Veo) with its row lit. Most turns never open it; every
 * session was downloading it.
 *
 * WHY A FILE AND NOT A `next/dynamic` AT THE OLD CALL SITE: the two stages
 * shared one component and one piece of state (`query`, `cursorKey`, `recent`,
 * the row refs), so there was nothing to split — the state that only the
 * catalogue uses now lives with the catalogue, which is what makes the dynamic
 * import in model-selector.tsx buy anything. It is also just a better
 * boundary: the chip no longer re-renders on every keystroke in a search
 * field it does not own.
 *
 * WHAT STAYS BEHIND: `value`, the resolved `current` model, `onPick` and the
 * thinking control come in as props, because they are the caller's, and the
 * popover's open state is the chip's business.
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

import * as React from "react";
import {
  ChevronDown,
  LayoutGrid,
  Lock,
  Search,
  SearchX,
  Star,
  X,
  type IconComponent,
} from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { JunoMark } from "@/components/brand/logo";
import { type ModelId, type ModelInfo, type Modality } from "@/lib/models";
import { AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { PLANS, modelRequiredPlan } from "@/lib/plans";
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
import { isModelLocked, readRecent } from "@/lib/model-picker";
import { EffortPanelContext } from "@/components/chat/reasoning-slider";
import { cn } from "@/lib/utils";
import { audioRequestCostMicroUsd } from "@/lib/audio-gen-core";
import { PRODUCT_NAME } from "@/lib/brand/names";

type Filter = "all" | "favorites" | Provider;

/** Below this many rows the list is the answer; a "Recent" copy only pads it. */
const RECENT_MIN_LIST = 8;

const MODALITY_ORDER: Modality[] = ["chat", "image", "video", "audio"];
const MODALITY_LABEL: Record<Modality, string> = { chat: "Text", image: "Image", video: "Video", audio: "Audio" };



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
  // Music is billed by the track, not by the token: say what one costs.
  if (m.modality === "audio") {
    const usd = audioRequestCostMicroUsd(m.id) / 1_000_000;
    return `$${usd.toFixed(2)} a ${/clip/i.test(m.id) ? "clip" : "song"}`;
  }
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
    <div aria-hidden className="flex items-center gap-2 px-2.5 pb-1 pt-3">
      <span className="shrink-0 text-caption font-medium text-muted-foreground">{children}</span>
      {count != null && (
        <span className="shrink-0 text-caption tabular-nums text-muted-foreground/70">{count}</span>
      )}
      <span className="flex-1" />
    </div>
  );
}

/** A centred empty state. Deliberately NOT `EmptyState`: that draws a dashed
 *  inset well, which is a second box inside a pane that has none. The glyph
 *  sits on a quiet tile (ICONS_AND_MOTION.md §3) so the state reads as
 *  designed rather than as a stray icon floating in a column. */
function EmptyBlock({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: IconComponent;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-8 py-14 text-center motion-safe:animate-fade-in">
      <span aria-hidden className="mb-1.5 grid size-10 place-items-center rounded-field bg-secondary text-muted-foreground">
        <Icon motion="none" className="size-5" />
      </span>
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
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-body font-medium tabular-nums text-foreground">{value}</span>
        {unit && <span className="text-caption text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
        {/* An inline scale: this is DATA, not a colour — the same precedent as
            the popover's own inline size below. It travels on `scaleX` from
            the left edge rather than on `width`, because only transform and
            opacity may move (ICONS_AND_MOTION.md §2.2.8): a width transition
            relaid the bar on every frame of every arrow keypress. */}
        <div
          aria-hidden
          className="h-full w-full origin-left rounded-full bg-foreground/70 transition-transform duration-slow ease-out-soft motion-reduce:transition-none"
          style={{ transform: `scaleX(${Math.max(0, Math.min(10, score)) / 10})` }}
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

  const shell = "hidden w-[272px] shrink-0 flex-col border-l border-border/60 bg-muted/40 md:flex";
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* The words swap in place, unkeyed and unfaded: the cursor moves
            every ~33ms under a held arrow key or a pointer sweep, and a fade
            restarted per step never gets past partial opacity (see above). */}
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-field border border-foreground/[0.07] bg-card dark:border-white/[0.08]">
            {auto ? <JunoMark className="size-5" /> : <ProviderLogo provider={model.provider} className="size-5" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{model.name}</span>
        </div>
        <p className="mt-0.5 font-mono text-micro text-muted-foreground">
          {auto ? PRODUCT_NAME : model.providerModel}
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

            {model.modality !== "audio" && metrics.inputUsdPerMTok + metrics.outputUsdPerMTok > 0 && (
              <dl className="mt-4 space-y-1 font-mono text-micro tabular-nums text-muted-foreground">
                <div className="flex items-baseline justify-between gap-2">
                  <dt>In / MTok</dt>
                  <dd>{formatPrice(metrics.inputUsdPerMTok)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt>Out / MTok</dt>
                  <dd>{formatPrice(metrics.outputUsdPerMTok)}</dd>
                </div>
              </dl>
            )}

            {caps.length > 0 && (
              <p className="mt-4 font-mono text-micro leading-relaxed text-muted-foreground">
                {caps.join(" · ")}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 p-3">
        {/* The accent is an ACTION here, not a status. A full-width coral bar
            reading "Selected" spends the brand colour on the one state that
            needs no button at all — and invites a press that does nothing.
            Selected is a quiet, inert label; only "use this" and "upgrade to
            reach this" are things to press. */}
        <Button
          type="button"
          variant={selected ? "secondary" : "default"}
          disabled={selected || !!model.comingSoon}
          onClick={onUse}
          className="h-9 min-w-0 flex-1"
        >
          {selected
            ? "Selected"
            : model.comingSoon
              ? "Not available yet"
              : locked
                ? `Get ${PLANS[modelRequiredPlan(model)].name}`
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
                {/* Two cuts of one star in one cell, trading opacity and a
                    small scale: the filled cut is the set's "on", and the swap
                    is a cross-fade rather than a replace (§2.2.7). */}
                <span aria-hidden className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1 grid place-items-center transition-[opacity,transform] duration-fast ease-out-soft motion-reduce:transition-opacity",
                      starred ? "scale-75 opacity-0" : "opacity-100",
                    )}
                  >
                    <Star className="size-3.5" />
                  </span>
                  <span
                    className={cn(
                      "col-start-1 row-start-1 grid place-items-center text-primary transition-[opacity,transform] duration-fast ease-out-soft motion-reduce:transition-opacity",
                      starred ? "opacity-100" : "scale-75 opacity-0",
                    )}
                  >
                    <Star weight="fill" className="size-3.5" />
                  </span>
                </span>
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
 * Active is the on tone, `bg-selected`, one rung past the hover fill
 * (FLAT_UI.md §3.1); it was `bg-secondary`, which is paler than hover in the
 * light theme, so the lab you were in read weaker than one the pointer
 * crossed. The accent stays reserved for the selected MODEL, never for which
 * lab you are browsing.
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
            // `.pressable` carries the colour cross-fade AND the press dip on
            // their own rungs, so no transition-* utility sits beside it.
            "pressable flex size-8 shrink-0 items-center justify-center rounded-control outline-none",
            "motion-reduce:active:scale-100",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            active ? "surface-key text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
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

/** Text → image → video → audio, then the catalog's own order (generation, date, power). */
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

export function ModelCatalogue({
  value,
  current,
  autoSelected,
  filter: modelFilter,
  onPick,
  thinking,
  side = "top",
}: {
  value: ModelId;
  /** The model `value` resolves to — computed once by the chip. */
  current: ModelInfo | null;
  autoSelected: boolean;
  filter?: (model: ModelInfo) => boolean;
  /** Picking a row: the chip owns what that does (recents, close, upgrade). */
  onPick: (model: ModelInfo) => void;
  /** The selected model's thinking-effort control, drawn under the list; null when it has one effort. */
  thinking?: React.ReactNode;
  /** The side the chip opens toward. */
  side?: "top" | "bottom";
}) {
  const { quota, models, settings } = useApp();
  const save = useSettingsSave();
  const plan = quota.plan;
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  /** The row under the cursor (pointer or arrow keys), by ROW key. */
  const [cursorKey, setCursorKey] = React.useState<string | null>(null);
  /**
   * Read on mount rather than in an effect keyed on an `open` flag: this
   * component IS the open state now — the chip mounts it when the catalogue
   * opens and unmounts it when it closes, so "reset when it opens" is just
   * initial state, and the transient fields above need no reset at all.
   */
  const [recent, setRecent] = React.useState<string[]>([]);
  React.useEffect(() => setRecent(readRecent()), []);
  const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const listViewportRef = React.useRef<HTMLDivElement>(null);
  /**
   * Whether the pointer has genuinely MOVED since the last arrow key.
   *
   * Without it the two cursors fight: ↓ scrolls a new row under a stationary
   * pointer, the browser replays a pointer event over it, and the keyboard
   * cursor is handed straight back. Arrow keys clear the flag; the first
   * genuine `pointermove` over the list sets it again.
   */
  const pointerActive = React.useRef(false);

  const favorites = React.useMemo(() => new Set(settings.favoriteModels ?? []), [settings.favoriteModels]);
  const toggleFavorite = (id: string) => {
    const next = favorites.has(id)
      ? (settings.favoriteModels ?? []).filter((m) => m !== id)
      : [...(settings.favoriteModels ?? []), id];
    void save({ favoriteModels: next });
  };

  const q = query.trim().toLowerCase();


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
  const isLocked = (m: ModelInfo) => isModelLocked(m, plan);
  const select = onPick;

  const moveCursorTo = (key: string | undefined) => {
    if (!key) return;
    pointerActive.current = false;
    setCursorKey(key);
    rowRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  };

  /** ↑/↓ walk the list, Home/End jump to its ends, Enter picks. */
  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(e.key)) return;
    // The thinking slider at the foot drives itself with the same keys.
    if (e.target instanceof Element && e.target.closest("[data-model-thinking]")) return;
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

  const detailModel: ModelInfo | null = (cursorKey ? byKey.get(cursorKey) : null) ?? current ?? null;

  /**
   * The selected model's row: its copy under its own lab (where the Text /
   * Image / Video / Audio headings are), else wherever else it is listed.
   */
  const selectedKey = React.useMemo(() => {
    const id = autoSelected ? AUTO_MODEL_INFO.id : value;
    const own = rowKeyFor("", id);
    if (byKey.has(own)) return own;
    return order.find((key) => byKey.get(key)?.id === id) ?? null;
  }, [autoSelected, value, byKey, order]);

  /**
   * Open on the model in use: its row lit (so the panel describes it and the
   * arrow keys start from it) and the list scrolled to its section, so a Veo
   * thread opens on Google's Video rows rather than on the top of the list.
   * The heading above the row goes to the top of the list when the row still
   * fits under it; otherwise the row is centred. Once per open (this component
   * is re-created per open), retried for a few frames because the popover's
   * portal mounts its content a frame after this component.
   */
  const placedRef = React.useRef(false);
  React.useEffect(() => {
    if (placedRef.current || !selectedKey) return;
    let frame = 0;
    let tries = 0;
    const place = () => {
      const row = rowRefs.current.get(selectedKey);
      const viewport = listViewportRef.current;
      if (!row || !viewport) {
        if (++tries < 10) frame = requestAnimationFrame(place);
        return;
      }
      placedRef.current = true;
      setCursorKey(selectedKey);
      let heading: Element | null = row.previousElementSibling;
      while (heading && heading.tagName === "BUTTON") heading = heading.previousElementSibling;
      const top = viewport.getBoundingClientRect().top - viewport.scrollTop;
      const rowTop = row.getBoundingClientRect().top - top;
      const rowBottom = rowTop + row.offsetHeight;
      const headingTop = heading ? heading.getBoundingClientRect().top - top : rowTop;
      viewport.scrollTop =
        rowBottom - headingTop <= viewport.clientHeight - 8
          ? Math.max(0, headingTop - 4)
          : Math.max(0, rowTop - (viewport.clientHeight - row.offsetHeight) / 2);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [selectedKey]);
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
        aria-label={`${m.name}, ${auto ? PRODUCT_NAME : providerName(m.provider)}${caps.length ? `, ${caps.join(", ")}` : ""}${price ? `, ${price}${m.modality === "audio" ? "" : " per million tokens"}` : ""}${locked ? `, needs ${PLANS[modelRequiredPlan(m)].name}` : ""}`}
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
          "flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left outline-none",
          // Colour only, so it keeps its timing under reduced motion (fades
          // are not travel; ICONS_AND_MOTION.md §2.2, rule 10).
          "transition-colors duration-fast ease-out-soft",
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
          <ProviderLogo provider={m.provider} className="size-[18px] shrink-0" />
        )}
        <span className={cn("min-w-0 flex-1 truncate text-ui text-foreground", active && "font-medium")}>{m.name}</span>
        {starred && <Star aria-hidden className="size-3 shrink-0 fill-current text-muted-foreground" />}
        <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">
          {active ? (
            <StatusIcons.success className="size-4 text-foreground" />
          ) : locked ? (
            <Lock className="size-3 text-muted-foreground" />
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
  return (
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
        side={side}
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
          width: "min(640px, calc(100vw - 2rem))",
          minHeight: "min(380px, var(--radix-popover-content-available-height))",
          maxHeight: "min(500px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none origin-bottom-right flex-col overflow-hidden rounded-menu p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 48px of marks, folds under `sm`. Only labs with
              something in them; a tile can never lead to an empty list. */}
          <div className="hidden w-12 shrink-0 flex-col border-r border-border/60 bg-muted/40 sm:flex">
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
            <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
              {/* `.surface-inset` is the material FLAT_UI.md §3.3 assigns to a
                  search field, and `focus-within:border-ring` is the accent's
                  one decorative home in this popover. The field had neither:
                  the control the popover autofocuses was the one that looked
                  inert. */}
              <div className="flex h-10 items-center gap-2.5 rounded-control px-2.5">
                <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                        className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-safe:animate-fade-in"
                      >
                        <X className="size-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Clear search</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            <ScrollFade className="min-h-0 flex-1" viewportClassName="px-2 pb-3 pt-1.5" viewportRef={listViewportRef}>
              <div
                id="model-picker-list"
                role="listbox"
                aria-label="Models"
                onPointerMove={() => {
                  pointerActive.current = true;
                }}
              >
                {/* Keyed on `filter` ONLY, never on `query`: typing has to feel
                    instant, and a fade on every keystroke reads as flicker.
                    On the fast rung — a lab switch is a pane changing under a
                    pointer that is already there, and should be over before
                    the eye has left the rail. */}
                <div
                  key={filter}
                  className="motion-safe:animate-fade-in motion-safe:[animation-duration:var(--dur-fast)]"
                >
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
                        <div role="group" aria-label={PRODUCT_NAME} className="pb-2">
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
                              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-control px-2.5 text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                                <span className="shrink-0 text-caption font-medium">Past models</span>
                                <span className="shrink-0 text-caption tabular-nums text-muted-foreground/70">{g.legacy.length}</span>
                                <span className="flex-1" />
                                {/* `ease-in-out` is the curve for an A-to-B move
                                    with both endpoints visible; an ease-out makes
                                    the chevron look like it arrives from off-screen. */}
                                <ChevronDown className="size-3 shrink-0 transition-transform duration-base ease-in-out group-open/legacy:rotate-180 motion-reduce:transition-none" />
                              </summary>
                              {/* A native <details> hides its body with
                                  display:none, which restarts a CSS animation
                                  every time it opens — so the rows rise in on
                                  each open instead of appearing in one frame. */}
                              <div className="motion-safe:animate-rise-in">
                                {renderRows(g.legacy, `${g.key}legacy:`, g.byModality)}
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </ScrollFade>
            {/* How hard the selected model thinks: one control for one
                setting, under the list rather than in the panel, because the
                panel folds away on a narrow screen and this must not. Its
                model name puts the selected model back under the cursor. */}
            {thinking ? (
              <div data-model-thinking="" className="shrink-0 border-t border-border/60 px-3 pb-3 pt-2.5">
                <EffortPanelContext.Provider
                  value={{
                    modelName: current?.name ?? "Model",
                    onOpenModels: () => {
                      if (selectedKey) moveCursorTo(selectedKey);
                    },
                  }}
                >
                  {thinking}
                </EffortPanelContext.Provider>
              </div>
            ) : null}
          </div>

          {/* Everything the names column does not say. Effort is not here:
              it is under the list, for the selected model only, and a second
              copy would be two controls for one setting. */}
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
  );
}
