"use client";

import * as React from "react";
import { Check, ExternalLink } from "@/components/ui/icons";
import type { LiveComponent, LiveExplorerPart } from "@/lib/live-ui/spec";
import { cn } from "@/lib/utils";

/*
 * The three Live UI components that are about THINGS rather than numbers:
 * the explorer (parts of a system you click into), the route (ordered stops)
 * and the checklist. None of them evaluates anything; their state is a
 * selection or a set of ticks.
 */

type Explorer = Extract<LiveComponent, { type: "explorer" }>;
type Stops = Extract<LiveComponent, { type: "stops" }>;
type Checklist = Extract<LiveComponent, { type: "checklist" }>;

// ── Explorer ────────────────────────────────────────────────────────────────

/**
 * With positions, a schematic: the parts sit where the author placed them on
 * a 100 × 100 field, joined by hairlines, and each one is a real button.
 * Without, a list beside the detail. Either way the detail is the hero — the
 * selected part's name, what it does, and its facts — and the selection moves
 * with the arrow keys as well as the pointer.
 */
export function LiveExplorer({ explorer }: { explorer: Explorer }) {
  const [selected, setSelected] = React.useState(explorer.parts[0]?.id);
  const part = explorer.parts.find((p) => p.id === selected) ?? explorer.parts[0];
  const placed = explorer.parts.every((p) => p.at);
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const detailId = React.useId();

  const move = (delta: number) => {
    const i = explorer.parts.findIndex((p) => p.id === part.id);
    const next = explorer.parts[(i + delta + explorer.parts.length) % explorer.parts.length];
    setSelected(next.id);
    refs.current[next.id]?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
  };

  const byId = new Map(explorer.parts.map((p) => [p.id, p]));
  // Crop the field to the band the parts occupy (native does the same), so a
  // schematic drawn in the top two-thirds leaves no empty band under it.
  const ys = explorer.parts.map((p) => p.at?.[1] ?? 50);
  const lo = Math.max(0, Math.min(...ys) - 10);
  const hi = Math.min(100, Math.max(...ys) + 14);
  const span = Math.max(0.2, (hi - lo) / 100);
  const fy = (y: number) => ((y - lo) / (hi - lo)) * 100;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {explorer.title ? <p className="text-ui font-medium">{explorer.title}</p> : null}
      {placed ? (
        <div
          role="listbox"
          aria-label={explorer.title ?? "Parts"}
          aria-orientation="horizontal"
          onKeyDown={onKey}
          className="relative mx-auto w-full max-w-xl"
          style={{ aspectRatio: `${2 / span}` }}
        >
          <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {explorer.links.map(([a, b], i) => {
              const pa = byId.get(a)!.at!;
              const pb = byId.get(b)!.at!;
              const lit = part.id === a || part.id === b;
              return (
                <line
                  key={i}
                  x1={pa[0]}
                  y1={fy(pa[1])}
                  x2={pb[0]}
                  y2={fy(pb[1])}
                  stroke={lit ? "hsl(var(--foreground) / 0.55)" : "hsl(var(--foreground) / 0.18)"}
                  strokeWidth={lit ? 1.5 : 1}
                  vectorEffect="non-scaling-stroke"
                  className="transition-[stroke] duration-base motion-reduce:transition-none"
                />
              );
            })}
          </svg>
          {explorer.parts.map((p) => {
            const on = p.id === part.id;
            const [x, y] = p.at!;
            const labelBelow = y < 78;
            return (
              <button
                key={p.id}
                ref={(el) => {
                  refs.current[p.id] = el;
                }}
                type="button"
                role="option"
                aria-selected={on}
                aria-controls={detailId}
                tabIndex={on ? 0 : -1}
                onClick={() => setSelected(p.id)}
                style={{ left: `${x}%`, top: `${fy(y)}%` }}
                className={cn(
                  "group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-control p-1",
                  !labelBelow && "flex-col-reverse",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "block size-3.5 rounded-full border-[1.5px] transition-[background-color,border-color,transform] duration-fast ease-out-soft motion-reduce:transition-none",
                    on
                      ? "scale-110 border-foreground bg-foreground"
                      : "border-foreground/45 bg-background group-hover:border-foreground",
                  )}
                />
                <span
                  className={cn(
                    "whitespace-nowrap rounded-sm bg-background/85 px-1 text-caption leading-tight transition-colors duration-fast motion-reduce:transition-none",
                    on ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className={cn("grid min-w-0 gap-5", !placed && "@[34rem]:grid-cols-[minmax(10rem,14rem)_1fr]")}>
        {!placed ? (
          <div role="listbox" aria-label={explorer.title ?? "Parts"} onKeyDown={onKey} className="flex min-w-0 flex-col gap-0.5">
            {explorer.parts.map((p) => {
              const on = p.id === part.id;
              return (
                <button
                  key={p.id}
                  ref={(el) => {
                    refs.current[p.id] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-controls={detailId}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-start rounded-control px-3 py-2 text-left transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
                    on ? "bg-selected" : "hover:bg-accent",
                  )}
                >
                  <span className={cn("text-ui", on ? "font-medium text-foreground" : "text-foreground/85")}>{p.label}</span>
                  {p.summary ? <span className="line-clamp-1 text-caption text-muted-foreground">{p.summary}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <PartDetail id={detailId} part={part} framed={placed} />
      </div>
    </div>
  );
}

function PartDetail({ id, part, framed }: { id: string; part: LiveExplorerPart; framed: boolean }) {
  return (
    <div id={id} aria-live="polite" className={cn("flex min-w-0 flex-col gap-2", framed && "border-t border-border/60 pt-4")}>
      <p key={part.id} className="text-body font-medium motion-safe:animate-fade-in">
        {part.label}
      </p>
      {part.summary && part.summary !== part.detail ? <p className="text-ui text-muted-foreground">{part.summary}</p> : null}
      {part.detail ? <p className="text-ui leading-relaxed text-foreground/90">{part.detail}</p> : null}
      {part.facts.length ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-ui">
          {part.facts.map((f, i) => (
            <React.Fragment key={i}>
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="tabular-nums text-foreground">{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

// ── Stops ───────────────────────────────────────────────────────────────────

/** The only URLs a view can open: Apple Maps and Google Maps, built here from
 *  the stop's own text. Never a URL the model wrote. */
export function appleMapsURL(query: string): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
}

export function googleRouteURL(queries: string[]): string | null {
  if (queries.length < 2 || queries.length > 10) return null;
  const params = new URLSearchParams({ api: "1", origin: queries[0], destination: queries[queries.length - 1] });
  if (queries.length > 2) params.set("waypoints", queries.slice(1, -1).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function LiveStops({ stops }: { stops: Stops }) {
  const route = googleRouteURL(stops.stops.map((s) => s.query));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {stops.title ? <p className="text-ui font-medium">{stops.title}</p> : null}
      <ol className="flex min-w-0 flex-col">
        {stops.stops.map((s, i) => {
          const last = i === stops.stops.length - 1;
          return (
            <li key={i} className="group/stop relative grid min-w-0 grid-cols-[1.75rem_1fr_auto] gap-x-3">
              {!last ? <span aria-hidden className="absolute bottom-0 left-[0.875rem] top-7 w-px -translate-x-1/2 bg-border" /> : null}
              <span
                aria-hidden
                className="relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full border border-foreground/20 bg-background text-caption font-medium tabular-nums text-foreground"
              >
                {i + 1}
              </span>
              <div className={cn("flex min-w-0 flex-col gap-0.5", !last && "pb-4")}>
                <p className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 text-ui font-medium text-foreground">{s.name}</span>
                </p>
                {s.note ? <p className="text-ui text-muted-foreground">{s.note}</p> : null}
                <a
                  href={appleMapsURL(s.query)}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  referrerPolicy="no-referrer"
                  className="mt-0.5 inline-flex w-fit items-center gap-1 text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Open in Maps
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
              <span className="pt-1 text-ui tabular-nums text-muted-foreground">{s.time ?? ""}</span>
            </li>
          );
        })}
      </ol>
      {route ? (
        <a
          href={route}
          target="_blank"
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
          className="inline-flex w-fit items-center gap-1.5 text-ui text-foreground underline-offset-4 hover:underline"
        >
          Open the whole route
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

// ── Checklist ───────────────────────────────────────────────────────────────

export function LiveChecklist({
  checklist,
  checked,
  onToggle,
}: {
  checklist: Checklist;
  checked: readonly number[];
  onToggle: (index: number) => void;
}) {
  const done = checklist.items.filter((_, i) => checked.includes(i)).length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-ui font-medium">{checklist.title ?? "Checklist"}</p>
        <p className="text-ui tabular-nums text-muted-foreground" aria-live="polite">
          {done} of {checklist.items.length} done
        </p>
      </div>
      <ul className="flex flex-col">
        {checklist.items.map((item, i) => {
          const on = checked.includes(i);
          return (
            <li key={i}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => onToggle(i)}
                className="flex w-full min-w-0 items-start gap-3 rounded-control px-1 py-1.5 text-left transition-colors duration-fast hover:bg-accent motion-reduce:transition-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors duration-fast motion-reduce:transition-none",
                    on ? "border-foreground bg-foreground text-background" : "border-foreground/35",
                  )}
                >
                  {on ? <Check className="size-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-ui transition-colors duration-fast", on ? "text-muted-foreground line-through decoration-foreground/30" : "text-foreground")}>
                    {item.label}
                  </span>
                  {item.note ? <span className="text-caption text-muted-foreground">{item.note}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
