/**
 * There is no `Tile` here any more. It was the settings surface's container
 * before `SettingsGroup` (setting-row.tsx) took that job, and it outlived the
 * migration in exactly one place — PermissionsSection — so the Connectors pane
 * ran two container systems back to back: a 4px eyebrow-to-lede gap over a
 * 16px one, a stagger on one block and not the other, and Tile's full-width
 * bottom hairline ruled under the last block on the pane with nothing beneath
 * it. The save status below is what the file still owns, and the file keeps
 * its name because three sections import it by that path.
 */
import * as React from "react";
import { Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";

import { cn } from "@/lib/utils";

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
