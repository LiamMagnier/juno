import * as React from "react";
import { Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";

import { Card, CardEyebrow } from "@/components/ui/card";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One container system for every section of the settings surface: same radius,
 * same border (the Card default border-border/70), same padding, same eyebrow
 * margin. flex-col so internals can pin a footer to the bottom edge with
 * mt-auto if the tile ever gains a fixed height.
 *
 * It lives here rather than inside settings/page.tsx because PermissionsSection
 * was reproducing the container by copying its class string verbatim — including
 * the stagger, which is why it took an `index` prop at all. A shared container
 * that is shared by transcription is not shared: any change to this file used to
 * leave that one card behind.
 *
 * There is no `span` prop any more. It set `col-span-full` for a two-column
 * grid that SettingsGroup no longer renders — the groups went single column
 * when the section rail landed — so every tile spans, always, and a prop that
 * claims to control layout while controlling nothing is the next person's
 * wrong turn.
 */
export function Tile({
  eyebrow,
  aside,
  i,
  className,
  children,
}: {
  eyebrow: React.ReactNode;
  /** Trailing content on the eyebrow row — a save status, a count. */
  aside?: React.ReactNode;
  i: number;
  /**
   * Note for anyone recolouring the edge: the container below is
   * `border-0 border-b`, so there is exactly ONE border here and it is the
   * bottom one. A plain `border-destructive/20` passed in only recolours that
   * hairline — the Danger zone tile shipped with precisely that class and it
   * was dead code, because at 20% over pure black it was invisible too. Target
   * the side you mean (`border-b-*`) and give it enough alpha to read.
   */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      variant="flat"
      style={staggerDelay(i, "loose")}
      className={cn(
        "flex flex-col rounded-none border-0 border-b border-border/70 bg-transparent px-0 py-6 shadow-none motion-safe:animate-fade-in [animation-fill-mode:backwards]",
        className
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <CardEyebrow>{eyebrow}</CardEyebrow>
        {aside}
      </div>
      {children}
    </Card>
  );
}

export type TileSaveState = "idle" | "saving" | "saved" | "failed";

/**
 * The save status a tile hangs in its eyebrow row, for controls that write in
 * the background rather than behind a Save button.
 *
 * PermissionsSection invented this shape and Custom instructions saved with no
 * feedback at all — a blur-save whose only success signal was nothing
 * happening. One component, so the two autosaving tiles on this surface (and
 * the next one) confirm in the same voice, at the same place.
 *
 * Rendered in EVERY state, not mounted on demand: the live region has to exist
 * before the first save for the announcement to be reliable.
 */
export function TileSaveStatus({
  state,
  failedMessage,
}: {
  state: TileSaveState;
  /** Failure copy must say what the user still has, not just that it broke. */
  failedMessage: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 text-caption",
        state === "failed" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {state === "saving" && (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Saving…
        </>
      )}
      {state === "saved" && (
        <>
          <StatusIcons.success className="size-3.5 text-primary" aria-hidden />
          Saved
        </>
      )}
      {state === "failed" && (
        <>
          <StatusIcons.error className="size-3.5" aria-hidden />
          {failedMessage}
        </>
      )}
    </span>
  );
}
