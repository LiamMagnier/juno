"use client";

import * as React from "react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/*
 * The pieces every panel of the Share dialog draws the same way: a link with
 * its Copy button, the loading skeleton, and a failure with its retry. Their
 * own module so the link panel, the publish panel and the people panel
 * (share-people-panel.tsx) share one rendering rather than three copies.
 */

export function formatShareDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Copy, and a tick for a moment after: the shared confirmation on every copy in the dialog. */
export function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = React.useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, []);
  return [copied, copy];
}

/** The copy glyph that turns into a tick, on the spring every swap in the product uses. */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <IconSwap
      curve="spring"
      swapped={copied}
      from={<ActionIcons.copy className="size-4" aria-hidden />}
      to={<StatusIcons.success className="size-4" aria-hidden />}
    />
  );
}

/** A read-only link field with a Copy button that confirms itself. */
export function LinkField({ url, label }: { url: string; label: string }) {
  const [copied, copy] = useCopied();
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={label}
        className="font-mono text-caption"
      />
      <Button size="sm" onClick={() => void copy(url)} className="shrink-0">
        <CopyGlyph copied={copied} />
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <div className="flex items-center gap-2" aria-hidden>
        <div className="skeleton h-9 flex-1 rounded-field coarse:h-11" />
        <div className="skeleton h-8 w-20 shrink-0 rounded-control coarse:h-10" />
      </div>
      <div className="skeleton h-3 w-48 rounded-micro" aria-hidden />
    </div>
  );
}

export function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="space-y-3 motion-safe:animate-fade-in" role="alert">
      <p className="flex items-start gap-2 text-body text-destructive">
        <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden />
        <span className="min-w-0">{message}</span>
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
