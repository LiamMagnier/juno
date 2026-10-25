"use client";

import * as React from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Star,
  Users,
  X,
} from "@/components/ui/icons";
import type { LiveComponent, LiveIngredient } from "@/lib/live-ui/spec";
import { cn } from "@/lib/utils";

/**
 * The intelligent-UI set (docs/design/LIVE_UI.md §2.4): views for what people
 * DO with an answer, the way ChatGPT's GPT-6 answers carry a recipe that
 * rescales for the guests, a question you answer with a tap, or two plans you
 * pick between. Each one keeps its own small state (a timer, a flipped card,
 * the servings), and anything that continues the conversation goes through
 * the host's `onPrompt`, the same send path as a typed message.
 */

type Of<T extends LiveComponent["type"]> = Extract<LiveComponent, { type: T }>;

/* —————————————————————————————— Recipe —————————————————————————————— */

const FRACTIONS: [number, string][] = [
  [0, ""],
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [1, ""],
];
const METRIC = new Set(["g", "kg", "ml", "l", "cl", "dl", "gram", "grams", "oz", "lb"]);
/** Things that come whole: a lemon, an egg, a head of garlic. */
const COUNTED = new Set(["", "head", "heads", "clove", "cloves", "piece", "pieces", "egg", "eggs", "can", "cans", "tin", "tins", "sheet", "sheets", "slice", "slices", "stick", "sticks"]);

/**
 * A scaled quantity as a cook writes it: ½ cup, 1¼ tsp, 350 g, 2 eggs.
 * Grams and millilitres round to what a scale shows and step up to kg and l;
 * whole things stay whole (half a lemon at most); spoons and cups snap to the
 * fractions on a measuring set.
 */
export function scaleQuantity(q: number, unit?: string, base?: number): { qty: string; unit?: string } {
  const u = (unit ?? "").toLowerCase();
  if (METRIC.has(u)) {
    if ((u === "g" || u === "gram" || u === "grams") && q >= 1000) return { qty: String(Math.round(q / 100) / 10), unit: "kg" };
    if (u === "ml" && q >= 1000) return { qty: String(Math.round(q / 100) / 10), unit: "l" };
    const n = q >= 100 ? Math.round(q / 5) * 5 : q >= 10 ? Math.round(q) : Math.round(q * 10) / 10;
    return { qty: String(n), unit };
  }
  if (COUNTED.has(u) && base !== undefined && Number.isInteger(base)) {
    const n = q < 3 ? Math.max(0.5, Math.round(q * 2) / 2) : Math.round(q);
    return { qty: fraction(n), unit };
  }
  if (q >= 10) return { qty: String(Math.round(q)), unit };
  return { qty: fraction(q), unit };
}

function fraction(q: number): string {
  const whole = Math.floor(q);
  const rest = q - whole;
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(f[0] - rest) < Math.abs(best[0] - rest)) best = f;
  const w = best[0] === 1 ? whole + 1 : whole;
  return `${w > 0 ? w : ""}${best[1]}` || "⅛";
}

/** The quantity alone, for callers that keep the unit as written. */
export function formatQuantity(q: number, unit?: string): string {
  return scaleQuantity(q, unit).qty;
}

function minutesLabel(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

type Timer = { total: number; left: number; running: boolean; endsAt?: number };

export function LiveRecipe({ recipe }: { recipe: Of<"recipe"> }) {
  const [servings, setServings] = React.useState(recipe.servings);
  const [have, setHave] = React.useState<ReadonlySet<number>>(() => new Set());
  const [done, setDone] = React.useState<ReadonlySet<number>>(() => new Set());
  const [timers, setTimers] = React.useState<Record<number, Timer>>({});
  const [copied, setCopied] = React.useState(false);
  const scale = servings / recipe.servings;
  const total = recipe.steps.reduce((sum, s) => sum + (s.minutes ?? 0), 0);

  const anyRunning = Object.values(timers).some((t) => t.running);
  React.useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setTimers((prev) => {
        const next: Record<number, Timer> = {};
        for (const [k, t] of Object.entries(prev)) {
          if (!t.running || t.endsAt === undefined) next[+k] = t;
          else {
            const left = (t.endsAt - now) / 1000;
            next[+k] = left <= 0 ? { ...t, left: 0, running: false, endsAt: undefined } : { ...t, left };
          }
        }
        return next;
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  // A step whose timer runs out is a step done.
  React.useEffect(() => {
    const finished = Object.entries(timers).filter(([, t]) => t.left === 0 && !t.running).map(([k]) => +k);
    if (finished.some((k) => !done.has(k))) setDone((d) => new Set([...d, ...finished]));
  }, [timers, done]);

  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const toggle = (set: React.Dispatch<React.SetStateAction<ReadonlySet<number>>>, i: number) =>
    set((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  const timerAction = (i: number, minutes: number) =>
    setTimers((prev) => {
      const t = prev[i] ?? { total: minutes * 60, left: minutes * 60, running: false };
      if (t.running) return { ...prev, [i]: { ...t, running: false, endsAt: undefined } };
      const left = t.left > 0 ? t.left : t.total;
      return { ...prev, [i]: { ...t, left, running: true, endsAt: Date.now() + left * 1000 } };
    });

  const amount = (ing: LiveIngredient) => {
    if (ing.qty === undefined) return "";
    const a = scaleQuantity(ing.qty * scale, ing.unit, ing.qty);
    return `${a.qty}${a.unit ? ` ${a.unit}` : ""}`;
  };
  const line = (ing: LiveIngredient) => `${ing.qty !== undefined ? `${amount(ing)} ` : ""}${ing.name}`;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          {recipe.title ? <p className="text-body font-semibold tracking-[-0.01em]">{recipe.title}</p> : null}
          <p className="flex items-center gap-3 text-ui text-muted-foreground">
            {total > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-3.5" aria-hidden />
                {minutesLabel(total)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3.5" aria-hidden />
              {recipe.ingredients.length} ingredients
            </span>
          </p>
        </div>
        <div className="live-stepper" role="group" aria-label={`Number of ${recipe.yieldLabel}`}>
          <button type="button" className="live-stepper-btn" aria-label="Fewer" disabled={servings <= 1} onClick={() => setServings((s) => Math.max(1, s - 1))}>
            <Minus className="size-3.5" aria-hidden />
          </button>
          <output key={servings} aria-live="polite" className="live-stepper-value inline-flex items-center gap-1.5 px-1.5">
            <Users className="size-3.5 text-muted-foreground" aria-hidden />
            {servings}
            <span className="text-ui font-normal text-muted-foreground">{recipe.yieldLabel}</span>
          </output>
          <button type="button" className="live-stepper-btn" aria-label="More" disabled={servings >= 100} onClick={() => setServings((s) => Math.min(100, s + 1))}>
            <Plus className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {recipe.ingredients.length ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="live-kicker">Ingredients</p>
            <button
              type="button"
              className="live-chip"
              data-copied={copied ? "" : undefined}
              onClick={() => {
                const text = recipe.ingredients.filter((_, i) => !have.has(i)).map((i) => `- ${line(i)}`).join("\n");
                void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
              }}
            >
              {copied ? <Check className="size-3.5 text-[hsl(var(--live))]" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : have.size ? "Copy what's missing" : "Copy shopping list"}
            </button>
          </div>
          <ul className="grid min-w-0 gap-x-4 gap-y-0.5 @[30rem]:grid-cols-2">
            {recipe.ingredients.map((ing, i) => {
              const on = have.has(i);
              return (
                <li key={i}>
                  <button type="button" role="checkbox" aria-checked={on} onClick={() => toggle(setHave, i)} className="live-row group/row">
                    <span aria-hidden className="live-check" data-on={on ? "" : undefined}>
                      {on ? <Check className="size-3 motion-safe:animate-pop-in" /> : null}
                    </span>
                    <span className={cn("min-w-0 text-ui transition-[color,opacity] duration-fast", on && "text-muted-foreground opacity-70 line-through decoration-foreground/25")}>
                      {ing.qty !== undefined ? (
                        <span key={`${servings}`} className="live-qty">
                          {amount(ing)}
                        </span>
                      ) : null}{" "}
                      {ing.name}
                      {ing.note ? <span className="text-muted-foreground">, {ing.note}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {recipe.steps.length ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="live-kicker">Method</p>
            <p className="text-ui tabular-nums text-muted-foreground" aria-live="polite">
              {done.size} of {recipe.steps.length} done
            </p>
          </div>
          <ol className="flex min-w-0 flex-col gap-1.5">
            {recipe.steps.map((step, i) => {
              const on = done.has(i);
              const t = timers[i];
              const ratio = t ? 1 - t.left / t.total : 0;
              return (
                <li key={i} className={cn("live-step", on && "live-step-done")}>
                  <button type="button" role="checkbox" aria-checked={on} aria-label={`Step ${i + 1} done`} onClick={() => toggle(setDone, i)} className="live-step-num">
                    {on ? <Check className="size-3.5 motion-safe:animate-pop-in" aria-hidden /> : i + 1}
                  </button>
                  <p className={cn("min-w-0 flex-1 pt-1 text-ui leading-relaxed transition-colors duration-fast", on ? "text-muted-foreground" : "text-foreground")}>{step.text}</p>
                  {step.minutes ? (
                    <button
                      type="button"
                      onClick={() => timerAction(i, step.minutes!)}
                      aria-label={t?.running ? "Pause timer" : t && t.left > 0 && t.left < t.total ? "Resume timer" : `Start a ${step.minutes} minute timer`}
                      className="live-timer"
                      data-running={t?.running ? "" : undefined}
                      data-finished={t && t.left === 0 ? "" : undefined}
                    >
                      <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
                        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth="2" />
                        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - ratio} className="transition-[stroke-dashoffset] duration-base ease-linear" />
                      </svg>
                      <span className="tabular-nums">{t ? (t.left === 0 ? "Done" : clock(t.left)) : minutesLabel(step.minutes)}</span>
                      {t?.running ? <Pause className="size-3" aria-hidden /> : t?.left === 0 ? <RotateCcw className="size-3" aria-hidden /> : <Play className="size-3" aria-hidden />}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/* —————————————————————————————— Choices —————————————————————————————— */

/**
 * A question answered with a tap (ChatGPT's multiple-choice follow-ups): the
 * pick is sent as the user's next message. One choice sends at once; a multi
 * question collects picks and sends them together. Once sent, the card keeps
 * the answer and stops taking more.
 */
export function LiveChoices({ choices, onPrompt }: { choices: Of<"choices">; onPrompt?: (text: string) => void }) {
  const [picked, setPicked] = React.useState<ReadonlySet<number>>(() => new Set());
  const [sent, setSent] = React.useState(false);
  const disabled = !onPrompt;
  const send = (indices: number[]) => {
    if (!onPrompt || indices.length === 0) return;
    const text = indices.length === 1 ? choices.options[indices[0]].prompt : indices.map((i) => choices.options[i].label).join(", ");
    onPrompt(text);
    setSent(true);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {choices.question ? <p className="text-body font-medium leading-snug">{choices.question}</p> : null}
      <div role="group" aria-label={choices.question ?? "Choices"} className="grid min-w-0 gap-2 @[30rem]:grid-cols-2">
        {choices.options.map((o, i) => {
          const on = picked.has(i);
          return (
            <button
              key={i}
              type="button"
              disabled={disabled || (sent && !on)}
              aria-pressed={on}
              title={disabled ? "Available in a conversation" : undefined}
              onClick={() => {
                if (sent) return;
                if (!choices.multi) {
                  setPicked(new Set([i]));
                  send([i]);
                  return;
                }
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(i)) next.add(i);
                  return next;
                });
              }}
              style={{ animationDelay: `${i * 40}ms` }}
              className="live-option motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              data-on={on ? "" : undefined}
              data-sent={sent ? "" : undefined}
            >
              <span aria-hidden className={cn("live-check", !choices.multi && "rounded-full")} data-on={on ? "" : undefined}>
                {on ? <Check className="size-3 motion-safe:animate-pop-in" /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="text-ui font-medium text-foreground">{o.label}</span>
                {o.detail ? <span className="text-caption text-muted-foreground">{o.detail}</span> : null}
              </span>
              {!choices.multi && !sent ? <ArrowUpRight className="live-chip-arrow size-3.5 shrink-0" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {choices.multi && !sent ? (
        <button type="button" disabled={disabled || picked.size === 0} onClick={() => send([...picked].sort((a, b) => a - b))} className="live-primary w-fit">
          Send {picked.size ? `${picked.size} selected` : "answer"}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {sent ? <p className="text-ui text-muted-foreground motion-safe:animate-fade-in">Sent. Answering below.</p> : null}
    </div>
  );
}

/* —————————————————————————————— Compare —————————————————————————————— */

export function LiveCompare({ compare, onPrompt }: { compare: Of<"compare">; onPrompt?: (text: string) => void }) {
  const [chosen, setChosen] = React.useState<number | null>(null);
  const cols = compare.options.length >= 3 ? "@[36rem]:grid-cols-3" : "@[28rem]:grid-cols-2";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {compare.title ? <p className="text-body font-medium">{compare.title}</p> : null}
      <div className={cn("grid min-w-0 grid-cols-1 gap-3", cols, compare.options.length === 4 && "@[44rem]:grid-cols-4")}>
        {compare.options.map((o, i) => {
          const best = compare.recommend === i;
          return (
            <article
              key={i}
              style={{ animationDelay: `${i * 60}ms` }}
              className="live-option-card motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              data-best={best ? "" : undefined}
              data-chosen={chosen === i ? "" : undefined}
            >
              {best || o.badge ? <span className="live-badge">{o.badge ?? "Best pick"}</span> : null}
              <div className="flex flex-col gap-1">
                <h5 className="text-body font-semibold tracking-[-0.01em]">{o.name}</h5>
                {o.price ? <p className="text-[1.375rem] font-semibold tabular-nums tracking-[-0.02em]">{o.price}</p> : null}
                {o.tagline ? <p className="text-ui leading-snug text-muted-foreground">{o.tagline}</p> : null}
              </div>
              {o.pros.length || o.cons.length ? (
                <ul className="flex flex-col gap-1.5">
                  {o.pros.map((p, k) => (
                    <li key={`p${k}`} className="grid grid-cols-[1rem_1fr] items-baseline gap-2 text-ui">
                      <Check className="size-3.5 translate-y-0.5 text-success-ink" aria-label="Pro" />
                      <span>{p}</span>
                    </li>
                  ))}
                  {o.cons.map((c, k) => (
                    <li key={`c${k}`} className="grid grid-cols-[1rem_1fr] items-baseline gap-2 text-ui text-muted-foreground">
                      <X className="size-3.5 translate-y-0.5" aria-label="Con" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {o.facts.length ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-ui">
                  {o.facts.map((f, k) => (
                    <React.Fragment key={k}>
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className="text-right font-medium tabular-nums">{f.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              ) : null}
              {o.prompt ? (
                <button
                  type="button"
                  disabled={!onPrompt || chosen !== null}
                  title={!onPrompt ? "Available in a conversation" : undefined}
                  onClick={() => {
                    setChosen(i);
                    onPrompt?.(o.prompt!);
                  }}
                  className={cn("mt-auto w-full justify-center", best ? "live-primary" : "live-chip live-chip-lg")}
                >
                  {chosen === i ? <Check className="size-3.5" aria-hidden /> : null}
                  {chosen === i ? "Chosen" : `Go with ${o.name}`}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

/* —————————————————————————————— Cards —————————————————————————————— */

function Rating({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-caption tabular-nums text-muted-foreground" aria-label={`Rated ${value} out of 5`}>
      <span className="inline-flex" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <Star key={i} weight={value >= i + 0.75 ? "fill" : undefined} className={cn("size-3", value >= i + 0.75 ? "text-[hsl(var(--warning))]" : "text-muted-foreground/50")} />
        ))}
      </span>
      {value.toFixed(1)}
    </span>
  );
}

export function LiveCards({ cards, onPrompt }: { cards: Of<"cards">; onPrompt?: (text: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {cards.title ? <p className="text-body font-medium">{cards.title}</p> : null}
      <ul className="grid min-w-0 grid-cols-1 gap-2.5 @[30rem]:grid-cols-2">
        {cards.items.map((it, i) => {
          const Tag = it.prompt && onPrompt ? "button" : "div";
          return (
            <li key={i} style={{ animationDelay: `${i * 40}ms` }} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
              <Tag
                {...(Tag === "button" ? { type: "button" as const, onClick: () => onPrompt?.(it.prompt!) } : {})}
                className={cn("live-tile group/tile", Tag === "button" && "live-tile-action")}
              >
                <span aria-hidden className="live-tile-mark">
                  {it.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="truncate text-ui font-semibold text-foreground">{it.title}</span>
                    {it.meta ? <span className="shrink-0 text-ui font-medium tabular-nums text-foreground">{it.meta}</span> : null}
                  </span>
                  {it.subtitle || it.rating !== undefined ? (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
                      {it.rating !== undefined ? <Rating value={it.rating} /> : null}
                      {it.subtitle ? <span className="truncate">{it.subtitle}</span> : null}
                    </span>
                  ) : null}
                  {it.detail ? <span className="line-clamp-2 text-caption leading-relaxed text-muted-foreground">{it.detail}</span> : null}
                  {it.tags.length ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {it.tags.map((t) => (
                        <span key={t} className="live-tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {Tag === "button" ? <ArrowUpRight className="live-chip-arrow size-3.5 shrink-0 self-center" aria-hidden /> : null}
              </Tag>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* —————————————————————————————— Tabs —————————————————————————————— */

export function LiveTabs({ tabs, render }: { tabs: Of<"tabs">; render: (list: readonly LiveComponent[]) => React.ReactNode }) {
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null);
  const id = React.useId();
  const current = Math.min(active, tabs.tabs.length - 1);

  React.useLayoutEffect(() => {
    const el = listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[current];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [current, tabs.tabs.length]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        ref={listRef}
        role="tablist"
        className="live-tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const next = (current + (e.key === "ArrowRight" ? 1 : -1) + tabs.tabs.length) % tabs.tabs.length;
          setActive(next);
          listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
        }}
      >
        {pill ? <span aria-hidden className="live-tabs-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} /> : null}
        {tabs.tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`${id}-t${i}`}
            aria-selected={i === current}
            aria-controls={`${id}-p${i}`}
            tabIndex={i === current ? 0 : -1}
            onClick={() => setActive(i)}
            className="live-tab"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div key={current} role="tabpanel" id={`${id}-p${current}`} aria-labelledby={`${id}-t${current}`} className="flex min-w-0 flex-col gap-6 motion-safe:animate-stage-in">
        {render(tabs.tabs[current].children)}
      </div>
    </div>
  );
}

/* —————————————————————————————— Flashcards —————————————————————————————— */

export function LiveFlashcards({ deck }: { deck: Of<"flashcards"> }) {
  const [index, setIndex] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);
  const [known, setKnown] = React.useState<ReadonlySet<number>>(() => new Set());
  const n = deck.cards.length;
  const card = deck.cards[index];
  const go = (next: number) => {
    setFlipped(false);
    setIndex((next + n) % n);
  };
  const mark = (got: boolean) => {
    setKnown((prev) => {
      const s = new Set(prev);
      if (got) s.add(index);
      else s.delete(index);
      return s;
    });
    go(index + 1);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-body font-medium">{deck.title ?? "Flashcards"}</p>
        <p className="text-ui tabular-nums text-muted-foreground" aria-live="polite">
          {index + 1} / {n} · {known.size} known
        </p>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden>
        <div className="live-fill h-full origin-left rounded-full transition-transform duration-slow ease-out-soft" style={{ transform: `scaleX(${known.size / n})` }} />
      </div>
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? `Answer: ${card.back}. Show the question` : `Question: ${card.front}. Show the answer`}
        className="live-flash"
        data-flipped={flipped ? "" : undefined}
      >
        <span className="live-flash-inner">
          <span className="live-flash-face">
            <span className="live-kicker">Question</span>
            <span className="text-[1.25rem] font-medium leading-snug tracking-[-0.01em]">{card.front}</span>
            <span className="text-caption text-muted-foreground">Tap to flip</span>
          </span>
          <span className="live-flash-face live-flash-back">
            <span className="live-kicker">Answer</span>
            <span className="text-body leading-relaxed">{card.back}</span>
          </span>
        </span>
      </button>
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-label="Previous card" onClick={() => go(index - 1)} className="live-stepper-btn">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={() => mark(false)} className="live-chip live-chip-lg">
            <RotateCcw className="size-3.5" aria-hidden />
            Again
          </button>
          <button type="button" onClick={() => mark(true)} className="live-primary">
            <Check className="size-3.5" aria-hidden />
            Got it
          </button>
        </div>
        <button type="button" aria-label="Next card" onClick={() => go(index + 1)} className="live-stepper-btn">
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
