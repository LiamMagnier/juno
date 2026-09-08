"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search, Star } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { formatContext, formatPrice, getModelMetrics, sortModelsForDisplay } from "@/lib/model-metrics";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

type Filter = "all" | "favorites" | Provider;

/**
 * The model picker.
 *
 * One column, the way Claude and ChatGPT pick a model: a search field, a row
 * of filters, then rows. A row is a mark, a name, one line saying what the
 * model is for, and its price — everything a person needs to choose, and
 * nothing that needs a second panel to explain. The old three-pane picker
 * (lab rail · list · spec sheet with metric bars) put a benchmark dashboard
 * between the user and a decision that is usually "the one I always use".
 *
 * Favorites are real here for the first time: they lived in Settings › Models
 * and never reached the composer. Star a row and it heads the list on every
 * surface; the star is persisted to the account, not the browser. Recents stay
 * per browser, like a draft.
 *
 * Auto leads the list as Juno's recommendation. Labs whose key is not
 * configured are simply absent — a picker is not the place to advertise an
 * environment variable.
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
  const released = Date.UTC(y, mo - 1, 1);
  return Date.now() - released < 75 * 24 * 60 * 60 * 1000;
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
  const facts = [
    m.modality !== "chat" ? (m.modality === "image" ? "Image generation" : "Video generation") : null,
    m.modality === "chat" && metrics.contextTokens ? `${formatContext(metrics.contextTokens)} context` : null,
    m.reasoning ? "Thinking" : null,
    m.vision ? "Vision" : null,
  ].filter(Boolean);
  return facts.join(" · ");
}

/** Text → image → video, then the catalog's own order (generation, date, power). */
function sortByModality<T extends ModelInfo>(models: T[]): T[] {
  return [...models].sort(
    (a, b) => MODALITY_ORDER.indexOf(a.modality ?? "chat") - MODALITY_ORDER.indexOf(b.modality ?? "chat"),
  );
}

/** A section label over a group of rows. aria-hidden: the group carries it. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="px-3 pb-1 pt-3 font-mono text-caption text-muted-foreground first:pt-1">
      {children}
    </div>
  );
}

/** A filter chip: All, Favorites, or one lab's mark. */
function FilterChip({
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
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-ui font-medium transition-[background-color,color,border-color] duration-fast ease-out-soft motion-reduce:transition-none",
            active
              ? "border-foreground/20 bg-secondary text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
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
  const { quota, models, settings } = useApp();
  const save = useSettingsSave();
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

  const favorites = React.useMemo(() => new Set(settings.favoriteModels ?? []), [settings.favoriteModels]);
  const toggleFavorite = (id: string) => {
    const next = favorites.has(id)
      ? (settings.favoriteModels ?? []).filter((m) => m !== id)
      : [...(settings.favoriteModels ?? []), id];
    void save({ favoriteModels: next });
  };

  const current = isAutoModelId(value)
    ? AUTO_MODEL_INFO
    : (models.find((m) => m.id === value) ?? resolveModel(value));
  const q = query.trim().toLowerCase();
  const autoSelected = isAutoModelId(value);

  const providerFilter = filter !== "all" && filter !== "favorites" ? (filter as Provider) : null;
  // The live model endpoint is authoritative for provider availability.
  const configuredProviders = React.useMemo(
    () => PROVIDER_LIST.filter((p) => models.some((model) => model.provider === p)),
    [models],
  );

  // Typing filters across every lab: a query clears the chips rather than
  // searching inside one lab.
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
   * Favorites first, then recents (unfiltered view only, only when the list is
   * long enough that they save a scroll), then one group per lab in the rail's
   * order. Superseded generations fold behind "Past models".
   */
  const groups = React.useMemo<Group[]>(() => {
    const out: Group[] = [];
    const starred = filter === "all" && !q ? visible.filter((m) => favorites.has(m.id)) : [];
    if (starred.length) out.push({ key: "favorites", label: "Favorites", models: sortByModality(starred), legacy: [] });
    if (filter === "all" && !q && visible.length >= RECENT_MIN_LIST) {
      const seen = new Set(starred.map((m) => m.id));
      const rows = recent
        .map((id) => visible.find((m) => m.id === id))
        .filter((m): m is ModelInfo => !!m && !seen.has(m.id));
      if (rows.length) out.push({ key: "recent", label: "Recent", models: rows, legacy: [] });
    }
    for (const p of PROVIDER_LIST) {
      const mine = visible.filter((m) => m.provider === p);
      if (!mine.length) continue;
      const legacy = sortByModality(mine.filter((m) => m.legacy));
      const live = sortByModality(mine.filter((m) => !m.legacy));
      out.push({ key: p, label: providerName(p), models: live, legacy });
    }
    return out;
  }, [visible, recent, favorites, filter, q]);

  /** Every row in render order, for the arrow keys. */
  const order = React.useMemo(() => {
    const ids: string[] = [];
    if (showAutoRow) ids.push(AUTO_MODEL_ID);
    for (const g of groups) {
      for (const m of g.models) ids.push(m.id);
      if (q) for (const m of g.legacy) ids.push(m.id);
    }
    return ids;
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
      const id = cursorId ?? order[0];
      const m = id === AUTO_MODEL_ID ? AUTO_MODEL_INFO : models.find((x) => x.id === id);
      if (m) select(m);
      return;
    }
    e.preventDefault();
    const at = cursorId ? order.indexOf(cursorId) : -1;
    const next = e.key === "ArrowDown" ? order[(at + 1) % order.length] : order[(at - 1 + order.length) % order.length];
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
    const starred = !auto && favorites.has(m.id);
    const caption = auto
      ? "Picks the best model and thinking depth for each message."
      : rowCaption(m);
    const trailing = soon
      ? "Soon"
      : locked
        ? PLANS[effectiveMinPlan(m.minPlan)].name
        : auto
          ? ""
          : priceLabel(m);

    return (
      <div key={keyPrefix + m.id} className="group/row relative">
        <button
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
            // Flat at rest; the cursor (pointer or arrow keys) lays the tonal
            // fill. Selection is the check on the right, not a second fill.
            "flex w-full items-center gap-3 rounded-control px-2.5 py-2 text-left outline-none transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
            cursor ? "bg-accent" : "hover:bg-accent",
            soon && "cursor-not-allowed opacity-45",
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center">
            {auto ? <JunoMark className="size-4.5" /> : <ProviderLogo provider={m.provider} className="size-4.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{m.name}</span>
              {auto && (
                <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-px font-mono text-micro font-medium text-primary-ink">
                  Recommended
                </span>
              )}
              {!auto && isNew(m) && (
                <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px font-mono text-micro font-medium text-muted-foreground">
                  New
                </span>
              )}
              {deprecated && (
                <span
                  title={m.deprecationNote ?? "Deprecated by the provider"}
                  className="shrink-0 font-mono text-micro text-warning-foreground"
                >
                  {m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
                </span>
              )}
            </span>
            {caption && <span className="mt-0.5 block truncate text-caption text-muted-foreground">{caption}</span>}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono text-caption tabular-nums text-muted-foreground transition-opacity duration-fast",
              // The price yields to the star while the pointer is on the row.
              !auto && !soon && !locked && "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
            )}
          >
            {trailing}
          </span>
          <span className="flex w-4 shrink-0 items-center justify-center">
            {active && <StatusIcons.success className="size-4 text-primary" />}
          </span>
        </button>
        {!auto && !soon && !locked && (
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
              "absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-control text-muted-foreground transition-[opacity,color,background-color] duration-fast ease-out-soft hover:bg-secondary hover:text-foreground motion-reduce:transition-none",
              starred
                ? "opacity-0 text-primary group-hover/row:opacity-100 group-focus-within/row:opacity-100"
                : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
            )}
          >
            <Star className={cn("size-3.5", starred && "fill-current")} />
          </button>
        )}
      </div>
    );
  };

  const renderRows = (list: ModelInfo[], keyPrefix = "") => list.map((m) => renderRow(m, keyPrefix));

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
        // One column, clamped to the viewport by Radix's available-height var
        // and a 16px margin on every side.
        style={{
          width: "min(420px, calc(100vw - 2rem))",
          height: "min(560px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="shrink-0 border-b border-border px-2 pt-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
              className="h-9 w-full rounded-control bg-transparent pl-9 pr-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div className="no-scrollbar -mx-1 flex items-center gap-0.5 overflow-x-auto px-1 pb-2 pt-1">
            <FilterChip active={filter === "all"} title="All models" onClick={() => setFilter("all")}>
              All
            </FilterChip>
            <FilterChip active={filter === "favorites"} title="Favorites" onClick={() => setFilter("favorites")}>
              <Star className={cn("size-3.5", filter === "favorites" && "fill-current")} />
            </FilterChip>
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
            {configuredProviders.map((p) => (
              <FilterChip key={p} active={filter === p} title={providerName(p)} onClick={() => setFilter(p)}>
                <ProviderLogo provider={p} className="size-4" />
              </FilterChip>
            ))}
          </div>
        </div>
        <ScrollFade className="min-h-0 flex-1 overflow-y-auto" viewportClassName="p-1.5">
          <div id="model-picker-list" role="listbox" aria-label="Models">
            {visible.length === 0 && !showAutoRow ? (
              <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                <p className="text-sm font-medium text-foreground">
                  {filter === "favorites" && !q ? "No favorites yet" : "No models found"}
                </p>
                <p className="text-caption text-muted-foreground">
                  {filter === "favorites" && !q
                    ? "Hover a model and press the star to keep it here."
                    : "Try another name, lab or capability."}
                </p>
              </div>
            ) : (
              <>
                {showAutoRow && (
                  <div role="group" aria-label="Juno">
                    {renderRow(AUTO_MODEL_INFO)}
                  </div>
                )}
                {groups.map((g) => (
                  <div key={g.key} role="group" aria-label={g.label}>
                    <GroupLabel>{g.label}</GroupLabel>
                    {renderRows(g.models, g.key === "recent" || g.key === "favorites" ? `${g.key}:` : "")}
                    {g.legacy.length > 0 && (
                      <details key={q ? "open" : "closed"} open={!!q} className="group/legacy pt-0.5">
                        <summary className="flex h-8 cursor-pointer list-none items-center justify-between rounded-control px-2.5 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent [&::-webkit-details-marker]:hidden">
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
      </PopoverContent>
    </Popover>
  );
}
