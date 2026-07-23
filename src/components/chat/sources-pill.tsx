"use client";

import * as React from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { SourceFavicon, hostOf, titleOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/** How many logos the collapsed pill shows before it just reports the count. */
const CLUSTER_MAX = 3;

function SourceRow({ source, index }: { source: ClientSource; index: number }) {
  return (
    <li>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "group/row relative z-0 flex items-center gap-2.5 rounded-[14px] border border-transparent p-2",
          "transition-[transform,box-shadow,border-color,background-color] duration-base ease-out-soft motion-reduce:transition-none",
          // Hover is a LIFT: the row resolves into a card and rises. `relative` +
          // `hover:z-10` so the next row's fill can't paint over this one's shadow.
          "hover:z-10 hover:border-border/70 hover:bg-card hover:shadow-float motion-safe:hover:-translate-y-0.5"
        )}
      >
        {/* Keeps the inline [n] chips and this list readable as the same numbering. */}
        <span className="w-4 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground/50">
          {index}
        </span>
        <SourceFavicon url={source.url} variant="list" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body leading-tight text-foreground/90 transition-colors duration-fast group-hover/row:text-foreground motion-reduce:transition-none">
            {titleOf(source)}
          </span>
          <span className="truncate font-mono text-caption text-muted-foreground/70">{hostOf(source.url)}</span>
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-base ease-out-soft group-hover/row:opacity-100 motion-reduce:transition-none"
        />
      </a>
    </li>
  );
}

/**
 * The message's source footer: a pill carrying a stacked logo cluster, which
 * expands into the full cited list.
 */
export function SourcesPill({ sources, className }: { sources: ClientSource[]; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();

  /*
   * The grid-rows 0fr→1fr expand REQUIRES overflow-hidden to clip the rows while
   * they animate — but that same clip slices each row's hover shadow flat into a
   * hard bar. So: clip only WHILE animating, then release. Collapsing re-clips
   * immediately (settled resets with `open`), which is what the animation needs.
   */
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    // duration-base (220ms) + a frame of margin.
    const t = window.setTimeout(() => setSettled(true), 240);
    return () => window.clearTimeout(t);
  }, [open]);

  // One logo per SITE: five citations of nature.com must read as one nature.com,
  // not as three identical logos pretending to be breadth.
  const cluster = React.useMemo(() => {
    const seen = new Set<string>();
    const out: ClientSource[] = [];
    for (const source of sources) {
      const host = hostOf(source.url);
      if (seen.has(host)) continue;
      seen.add(host);
      out.push(source);
      if (out.length === CLUSTER_MAX) break;
    }
    return out;
  }, [sources]);

  return (
    <div className={cn("mt-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "group/pill relative z-0 inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-card pl-1.5 pr-3 shadow-soft",
          "transition-[transform,box-shadow,border-color] duration-base ease-out-soft motion-reduce:transition-none",
          "hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5",
          // 44px touch target keeps its concentric geometry: radius 22 − 10px inset = 12.
          "coarse:h-11 coarse:pl-2.5"
        )}
      >
        <span className="flex" aria-hidden="true">
          {cluster.map((source, i) => (
            <SourceFavicon
              key={source.url}
              url={source.url}
              variant="cluster"
              // `ring-card` matches the pill's fill, so the overlap reads as a
              // cut-out rather than a stack of discs. ring-2 around a size-5 box
              // is a 24px visual circle — exactly the pill's 18px radius minus
              // its 6px inset, so the avatars sit concentric inside it.
              className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")}
              // First logo on top, per the stacked-avatar convention.
              style={{ zIndex: cluster.length - i }}
            />
          ))}
        </span>
        <span className="font-mono text-label text-muted-foreground transition-colors duration-fast group-hover/pill:text-foreground motion-reduce:transition-none">
          Sources
        </span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground/60">{sources.length}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Body stays mounted so open/close animate height; `inert` keeps the
          collapsed links off the tab order. */}
      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")} inert={!open}>
          <ul className="mt-1.5 flex max-w-xl flex-col gap-0.5 py-0.5">
            {sources.map((source, i) => (
              // Sources can repeat a URL across citations, so the index has to
              // be part of the key — it's also what the row displays.
              <SourceRow key={`${i}-${source.url}`} source={source} index={i + 1} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
