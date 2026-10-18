"use client";

import * as React from "react";
import { shellString } from "@/lib/strings";
import { tetherRetryInSeconds, type TetherView } from "@/lib/net/tether";
import { cn } from "@/lib/utils";

/**
 * The one line a turn shows while its stream is being brought back
 * (Tether, src/lib/net/tether.ts):
 *
 *   Reconnecting in 4s   → an attempt is scheduled
 *   Reconnecting…        → an attempt is under way
 *   Waiting for network  → the device is offline; nothing to retry against
 *   Waiting for connection → parked; continues on the next trigger
 *
 * Words, never a bare spinner, and nothing that moves: the dot is still. The
 * countdown ticks visually but is hidden from assistive tech, which hears the
 * phase once per change instead of a number every second.
 */
export function ConnectionStatus({ connection, className }: { connection: TetherView; className?: string }) {
  const now = useSecondTicker(connection.phase === "reconnecting" && connection.retryAt !== null, connection.retryAt);
  const seconds = tetherRetryInSeconds(connection, now);

  let visible: string;
  let spoken: string;
  switch (connection.phase) {
    case "reconnecting":
      visible = seconds !== null ? shellString("turn.reconnectingIn", { s: seconds }) : shellString("turn.reconnecting");
      spoken = shellString("turn.reconnecting");
      break;
    case "waiting":
      visible = spoken = shellString("turn.waitingForNetwork");
      break;
    case "parked":
      visible = shellString("turn.parked");
      spoken = `${shellString("turn.parked")}. ${shellString("turn.parkedDetail")}`;
      break;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-connection={connection.phase}
      className={cn("mt-2 flex items-center gap-2 text-ui text-muted-foreground", className)}
      title={connection.phase === "parked" ? shellString("turn.parkedDetail") : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          connection.phase === "reconnecting" ? "bg-amber-500/80" : "bg-muted-foreground/60"
        )}
      />
      <span aria-hidden="true" className="tabular-nums">
        {visible}
      </span>
      <span className="sr-only">{spoken}</span>
    </div>
  );
}

/** `Date.now()`, refreshed once a second while `active`, and at once when `resetKey` changes. */
function useSecondTicker(active: boolean, resetKey: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [active, resetKey]);
  return now;
}
