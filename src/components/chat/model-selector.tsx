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
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
 * The model picker: provider rail · list · spec sheet.
 *
 * A fixed 880×560 float above the composer chip, clamped to the viewport with
 * a 16px margin and never clipped: the rail is 56px, the spec sheet a 300px
 * column with its own scroll, and the list scrolls between them. Under `md`
 * the sheet folds away (two panes); under `sm` the rail goes too (one pane).
 *
 * Calm on purpose. Every capability used to wear its own icon chip on every
 * row — brains, bolts, eyes — so the list read as a wall of badges and the one
 * thing that mattered (which model, at what cost) was the hardest to find. A
 * row is a mark, a name, one line of note and a price glyph; the sheet on the
 * right carries the capabilities as plain mono tags and the numbers as a small
 * table, and ends in the one button that matters. Thinking effort is not in
 * here at all — it is its own chip on the composer row.
 */

/** Most recently chosen models, newest first. Per browser, like a draft. */
const RECENT_KEY = "juno:models:recent";
const RECENT_MAX = 3;
/** Below this many rows the list is the answer; a "Recent" copy only pads it. */
const RECENT_MIN_LIST = 8;

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

/** The one-line note under a row's name. */
function rowNote(m: ModelInfo): string {
  if (isAutoModelId(m.id)) return "Routes each message to the model that fits it";
  if (m.status === "deprecated")
    return m.retiresOn ? `Retiring ${formatRetirementDate(m.retiresOn)}` : "Retiring soon";
  if (m.description) return m.description;
  return m.modality === "image"
    ? "Image generation"
    : m.modality === "video"
      ? "Video generation"
      : providerName(m.provider);
}

/** A sentence-case label over a group of rows. aria-hidden: the group carries it. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="px-2.5 pb-1 pt-2 font-mono text-caption text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * A capability tag: mono caption on the spec sheet's inset well. 22px tall,
 * no icon — the word is the whole message.
 */
function Tag({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "primary" }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center rounded-xs border px-1.5 font-mono text-caption leading-none",
        tone === "primary"
          ? "border-primary/40 bg-primary/8 text-primary-ink"
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
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-3 py-1.5">
      <dt className="font-mono text-caption text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-caption tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The spec sheet. A fixed 300px column with its own scroll; the "Use this
 * model" button is pinned at the foot so it is reachable however long the
 * description runs.
 */
function SpecSheet({
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
  const shell = "hidden w-[300px] shrink-0 flex-col border-l border-border/50 bg-card/60 md:flex";

  if (!model) {
    return (
      <div className={cn(shell, "items-center justify-center p-5")}>
        <p className="text-center text-caption text-muted-foreground">
          Hover or arrow through the list to compare models.
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
        <div>
          <div className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
            <JunoMark className="size-3.5" />
            Juno
          </div>
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
      </>
    );
  } else {
    const metrics = getModelMetrics(model);
    const free = metrics.inputUsdPerMTok === 0 && metrics.outputUsdPerMTok === 0;
    const tags = capabilityTags(model);
    body = (
      <>
        <div>
          <div className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
            <ProviderLogo provider={model.provider} className="size-3.5" />
            {providerName(model.provider)}
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

        <dl className="divide-y divide-border/50 border-y border-border/50">
          <SpecRow label="Context" value={formatContext(metrics.contextTokens)} />
          <SpecRow label="Speed" value={`${metrics.speed}/10`} />
          <SpecRow label="Intelligence" value={`${metrics.intelligence}/10`} />
          <SpecRow
            label="Cost in / out"
            value={free ? "Free" : `${formatPrice(metrics.inputUsdPerMTok)} / ${formatPrice(metrics.outputUsdPerMTok)} per MTok`}
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
      </>
    );
  }

  return (
    <div className={shell}>
      <div key={model.id} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain p-4">
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
 * A 36px flat tile on the provider rail. No raised or inset chrome: the
 * selected one is the coral hairline over the accent fill, the rest are bare
 * marks that take the fill on hover.
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
            "flex size-9 shrink-0 items-center justify-center rounded-control transition-[background-color,color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
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

/** One group of rows in the list, with its label. */
type Group = { key: string; label: string; models: ModelInfo[]; legacy: ModelInfo[] };

export function ModelSelector({
  value,
  onChange,
  filter: modelFilter,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  filter?: (model: ModelInfo) => boolean;
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

  // Typing filters across every provider: a query clears the rail's filter
  // rather than searching inside one lab.
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
   * The groups, in display order. "All" groups by provider; a provider filter
   * is one flat list. Recents come first only in the unfiltered view, only up
   * to three, only when the list is long enough that they save a scroll, and
   * never a model already sitting in the first group on screen — a row that
   * appears twice within one viewport is noise, not a shortcut.
   */
  const groups = React.useMemo<Group[]>(() => {
    const out: Group[] = [];
    const grouped = filter === "all" || !!q;
    if (grouped) {
      for (const p of PROVIDER_LIST) {
        const mine = visible.filter((m) => m.provider === p);
        if (mine.length === 0) continue;
        out.push({
          key: p,
          label: providerName(p),
          models: mine.filter((m) => !m.legacy),
          legacy: mine.filter((m) => m.legacy),
        });
      }
    } else if (visible.length > 0) {
      out.push({
        key: "flat",
        label: "",
        models: visible.filter((m) => !m.legacy),
        legacy: visible.filter((m) => m.legacy),
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
    // A recent row and its group row are distinct buttons, so an id may
    // appear twice; the cursor visits each once.
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
          "group flex h-14 w-full items-center gap-3 rounded-control px-2.5 text-left outline-none transition-[background-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
          active
            ? "bg-accent ring-1 ring-inset ring-primary/60"
            : cursor
              ? "bg-accent"
              : "hover:bg-accent",
          soon && "cursor-not-allowed opacity-45",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          {auto ? <JunoMark className="size-4" /> : <ProviderLogo provider={m.provider} className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground">{m.name}</span>
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">{rowNote(m)}</span>
        </span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
          {soon ? "Soon" : locked ? PLANS[effectiveMinPlan(m.minPlan)].name : auto ? "" : priceGlyph(m)}
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
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions
        onKeyDown={onNavKeyDown}
        // Fixed 880×560, clamped to the viewport by Radix's available-height
        // var and a 16px margin on every side (collisionPadding does the
        // horizontal clamp by shifting the box, never by clipping it).
        style={{
          width: "min(880px, calc(100vw - 2rem))",
          height: "min(560px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Provider rail — 56px, folds under `sm`. */}
          <div className="hidden w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/50 p-2.5 sm:flex">
            <RailTile active={filter === "all"} title="All providers" onClick={() => setFilter("all")}>
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
                <ProviderLogo provider={p} className="size-4.5" />
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
                      <div key={g.key} role="group" aria-label={g.label || "Models"}>
                        {g.label && <GroupLabel>{g.label}</GroupLabel>}
                        {g.models.map((m) => renderRow(m, g.key === "recent" ? "recent:" : ""))}
                        {g.legacy.length > 0 && (
                          <details key={q ? "open" : "closed"} open={!!q} className="group/legacy pt-0.5">
                            <summary className="flex h-9 cursor-pointer items-center justify-between rounded-control px-2.5 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent">
                              <span>Past models · {g.legacy.length}</span>
                              <ChevronDown className="size-3 transition-transform duration-base group-open/legacy:rotate-180" />
                            </summary>
                            <div className="pt-0.5">{g.legacy.map((m) => renderRow(m))}</div>
                          </details>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </ScrollFade>
          </div>

          {/* Spec sheet — 300px, folds under `md`. */}
          <SpecSheet
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
