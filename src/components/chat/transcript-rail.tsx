"use client";

import * as React from "react";
import {
  activeRailTurn, fitRail, nearestRailItem, railTurns, tickScale,
  type RailMessage,
} from "@/lib/chat/transcript-rail";
import type { TranscriptLayout } from "@/lib/chat/transcript-window";
import { cn } from "@/lib/utils";

/**
 * The navigation rail on the transcript's right edge (after beui's message
 * scroller): a tick per turn, the one being read lit and its neighbours
 * tapering, a card with the question and the start of its answer on hover or
 * keyboard focus, and a jump on press. The rules live in
 * lib/chat/transcript-rail.ts; this draws them.
 *
 * Motion is CSS on the product's rungs, not a spring library: the ticks scale
 * on --dur-base, the card glides between ticks on the same rung and its words
 * cross-fade, and reduced motion takes all three away (globals.css).
 */
export function TranscriptRail({
  messages,
  layout,
  viewport,
  atBottom,
  onFocusMessage,
  onJumpToLatest,
  className,
}: {
  messages: readonly RailMessage[];
  layout: TranscriptLayout;
  viewport: { top: number; height: number };
  atBottom: boolean;
  onFocusMessage: (messageId: string) => void;
  onJumpToLatest: () => void;
  className?: string;
}) {
  const navRef = React.useRef<HTMLElement>(null);
  const [height, setHeight] = React.useState(0);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  // A finger cannot hover: a tap jumps AND shows the card, until the next tap elsewhere.
  const [pinnedId, setPinnedId] = React.useState<string | null>(null);
  const tapRef = React.useRef(false);

  React.useLayoutEffect(() => {
    const nav = navRef.current?.parentElement;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(nav.clientHeight));
    observer.observe(nav);
    setHeight(nav.clientHeight);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!pinnedId) return;
    const away = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setPinnedId(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [pinnedId]);

  const turns = React.useMemo(() => railTurns(messages), [messages]);
  const { items, itemSize } = React.useMemo(() => fitRail(turns, height), [turns, height]);
  const overflowing = layout.total > viewport.height + 1;
  const visible = turns.length > 1 && overflowing && items.length > 1;

  const active = nearestRailItem(items, turns, activeRailTurn(turns, layout, { ...viewport, atBottom }));
  const shown = hoveredId ?? pinnedId ?? focusedId;
  const highlighted = shown ?? active;
  const highlightedIndex = items.findIndex((item) => item.id === highlighted);
  const card = shown ? items.find((item) => item.id === shown) : undefined;
  // The card keeps its last words while it fades out, rather than emptying first.
  const [lastCard, setLastCard] = React.useState(card);
  if (card && card !== lastCard) setLastCard(card);
  const drawn = card ?? lastCard;
  const cardIndex = drawn ? items.indexOf(drawn) : -1;
  const railTop = (height - items.length * itemSize) / 2;

  const select = (id: string) => {
    if (id === turns[turns.length - 1]?.id) onJumpToLatest();
    else onFocusMessage(id);
  };

  return (
    <div
      data-slot="transcript-rail"
      aria-hidden={!visible || undefined}
      className={cn(
        "pointer-events-none absolute inset-y-3 right-1 w-7 transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <nav
        ref={navRef}
        aria-label="Conversation turns"
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setHoveredId(null); }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null); }}
        className={cn("absolute inset-x-0 flex flex-col", visible && "pointer-events-auto")}
        style={{ top: Math.max(0, railTop) }}
      >
        {visible && items.map((item, index) => {
          const lit = item.id === highlighted;
          const scale = tickScale(highlightedIndex < 0 ? Infinity : Math.abs(index - highlightedIndex));
          return (
            <button
              key={item.id}
              type="button"
              data-slot="transcript-rail-item"
              aria-label={`Go to turn ${item.position} of ${turns.length}: ${item.label}`}
              aria-current={item.id === active ? "location" : undefined}
              style={{ height: itemSize }}
              onPointerEnter={(event) => { if (event.pointerType === "mouse") setHoveredId(item.id); }}
              onPointerDown={(event) => { tapRef.current = event.pointerType !== "mouse"; setFocusedId(null); }}
              onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id); }}
              onClick={() => {
                if (tapRef.current) setPinnedId(item.id);
                tapRef.current = false;
                select(item.id);
              }}
              className="group/tick flex w-7 items-center justify-end rounded-xs text-muted-foreground/45 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn(
                  "block h-px w-4 origin-right bg-current transition-[transform,color] duration-base ease-spring motion-reduce:transition-none",
                  lit ? "text-foreground" : "group-hover/tick:text-muted-foreground",
                )}
                style={{ transform: `scaleX(${scale})` }}
              />
            </button>
          );
        })}
      </nav>

      {/* The card is a preview, not a control: the ticks carry the names. */}
      <div
        aria-hidden
        className={cn(
          "absolute right-8 w-64 max-w-[calc(100vw-5rem)] -translate-y-1/2 transition-[top,opacity] duration-base ease-spring motion-reduce:transition-none",
          card && visible ? "opacity-100" : "opacity-0",
        )}
        style={{ top: Math.max(0, railTop) + Math.max(0, cardIndex) * itemSize + itemSize / 2 }}
      >
        {drawn && cardIndex >= 0 && (
          <div className="rounded-card border bg-popover p-3 shadow-float">
            <div key={drawn.id} className="motion-safe:animate-fade-in">
              <p className="line-clamp-1 text-xs font-medium leading-4 text-foreground">{drawn.label}</p>
              {drawn.description && (
                <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{drawn.description}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
