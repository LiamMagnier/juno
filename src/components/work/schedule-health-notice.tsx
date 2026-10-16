"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ClientScheduleHealth } from "@/lib/work/schedule-health";
import { cn } from "@/lib/utils";

/**
 * A routine's health at the top of its own page, when there is something to
 * do about it: a trigger that cannot read its source, a run waiting on the
 * person (and when it will be given up on), runs that failed. Healthy, running,
 * paused and not-yet-run routines say nothing here; the row and the header
 * already do.
 */
export function ScheduleHealthNotice({ health, className }: { health: ClientScheduleHealth | null | undefined; className?: string }) {
  if (!health || (health.tone !== "error" && health.tone !== "attention")) return null;
  const expires = health.waitingExpiresAt ? new Date(health.waitingExpiresAt) : null;
  // This notice sits on the routine's own page, above its editor: an "edit"
  // fix would link to the page it is on, so it points down instead.
  const action = health.action && health.action.kind !== "edit" ? health.action : null;
  const fixBelow = health.action?.kind === "edit";
  return (
    <section
      role="status"
      data-health={health.state}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-field bg-muted px-4 py-3 contrast-more:border contrast-more:border-border",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] size-1.5 shrink-0 rounded-full",
          health.tone === "error" ? "bg-destructive" : "bg-[hsl(var(--attention))]"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-foreground">{health.label}</p>
        {health.detail && <p className="mt-0.5 text-ui leading-relaxed text-foreground/75">{health.detail}</p>}
        {fixBelow && <p className="mt-0.5 text-caption text-muted-foreground">Change it below.</p>}
        {expires && !Number.isNaN(expires.getTime()) && (
          <p className="mt-0.5 text-caption text-muted-foreground">
            Stops unanswered at{" "}
            <span className="tabular-nums">
              {expires.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
            .
          </p>
        )}
      </div>
      {action && (
        <Button asChild variant="outline" size="sm" className="shrink-0 font-normal">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      )}
    </section>
  );
}
