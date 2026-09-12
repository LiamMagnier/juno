"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Eye,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  Search,
  SearchX,
  Star,
  Video,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
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
 * Three panes, 880×560, clamped to the viewport. The RAIL on the left names
 * every configured lab (plus All models and Favorites) and counts what each
 * one holds; pick one and the LIST shows that lab's models arranged by what
 * they make — Text, then Image, then Video — newest and strongest first, with
 * superseded generations folded behind "Past models". Point or arrow at a row
 * and the SPEC SHEET on the right fills in: intelligence, speed, context and
 * cost as four numerals over 4px ink rules, the capability chips, the price
 * per million tokens in two aligned columns, and a "Use this model" button.
 *
 * Three rules hold the surface together, and breaking any one of them is what
 * made the previous version read as a dashboard:
 *
 *  1. ONE ACCENT, FOUR USES, ALL OF THEM STATE — the selected-model check, a
 *     filled favourite star, the Use button, and the focus edge. Nothing else
 *     in this file may be coral (FLAT_UI.md §2.4: "It is never furniture").
 *     The rail's active row is the tonal `bg-secondary`, the metric fills are
 *     `bg-foreground/55`, and the badges are mono words with no capsule.
 *  2. NUMBERS FIRST, METERS SECOND — the grade is a 17px tabular numeral and
 *     the meter under it is a 4px rule. It replaced forty 20×10px coral pills
 *     that shouted the comparison while the real value sat beside them at the
 *     smallest size in the product.
 *  3. ONE LEFT EDGE AND ONE RIGHT EDGE — the rail's p-2 + row px-2, the list
 *     viewport's px-2 + row px-2, and the sheet's px-4 all land on 16px; every
 *     trailing object in the list (price, state glyph, section count) ends on
 *     the same x, so a column of prices can be read down.
 *
 * Favorites are persisted to the account and lead the All view; the star in
 * the sheet's foot toggles them. Recents stay per browser, like a draft. Auto
 * leads All as Juno's recommendation.
 *
 * Thinking effort lives HERE, as a footer under the three panes, passed in
 * by the composer as `thinking`. It used to be its own chip beside this one
 * — two words with two chevrons for one decision ("which model, how hard")
 * — and the row read as a toolbar. Claude ships effort under its model
 * list; ChatGPT folded Instant/Thinking into one entry with an effort
 * control. One chip, one popover, the model list on top and the effort
 * underneath, is the shape both converged on.
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

/**
 * The row's second line — and only below `md`, where the spec sheet is gone
 * and the description has nowhere else to live. Above `md` the row is one
 * line and this text is in the sheet, 8px to the right, in full.
 */
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
    <div aria-hidden className="flex h-7 items-center gap-2 px-2">
      <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/70">{children}</span>
      <span className="h-px flex-1 bg-border/70" />
      {count != null && (
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">{count}</span>
      )}
    </div>
  );
}

/**
 * One graded fact: the value as a numeral, the grade as a 4px ink rule.
 *
 * This replaced ten `bg-primary` pills per metric, four metrics deep — forty
 * coral blocks in a 300px column, which spent the accent on decoration and
 * still printed the number they encoded in muted grey at the smallest size in
 * the product. A 17px tabular numeral over a rule is an instrument; the pills
 * were a character sheet.
 *
 * The fill is `bg-foreground/55` on `bg-secondary` — over 3:1 on both themes
 * — and the width is the ONE thing that animates when the sheet's model
 * changes (see the note on the sheet's missing `key`).
 */
function StatCell({
  label,
  value,
  unit,
  score,
  wide,
}: {
  label: string;
  value: string;
  unit?: string;
  /** 1–10. Drives the rule's length only; `value` is what a person reads. */
  score: number;
  wide?: boolean;
}) {
  return (
    <div className={cn(wide && "col-span-2")}>
      <div className="font-mono text-micro uppercase text-muted-foreground/70">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-body-lg font-medium tabular-nums text-foreground">{value}</span>
        {unit && <span className="font-mono text-micro text-muted-foreground/60">{unit}</span>}
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
        {/* An inline width percentage: this is DATA, not a colour — the same
            precedent as Progress's inline transform and the popover's own
            inline size below. */}
        <div
          aria-hidden
          className="h-full rounded-full bg-foreground/55 transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
          style={{ width: `${Math.max(0, Math.min(10, score)) * 10}%` }}
        />
      </div>
    </div>
  );
}

function CapabilityChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-control border border-border px-2 font-mono text-micro uppercase leading-none text-muted-foreground">
      <Icon className="size-3 text-muted-foreground/70" />
      <span>{label}</span>
    </span>
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
 * The spec sheet. A fixed 300px column with its own scroll; the "Use this
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
  // `lg`, not `md`. The popover's width is `min(880, 100vw - 2rem)`, so at a
  // 768px viewport it is 736px wide — and 180 (rail) + 300 (sheet) leaves the
  // list 254px, which truncates "Claude Sonnet 5" to "Cla…". The sheet is the
  // pane that folds first, so it folds one breakpoint higher than the spec's
  // table assumed; the row's second line follows it (see `renderRow`).
  const shell = "hidden w-[300px] shrink-0 flex-col border-l border-border/70 bg-background/60 lg:flex";
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const modelId = model?.id;

  // The pane used to be `key={model.id}` + `animate-fade-in`, which remounted
  // and re-faded 300px of column on EVERY arrow keypress: holding ↓ flickered,
  // the meters' own transition could never run, and the scroll position reset
  // anyway. Keeping the container mounted lets the four meters interpolate
  // their widths — the single piece of motion on this surface — and the scroll
  // reset the remount used to give for free is this one effect instead.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [modelId]);

  if (!model) {
    return (
      <div className={cn(shell, "items-center justify-center p-5")}>
        <p className="text-center text-caption text-muted-foreground">Select a model to see its specs.</p>
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

  const identity = (
    <div className="flex items-center gap-3">
      {auto ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-logo bg-secondary">
          <JunoMark className="size-4.5" />
        </span>
      ) : (
        <ProviderLogo provider={model.provider} className="size-8" />
      )}
      <div className="min-w-0">
        <h3 className="truncate text-heading leading-tight tracking-tight">{model.name}</h3>
        <p className="truncate font-mono text-micro text-muted-foreground">
          {auto ? "Juno" : providerName(model.provider)}
          {model.released ? ` · ${model.released}` : ""}
        </p>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (auto) {
    body = (
      <>
        {identity}
        <p className="text-ui leading-relaxed text-muted-foreground">
          Routes each message to the <span className="font-medium text-foreground">best model</span> and{" "}
          <span className="font-medium text-foreground">thinking depth</span> for speed, intelligence and cost.
        </p>
        <ul className="space-y-2 text-ui leading-snug text-muted-foreground">
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">1</span>
            Everyday prompt → Fast models · Instant
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">2</span>
            Coding &amp; analysis → Mid tier · Balanced
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">3</span>
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
    const expensiveness = expensivenessScore(metrics);
    const cells: { label: string; value: string; unit?: string; score: number }[] = generative
      ? [
          { label: "Quality", value: String(metrics.intelligence), unit: "/10", score: metrics.intelligence },
          { label: "Speed", value: String(metrics.speed), unit: "/10", score: metrics.speed },
          { label: "Cost", value: String(expensiveness), unit: "/10", score: expensiveness },
        ]
      : [
          { label: "Intelligence", value: String(metrics.intelligence), unit: "/10", score: metrics.intelligence },
          { label: "Speed", value: String(metrics.speed), unit: "/10", score: metrics.speed },
          {
            label: "Context",
            value: formatContext(metrics.contextTokens),
            score: contextScore(metrics.contextTokens),
          },
          { label: "Cost", value: String(expensiveness), unit: "/10", score: expensiveness },
        ];
    const hasChips = model.vision || model.reasoning || model.webSearch || isFastModel(model) || generative;
    body = (
      <>
        {identity}

        {model.status === "deprecated" && (
          // Tonal fill, warning INK only. A `bg-warning/10` block here was a
          // second coloured object competing with the accent Use button 300px
          // below it, in a column that can only afford one.
          <div className="flex items-start gap-2 rounded-control border border-border bg-secondary px-2.5 py-2 text-caption text-warning">
            <StatusIcons.warning className="mt-px size-3.5 shrink-0" />
            <span>
              {model.retiresOn ? `Available until ${formatRetirementDate(model.retiresOn)}` : "Retiring soon"}
            </span>
          </div>
        )}

        {/* `line-clamp-3` is load-bearing: it fixes the y of the stat grid, the
            chips and the price block, so those land in the same place for every
            model in the list. That stillness is what lets the four meters read
            as the only thing moving. The full text is on `title`. */}
        <p
          title={model.description ?? undefined}
          className="line-clamp-3 text-ui leading-relaxed text-muted-foreground"
        >
          {model.description ?? "Capable foundation model."}
        </p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          {cells.map((c, i) => (
            <StatCell
              key={c.label}
              label={c.label}
              value={c.value}
              unit={c.unit}
              score={c.score}
              wide={cells.length % 2 === 1 && i === cells.length - 1}
            />
          ))}
        </div>

        {hasLiveBenchmark(model) && (
          <p className="font-mono text-micro text-muted-foreground/60">
            Scores by{" "}
            <a
              href="https://artificialanalysis.ai"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground"
            >
              Artificial Analysis
            </a>
          </p>
        )}

        {hasChips && (
          <div className="flex flex-wrap gap-1.5">
            {model.modality === "image" && <CapabilityChip icon={ImageIcon} label="Image" />}
            {model.modality === "video" && <CapabilityChip icon={Video} label="Video" />}
            {model.vision && <CapabilityChip icon={Eye} label="Vision" />}
            {/* Waypoints, not a BRAIN. Extended thinking is the model working
                through intermediate steps before answering — a route with stops
                on it. A brain says "this one is intelligent", which is either
                true of every row here or of none of them, and is the single
                most worn-out mark in AI product design. */}
            {model.reasoning && <CapabilityChip icon={Waypoints} label="Thinking" />}
            {model.webSearch && <CapabilityChip icon={ComposerIcons.web} label="Search" />}
            {/* Raw `Zap`. This bolt is SPEED, not the Juno Work destination. */}
            {isFastModel(model) && <CapabilityChip icon={Zap} label="Fast" />}
          </div>
        )}

        <div className="border-t border-border pt-3">
          <div className="font-mono text-micro uppercase text-muted-foreground/70">Price per million tokens</div>
          {free ? (
            <p className="mt-1 text-body-lg font-medium">Free</p>
          ) : (
            // Money at 17px in two aligned columns. It was 12px prose under a
            // 1-to-10 "Cost" grade that carried four times its weight — and the
            // price is the fact people actually compare.
            <div className="mt-1 grid grid-cols-2 gap-x-3">
              <div className="flex items-baseline gap-1.5">
                <span className="text-body-lg font-medium tabular-nums">{formatPrice(metrics.inputUsdPerMTok)}</span>
                <span className="font-mono text-micro uppercase text-muted-foreground">in</span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-body-lg font-medium tabular-nums">{formatPrice(metrics.outputUsdPerMTok)}</span>
                <span className="font-mono text-micro uppercase text-muted-foreground">out</span>
              </div>
            </div>
          )}
          {locked && (
            <p className="mt-2 text-caption text-muted-foreground">
              Requires the {PLANS[effectiveMinPlan(model.minPlan)].name} plan.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={shell}>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain px-4 pb-3 pt-4">
        {body}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
        {soon || selected ? (
          /* NOT a disabled accent button.
             The accent at 40% is the treatment the composer's send circle lost
             this pass, and for the reason it lost it: a washed-out primary
             reads as a control that failed, not as a state. A model that is
             already chosen (or not yet available) therefore gets a quiet tonal
             strip — `--secondary` fill, muted ink, no accent anywhere — that
             STATES the fact instead of offering a press. It is not a button
             and not focusable, so nothing here invites an action that would
             do nothing. Every other model keeps the full-strength accent. */
          <div className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-secondary px-3 text-ui font-medium text-muted-foreground coarse:h-10">
            {selected && <StatusIcons.success aria-hidden className="size-3.5 shrink-0" />}
            <span className="truncate">{useLabel}</span>
          </div>
        ) : (
          /* The one filled object in the whole popover. A locked model keeps
             the accent and stays enabled — upgrading IS the action. */
          <Button type="button" size="sm" className="min-w-0 flex-1" onClick={onUse}>
            {useLabel}
          </Button>
        )}
        {!auto && !soon && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="shrink-0"
                aria-pressed={starred}
                aria-label={starred ? "Remove from favorites" : "Add to favorites"}
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
 * A named row on the lab rail — 32px tall, 2px apart.
 *
 * It was a 32px icon-only tile with a tooltip, 16 of them in a 48px strip that
 * silently overflowed its own height: telling "Meituan" from "MiniMax" from
 * "MiMo" meant hovering each one. The reference product labels every row, so
 * this one does too, and the tooltip goes away with the guessing.
 *
 * Active is `bg-secondary` — the tonal "selected" fill. The old accent ring
 * spent the brand colour on a filter state, which FLAT_UI.md §2.4 forbids.
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
        "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left outline-none",
        "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {/* A fixed 18px box, so the glyph column is a column whether the mark is a
          20px provider tile scaled down or a 16px lucide stroke. */}
      <span className="flex size-4.5 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1 truncate text-ui">{label}</span>
      {!!count && (
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground/70">{count}</span>
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
   * The rail's counts read from HERE — through `modelFilter` (the caller's
   * capability predicate) and the query, never through `filter`. Reading them
   * through `filter` would print 0 beside every lab the moment one lab is
   * picked; ignoring `modelFilter` is the bug that let the Work composer offer
   * labs whose every model it then refused to show.
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

  const favoritesCount = React.useMemo(
    () => searchable.filter((m) => favorites.has(m.id)).length,
    [searchable, favorites],
  );

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
    const starred = !auto && favorites.has(m.id);
    const caption = auto ? "Picks the best model and thinking depth for each message." : rowCaption(m);
    const price = auto ? "" : soon ? "Soon" : locked ? PLANS[effectiveMinPlan(m.minPlan)].name : priceLabel(m);
    const caps = [m.vision ? "Vision" : null, m.reasoning ? "Thinking" : null, m.webSearch ? "Search" : null].filter(
      (c): c is string => !!c,
    );

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
        // The glyph column is aria-hidden, so the row's label carries what it says.
        aria-label={`${m.name}, ${auto ? "Juno" : providerName(m.provider)}${caps.length ? `, ${caps.join(", ")}` : ""}${price ? `, ${price}` : ""}`}
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
          "flex min-h-11 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left outline-none lg:h-11 lg:py-0",
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
          <span className="flex size-5 shrink-0 items-center justify-center rounded-logo border border-border/55 bg-card shadow-pop">
            <JunoMark className="size-3" />
          </span>
        ) : (
          <ProviderLogo provider={m.provider} className="size-5" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium text-foreground">{m.name}</span>
            {starred && <Star aria-hidden className="size-3 shrink-0 fill-current text-primary" />}
            {auto && (
              <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/70">Recommended</span>
            )}
            {!auto && isNew(m) && (
              <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/70">New</span>
            )}
            {deprecated && (
              <span title={m.deprecationNote ?? "Deprecated by the provider"} className="shrink-0 font-mono text-micro text-warning">
                {m.retiresOn ? `Until ${formatRetirementDate(m.retiresOn)}` : "Retiring"}
              </span>
            )}
          </span>
          {/* Below `lg` the sheet is gone, so the description has to survive on
              the row. Above it, the sheet is 8px away with the full text. */}
          {caption && <span className="block truncate text-caption text-muted-foreground lg:hidden">{caption}</span>}
        </span>
        {/* Three fixed slots so this is a column, not a ragged run of glyphs.
            An absent capability holds its space. */}
        <span aria-hidden className="flex w-11 shrink-0 items-center justify-end gap-1">
          {m.vision ? <Eye className="size-3 text-muted-foreground/70" /> : <span className="size-3" />}
          {m.reasoning ? <Waypoints className="size-3 text-muted-foreground/70" /> : <span className="size-3" />}
          {m.webSearch ? <ComposerIcons.web className="size-3 text-muted-foreground/70" /> : <span className="size-3" />}
        </span>
        <span className="w-[76px] shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground">
          {price}
        </span>
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
        // Fixed 880×560, clamped to the viewport by Radix's available-height
        // var and a 16px margin on every side (collisionPadding does the
        // horizontal clamp by shifting the box, never by clipping it). The
        // extra width over the old 760 buys the rail its labels; the extra
        // height buys one more row.
        style={{
          width: "min(880px, calc(100vw - 2rem))",
          height: "min(560px, var(--radix-popover-content-available-height))",
        }}
        className="flex max-w-none flex-col overflow-hidden rounded-popover p-0"
      >
        <div className="flex min-h-0 flex-1">
          {/* Lab rail — 180px, folds under `sm`. Only labs with something in them. */}
          <div className="hidden w-[180px] shrink-0 flex-col border-r border-border/70 sm:flex">
            <ScrollFade className="min-h-0 flex-1" viewportClassName="p-2">
              <div className="flex flex-col gap-0.5">
                {/* While a query is running the list shows every lab, so the
                    rail has to say "All models" — it used to claim a lab that
                    was not the one on screen. `filter` itself is untouched, so
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
                  count={favoritesCount}
                  onClick={() => {
                    setFilter("favorites");
                    setQuery("");
                  }}
                >
                  <Star className={cn("size-4", !q && filter === "favorites" && "fill-current")} />
                </RailRow>
                {/* The eyebrow only exists to name the labs under it, so a
                    query that matches nothing takes it with them. */}
                {railProviders.length > 0 && (
                  <div aria-hidden className="px-2 pb-1 pt-2.5 font-mono text-micro uppercase text-muted-foreground/70">
                    Labs
                  </div>
                )}
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
                    <ProviderLogo provider={p} className="size-4.5" />
                  </RailRow>
                ))}
              </div>
            </ScrollFade>
          </div>

          {/* List */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/70 p-2">
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
            <ScrollFade className="min-h-0 flex-1" viewportClassName="px-2 pb-2 pt-1">
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

          {/* Spec sheet — 300px, folds under `lg` (see the note on its shell). */}
          <DetailPanel
            model={sheetModel}
            selected={!!sheetModel && (isAutoModelId(sheetModel.id) ? autoSelected : value === sheetModel.id)}
            locked={!!sheetModel && isLocked(sheetModel)}
            starred={!!sheetModel && favorites.has(sheetModel.id)}
            onUse={() => sheetModel && select(sheetModel)}
            onToggleStar={() => sheetModel && toggleFavorite(sheetModel.id)}
          />
        </div>
        {thinking && (
          // The label is in the mono metadata voice, like every other label on
          // this surface — it was the one 13px sentence-weight word here. No
          // `flex-wrap`: at 880px it never needs to, and wrapping produced a
          // two-row footer nobody designed.
          <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-2.5">
            <span className="shrink-0 font-mono text-micro uppercase text-muted-foreground/70">Thinking effort</span>
            <div className="min-w-0 flex-1">{thinking}</div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
