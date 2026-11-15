"use client";

import * as React from "react";
import { CloseButton } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import type { ContextUsage } from "@/lib/chat/context-usage";
import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { useReducedMotion } from "@/lib/motion-preference";
import { cn } from "@/lib/utils";

/**
 * WHAT THE LAST REQUEST PUT IN THE MODEL'S WINDOW, split the way it is billed.
 *
 * A prompt is a cached prefix plus what is new since: cache hits (read back
 * from the provider's prompt cache, billed at a fraction) and fresh input
 * (billed in full). They are drawn in that order, left to right, in two
 * colours validated as a pair in both themes (teal fresh, amber cache: the
 * dataviz palette validator's lightness, chroma, colour-blind and contrast
 * checks all pass, globals in signature.css). The rest of the window is the
 * track. Every colour has a label and an exact count beside it, so identity
 * never rides on colour alone.
 *
 * A provider that does not report cache reads has `cachedTokens: null`: the
 * whole input is drawn as fresh and the panel says why, rather than showing a
 * cache figure of 0 that would read as "no cache hits".
 */
export interface ContextSplit {
  cached: number;
  fresh: number;
  remaining: number;
  window: number;
  /** Share of the window in use, 0–1. */
  used: number;
  /** False when the provider did not say how much came from cache. */
  cacheReported: boolean;
}

export function contextSplit(usage: ContextUsage): ContextSplit {
  const window = Math.max(1, usage.windowTokens);
  const input = Math.max(0, Math.min(usage.inputTokens, window));
  const cacheReported = usage.cachedTokens !== null;
  const cached = cacheReported ? Math.max(0, Math.min(usage.cachedTokens ?? 0, input)) : 0;
  return { cached, fresh: input - cached, remaining: window - input, window, used: input / window, cacheReported };
}

/** A ring the size of a glyph: cache, then fresh, round from twelve o'clock. */
function ContextRing({ split }: { split: ContextSplit }) {
  const r = 6.25;
  const c = 2 * Math.PI * r;
  const cachedLen = (split.cached / split.window) * c;
  const freshLen = (split.fresh / split.window) * c;
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-foreground/[0.12]" />
      {split.cached > 0 ? (
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" stroke="hsl(var(--ctx-cache))" strokeDasharray={`${cachedLen} ${c}`} />
      ) : null}
      {split.fresh > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2.5"
          stroke="hsl(var(--ctx-fresh))"
          strokeDasharray={`${freshLen} ${c}`}
          strokeDashoffset={-cachedLen}
        />
      ) : null}
    </svg>
  );
}

/**
 * The stacked bar: cache, fresh, the rest of the window as the track. A 2px
 * gap of the surface separates the segments, so two adjacent fills never
 * merge into one at a glance; each segment keeps at least 2px so a sliver of
 * a few hundred tokens in a million-token window is still drawn.
 */
function ContextBar({ split }: { split: ContextSplit }) {
  const pct = (n: number) => (n > 0 ? `max(2px, ${((n / split.window) * 100).toFixed(3)}%)` : "0px");
  return (
    <div aria-hidden="true" className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {split.cached > 0 ? <span className="h-full shrink-0 rounded-sm bg-[hsl(var(--ctx-cache))]" style={{ width: pct(split.cached) }} /> : null}
      {split.fresh > 0 ? <span className="h-full shrink-0 rounded-sm bg-[hsl(var(--ctx-fresh))]" style={{ width: pct(split.fresh) }} /> : null}
      <span className="h-full min-w-0 flex-1 rounded-sm bg-foreground/[0.08]" />
    </div>
  );
}

export function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const locale = useUiLocale();
  const reduceMotion = useReducedMotion();
  const narrow = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = React.useState(false);
  const split = contextSplit(usage);
  const exact = (value: number) => formatNumber(value, locale);
  const share = formatNumber(split.used, locale, { style: "percent", maximumFractionDigits: split.used < 0.1 ? 1 : 0 });

  const button = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Context: ${share} of the model's window used`}
      onClick={narrow ? () => setOpen((previous) => !previous) : undefined}
      className="pressable inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-label font-medium tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground motion-reduce:active:scale-100 coarse:h-11 coarse:px-2.5"
    >
      <ContextRing split={split} />
      <span translate="no">{share}</span>
    </button>
  );

  const row = (swatch: string | null, label: string, value: string) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="flex items-center gap-2 text-muted-foreground">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-micro", swatch ?? "bg-foreground/[0.12]")} />
        {label}
      </dt>
      <dd className="font-medium text-foreground" translate="no">{value}</dd>
    </div>
  );

  const details = (
    <div className="ctx-meter min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 pt-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ui font-semibold text-foreground">Context window</h2>
        {narrow ? (
          <CloseButton label="Close context window" size="md" onClick={() => setOpen(false)} className="-my-1.5 -me-1.5" />
        ) : null}
      </div>
      <p className="mt-2 flex items-baseline justify-between gap-2 tabular-nums">
        <span className="flex items-baseline gap-1.5">
          <strong className="text-title font-semibold text-foreground" translate="no">{exact(split.cached + split.fresh)}</strong>
          <span className="text-label text-muted-foreground">
            of <bdi translate="no">{exact(split.window)}</bdi> tokens
          </span>
        </span>
        <span className="text-label font-medium text-muted-foreground" translate="no">{share}</span>
      </p>
      <div className="mt-2.5">
        <ContextBar split={split} />
      </div>
      <dl className="mt-2.5 text-ui tabular-nums">
        {split.cacheReported ? row("bg-[hsl(var(--ctx-cache))]", "Cache hits", exact(split.cached)) : null}
        {row("bg-[hsl(var(--ctx-fresh))]", split.cacheReported ? "Fresh input" : "Input", exact(split.fresh))}
        {row(null, "Remaining", exact(split.remaining))}
      </dl>
      <p className="mt-2 border-t border-border/70 pt-2.5 text-label text-muted-foreground">
        {split.cacheReported
          ? "From the last model request. Cache hits are input the provider read back from its prompt cache, billed at a fraction of fresh input."
          : "From the last model request. This provider does not report cache hits, so all input is shown as fresh."}
      </p>
    </div>
  );

  if (narrow)
    return (
      <>
        {button}
        <BottomSheet open={open} onOpenChange={setOpen} title="Context window">
          {details}
        </BottomSheet>
      </>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        aria-label="Context window"
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        animate={!reduceMotion}
        className="w-72 rounded-menu p-0"
      >
        {details}
      </PopoverContent>
    </Popover>
  );
}
