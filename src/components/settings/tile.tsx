import * as React from "react";

import { Card, CardEyebrow } from "@/components/ui/card";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One container system for every section of the settings surface: same radius,
 * same border (the Card default border-border/70), same padding, same eyebrow
 * margin. flex-col + h-full so side-by-side tiles stretch to equal height and
 * internals can pin footers with mt-auto.
 *
 * It lives here rather than inside settings/page.tsx because PermissionsSection
 * was reproducing the container by copying its class string verbatim — including
 * the stagger, which is why it took an `index` prop at all. A shared container
 * that is shared by transcription is not shared: any change to this file used to
 * leave that one card behind.
 */
export function Tile({
  eyebrow,
  aside,
  i,
  span,
  className,
  children,
}: {
  eyebrow: React.ReactNode;
  /** Trailing content on the eyebrow row — a save status, a count. */
  aside?: React.ReactNode;
  i: number;
  span?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      style={staggerDelay(i, "loose")}
      className={cn(
        "flex h-full flex-col rounded-surface p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        span && "sm:col-span-2",
        className
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <CardEyebrow>{eyebrow}</CardEyebrow>
        {aside}
      </div>
      {children}
    </Card>
  );
}
