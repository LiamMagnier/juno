"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  LayoutGrid,
  Lock,
  Search,
  SearchX,
  Star,
  X,
  type LucideIcon,
} from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
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
  formatContext,
  formatPrice,
  getModelMetrics,
  sortModelsForDisplay,
} from "@/lib/model-metrics";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

type Filter = "all" | "favorites" | Provider;

/**
 * The model picker: named lab rail · model list.
 *
 * TWO PANES, and the second one is the point. It used to be three — a 48px
 * icon-only rail, a squeezed list, and a 260px spec sheet carrying four graded
 * numerals over 4px meters, capability chips and a two-column price table. The
 * sheet answered a question nobody asks while choosing, and it was the loudest
 * object in the popover; the rail asked you to recognise sixteen logos with
 * their names hidden behind a 600ms tooltip. Both are gone
 * (docs/design/PREMIUM_AUDIT.md §2).
 *
 * The RAIL is now 168px of named rows: All models, Favorites, then one row per
 * configured lab with its mark, its name and how many models it has. The LIST
 * is everything else — search at the top, rows grouped by lab (or by what they
 * make, inside a lab), superseded generations folded behind "Past models".
 *
 * A ROW IS TEXT ON THE PANEL. No border, no fill, no radius until the cursor
 * is on it. It carries the lab mark, the name, a one-line description, and
 * exactly ONE trailing signal: the selected check, or a lock, or the plan it
 * needs. The capability glyph column and the price column both went into the
 * description line, where they are words a person can read rather than three
 * 12px icons in a 44px gutter.
 *
 * What survives from the old surface, because it was right: one accent used
 * only for state (the selected check, a filled star, the focus edge), a single
 * cursor shared by pointer and arrow keys, and favorites persisted to the
 * account while recents stay per browser.
 *
 * Thinking effort is a footer under both panes, passed in by the composer as
 * `thinking` — one chip, one popover, for the one decision "which model, how
 * hard". Claude ships effort under its model list; ChatGPT folds it into the
 * entry. This is that shape.
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

/**
 * The row's second line — and only below `md`, where the spec sheet is gone
 * and the description has nowhere else to live. Above `md` the row is one
 * line and this text is in the sheet, 8px to the right, in full.
 */
/**
 * The row's one description line.
 *
 * The curated blurb when there is one; otherwise what the catalog knows. This
 * used to be able to return the empty string for a discovered model with no
 * description and no context figure, which left a row with a name and nothing
 * under it beside rows carrying two lines — a ragged list. The context window
 * is the one fact every chat model has, so it is the floor.
 */
function rowCaption(m: ModelInfo): string {
  if (m.description) return m.description;
  const metrics = getModelMetrics(m);
  if (m.modality !== "chat") return `${MODALITY_LABEL[m.modality]} generation.`;
  return metrics.contextTokens
    ? `${formatContext(metrics.contextTokens)} context window.`
    : `${providerName(m.provider)} chat model.`;
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
      <span className="h-px flex-1 bg-border/60" />
      {count != null && (
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/60">{count}</span>
      )}
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
 * One row on the lab rail: mark, name, count.
 *
 * Named, because a logo with no name is a memory test and the tooltip that
 * used to fix it put a 600ms delay on this surface's primary navigation. The
 * active row is the tonal `bg-secondary` — the accent is reserved for the
 * selected MODEL, not for which lab you are browsing.
 */
function RailRow({
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-full shrink-0 items-center gap-2 rounded-control px-2 text-left outline-none",
        "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1 truncate text-ui">{label}</span>
      {count != null && (
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/60">{count}</span>
      )}
    </button>
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
  const [open, setOpen] = React.useState(false);
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

  React.useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    setQuery("");
    setCursorKey(null);
    pointerActive.current = false;
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

  /**
   * One model row: mark · name · description · one trailing signal.
   *
   * The trailing gutter holds exactly one thing, and which one is a strict
   * ladder: the selected check, else the plan a locked model needs, else
   * nothing. It used to hold four — a three-slot capability column, a 76px
   * price, a state glyph and a star — which is four right edges in a row that
   * has one left one. The capabilities and the price are words on the
   * description line now, where they read.
   */
  const renderRow = (m: ModelInfo, prefix: string) => {
    const key = rowKeyFor(prefix, m.id);
    const auto = isAutoModelId(m.id);
    const active = auto ? autoSelected : value === m.id;
    const soon = !!m.comingSoon;
    const locked = isLocked(m);
    const cursor = cursorKey === key;
    const starred = !auto && favorites.has(m.id);
    const caption = auto ? "Picks the best model and thinking depth for each message." : rowCaption(m);
    const caps = [m.vision ? "Vision" : null, m.reasoning ? "Thinking" : null, m.webSearch ? "Search" : null].filter(
      (c): c is string => !!c,
    );
    const price = auto || soon ? "" : priceLabel(m);

    return (
      <div key={key} className="group/row relative">
      <button
        ref={(el) => {
          if (el) rowRefs.current.set(key, el);
          else rowRefs.current.delete(key);
        }}
        id={rowDomId(key)}
        type="button"
        role="option"
        aria-selected={active}
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
          "flex w-full items-start gap-2.5 rounded-control px-2 py-2 text-left outline-none",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          cursor && "bg-accent",
          // Locked rows are NOT dimmed: somebody comparing plans has to be able
          // to read the row they cannot use. Only "coming soon" is inert.
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        {auto ? (
          // Auto gets the same 20px tile every lab mark draws, so the first row
          // sits on the column rather than beside it.
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card">
            <JunoMark className="size-3" />
          </span>
        ) : (
          <ProviderLogo provider={m.provider} className="mt-px size-5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium text-foreground">{m.name}</span>
            {auto && (
              <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/60">Recommended</span>
            )}
            {!auto && isNew(m) && (
              <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/60">New</span>
            )}
          </span>
          {/* ONE description line, and everything that used to live in the
              trailing gutter is on it. Truncated rather than wrapped: a row
              that grows to two lines when a lab writes a long blurb makes the
              list jump as the cursor walks it. */}
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">{caption}</span>
          {/* The machine line. Mono, one rung quieter, and present only when it
              has something to say — a model with no capabilities and no price
              (Auto) does not get an empty row of dots. */}
          {(caps.length > 0 || price || m.status === "deprecated") && (
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-micro text-muted-foreground/60">
              {caps.map((c) => (
                <span key={c} className="uppercase">{c}</span>
              ))}
              {price && (
                <>
                  {caps.length > 0 && <span aria-hidden>·</span>}
                  <span className="tabular-nums">{price}</span>
                </>
              )}
              {m.status === "deprecated" && (
                <>
                  <span aria-hidden>·</span>
                  <span title={m.deprecationNote ?? "Deprecated by the provider"} className="text-warning">
                    {m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
                  </span>
                </>
              )}
            </span>
          )}
        </span>
        {/* The one trailing slot. Fixed width so the column is a column even
            when every row in view is empty, and wide enough that the star
            sitting beside it never overlaps what it says. */}
        <span className="mt-0.5 flex min-h-5 w-16 shrink-0 items-center justify-end pr-7">
          {active ? (
            <StatusIcons.success aria-hidden className="size-3.5 text-primary" />
          ) : locked ? (
            <span className="flex items-center gap-1 font-mono text-micro uppercase text-muted-foreground/70">
              <Lock aria-hidden className="size-3" />
              {PLANS[effectiveMinPlan(m.minPlan)].name}
            </span>
          ) : soon ? (
            <span className="font-mono text-micro uppercase text-muted-foreground/70">Soon</span>
          ) : null}
        </span>
      </button>
      {/* The favourite toggle, on the row it favourites.
          It used to be a button in the foot of the spec sheet, which meant
          starring a model required pointing at it, reading a 260px column and
          then travelling back — three moves for a one-bit preference.
          Revealed on cursor or focus, and permanently visible once set, so an
          idle list still shows exactly one trailing signal per row. */}
      {!auto && !soon && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={starred ? `Remove ${m.name} from favorites` : `Add ${m.name} to favorites`}
          aria-pressed={starred}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(m.id);
          }}
          className={cn(
            "absolute right-2 top-2 flex size-6 items-center justify-center rounded-xs outline-none",
            "transition-[opacity,color] duration-fast ease-out-soft motion-reduce:transition-none",
            "hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
            starred
              ? "text-primary opacity-100"
              : "text-muted-foreground/70 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          )}
        >
          <Star aria-hidden className={cn("size-3.5", starred && "fill-current")} />
        </button>
      )}
      </div>
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
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
        // 680×460. Two panes rather than three, so the list gets 496px of the
        // box instead of the ~350px it had between an icon rail and a spec
        // sheet — enough for a name, a description and a machine line without
        // any of the three truncating at a normal lab name.
        style={{
          width: "min(680px, calc(100vw - 2rem))",
          height: "min(460px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 168px of NAMED rows, folds under `sm`. Only labs with
              something in them; a rail row can never lead to an empty list. */}
          <div className="hidden w-[168px] shrink-0 flex-col border-r border-border/70 bg-muted/25 sm:flex">
            <ScrollFade className="min-h-0 flex-1" viewportClassName="flex flex-col gap-0.5 p-2">
              {/* While a query is running the list shows every lab, so the rail
                  has to read as "All models" — it used to claim a lab that was
                  not the one on screen. `filter` itself is untouched, so
                  clearing the query restores it. */}
              <RailRow
                active={q ? true : filter === "all"}
                label="All models"
                count={searchable.length}
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                <LayoutGrid className="size-4" />
              </RailRow>
              <RailRow
                active={q ? false : filter === "favorites"}
                label="Favorites"
                count={favorites.size || undefined}
                onClick={() => {
                  setFilter("favorites");
                  setQuery("");
                }}
              >
                <Star className={cn("size-4", !q && filter === "favorites" && "fill-current")} />
              </RailRow>
              <div aria-hidden className="my-1.5 h-px shrink-0 bg-border/70" />
              {railProviders.map((p) => (
                <RailRow
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
                </RailRow>
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

        </div>
        {thinking && (
          // The effort control, docked under both panes. The label is in the
          // mono metadata voice like every other label on this surface.
          <div className="flex shrink-0 items-center gap-3 border-t border-border/70 px-4 py-2.5">
            <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/60">Thinking</span>
            <div className="min-w-0 flex-1">{thinking}</div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
