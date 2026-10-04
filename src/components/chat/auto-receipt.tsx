"use client";

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { effortLabel, type RoutingReceipt } from "@/lib/router/receipt";
import { cn } from "@/lib/utils";

/**
 * Auto's receipt on an answer (BRIEF §27): "Auto · Claude Opus 5.5 · High".
 *
 * One line in the turn's metadata voice. Clicking it (or focusing and pressing
 * Enter) opens "Selected for:" with the reasons from the decision that ran —
 * never a template. Nothing else about routing is printed into the
 * conversation: no scores, no candidates, no pills.
 *
 * Only for turns Auto routed; a turn the reader routed by hand shows its model
 * name as before (TurnMeta).
 */
export function AutoReceipt({
  modelName,
  receipt,
  className,
}: {
  modelName: string;
  receipt: RoutingReceipt;
  className?: string;
}) {
  const reasons = receipt.reasons.filter(Boolean);
  const line = (
    <>
      <span className="text-muted-foreground/80">Auto</span>
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <span className="min-w-0 truncate">{modelName}</span>
      <span aria-hidden className="text-muted-foreground/50">·</span>
      <span className="shrink-0">{effortLabel(receipt.effort)}</span>
    </>
  );
  if (reasons.length === 0) {
    return <span className={cn("flex min-w-0 items-center gap-1.5", className)}>{line}</span>;
  }
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-xs outline-none transition-colors duration-fast hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          className
        )}
        aria-label={`Auto chose ${modelName}, ${effortLabel(receipt.effort)} thinking. Show why.`}
      >
        {line}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-0">
        <AutoReceiptReasons modelName={modelName} receipt={receipt} />
      </PopoverContent>
    </Popover>
  );
}

/** The popover body, exported for the /dev/routing gallery. */
export function AutoReceiptReasons({ modelName, receipt }: { modelName: string; receipt: RoutingReceipt }) {
  return (
    <div className="px-4 py-3">
      <p className="font-mono text-caption text-muted-foreground">Selected for</p>
      <ul className="mt-2 space-y-1.5">
        {receipt.reasons.map((reason) => (
          <li key={reason} className="flex gap-2 text-ui leading-snug text-foreground">
            <span aria-hidden className="mt-[0.55em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>{reason}</span>
          </li>
        ))}
      </ul>
      {(receipt.rerouted || receipt.degraded) && (
        <p className="mt-3 border-t border-border/60 pt-2.5 text-caption leading-snug text-muted-foreground">
          {receipt.rerouted
            ? `Answered by ${modelName} because Auto's first choice could not be reached.`
            : receipt.degraded === "over_budget"
              ? "Kept to what your remaining budget allows."
              : "Every eligible provider was reporting trouble; Auto used the best it had."}
        </p>
      )}
    </div>
  );
}
