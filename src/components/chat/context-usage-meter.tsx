"use client";

import * as React from "react";
import { CloseButton } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import type { ContextUsage } from "@/lib/chat/context-usage";
import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { useReducedMotion } from "@/lib/motion-preference";

function ContextBar({ usage, className }: { usage: ContextUsage; className: string }) {
  const filled = Math.min(1, usage.inputTokens / usage.windowTokens);
  const cached = ((usage.cachedTokens ?? 0) / usage.inputTokens) * filled;

  return (
    <span aria-hidden="true" className={`relative block overflow-hidden rounded-full bg-foreground/10 ${className}`}>
      <span className="absolute inset-y-0 start-0 bg-source" style={{ inlineSize: `${cached * 100}%` }} />
      <span className="absolute inset-y-0 bg-foreground/65" style={{ insetInlineStart: `${cached * 100}%`, inlineSize: `${(filled - cached) * 100}%` }} />
    </span>
  );
}

export function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const locale = useUiLocale();
  const reduceMotion = useReducedMotion();
  const narrow = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = React.useState(false);
  const exact = (value: number) => formatNumber(value, locale);
  const compact = (value: number) => formatNumber(value, locale, { notation: "compact", maximumFractionDigits: 1 });
  const share = formatNumber(usage.inputTokens / usage.windowTokens, locale, { style: "percent", maximumFractionDigits: 1 });

  const button = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={narrow ? () => setOpen((previous) => !previous) : undefined}
      className="pressable flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-label font-medium tabular-nums text-foreground hover:bg-accent aria-expanded:bg-selected motion-reduce:active:scale-100 coarse:min-h-11"
    >
      <ContextBar usage={usage} className="h-1.5 w-7 max-[420px]:hidden" />
      <span translate="no">{compact(usage.inputTokens)}</span>
      <span className="sr-only"> Context usage</span>
    </button>
  );

  const details = (
    <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 pt-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body font-semibold text-foreground">Context usage</h2>
        <CloseButton
          label="Close context usage"
          size="md"
          onClick={() => setOpen(false)}
          className="-my-1.5 -me-1.5"
        />
      </div>
      <div className="mt-3 rounded-panel bg-secondary p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 tabular-nums">
          <p className="flex items-baseline gap-1.5">
            <strong className="text-title" translate="no">{compact(usage.inputTokens)}</strong>
            <span className="text-label text-muted-foreground">of <bdi translate="no">{compact(usage.windowTokens)}</bdi> tokens</span>
          </p>
          <span className="text-label font-medium text-muted-foreground" translate="no">{share}</span>
        </div>
        <ContextBar usage={usage} className="mt-2 h-2.5 w-full" />
      </div>
      <dl className="mt-2 divide-y divide-border/70 text-ui tabular-nums">
        <div className="flex items-baseline justify-between gap-2 py-2">
          <dt>Input tokens</dt>
          <dd translate="no">{exact(usage.inputTokens)}</dd>
        </div>
        {usage.cachedTokens !== null && (
          <div className="flex items-baseline justify-between gap-2 py-2">
            <dt><span aria-hidden="true" className="me-1.5 inline-block size-1.5 rounded-full bg-source align-middle" />Cache hits</dt>
            <dd translate="no">{exact(usage.cachedTokens)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2 py-2">
          <dt>Model window</dt>
          <dd translate="no">{exact(usage.windowTokens)}</dd>
        </div>
      </dl>
      <p className="pt-1 text-label text-muted-foreground">Last model request</p>
    </div>
  );

  if (narrow) return (
    <>
      {button}
      <BottomSheet open={open} onOpenChange={setOpen} title="Context usage">
        {details}
      </BottomSheet>
    </>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent aria-label="Context usage" side="top" align="end" sideOffset={12} collisionPadding={12} animate={!reduceMotion} className="w-72 rounded-composer p-0">
        {details}
      </PopoverContent>
    </Popover>
  );
}
