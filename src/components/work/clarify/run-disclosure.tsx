"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { WorkEffectiveTarget } from "@/lib/work/domain";
import { cn } from "@/lib/utils";

/*
 * "What this run commits to" — the three facts a task is started on.
 *
 * A Work run is the one thing in Juno that spends real money while nobody is
 * looking, and until now the composer said two of the three things that decides:
 * it explained where the task would run, and it let the reader choose which apps
 * it could reach. It never said what it would cost, or what would stop it. The
 * ceilings were a constant in a route handler, which is to say they were a fact
 * about the reader's money that only the people who wrote the route knew.
 *
 * Collapsed by default, and that is not timidity: the summary line already
 * carries the whole of it in one sentence, and a permanently expanded block of
 * metadata over a composer is the sort of thing readers learn to look past —
 * at which point it has stopped disclosing anything. The chevron is for the
 * press where somebody actually wants to know.
 *
 * Nothing here is computed. `selectForInferred` in the composer already decided
 * the target, the Apps chip already holds the connector selection, and the
 * ceilings are the route's constant. Recomputing any of the three would produce
 * a second answer that could disagree with the one the dispatch acts on, which
 * is the failure the composer's own header spends a paragraph on.
 */

/**
 * The run budget, restated for the reader.
 *
 * A mirror of `DEFAULT_RUN_BUDGET` in
 * src/app/api/work/sessions/[id]/runs/route.ts, which is a module-private
 * constant in a `server-only` route and cannot be imported into a client
 * bundle. That is a real duplication and it is written here in the same units
 * as the original so that a divergence is obvious on sight rather than hidden
 * behind a unit conversion: if that constant moves, this sentence becomes a
 * lie, and this comment is where whoever moves it finds out.
 */
const RUN_CEILINGS = {
  costUsd: 2,
  tokens: 600_000,
  minutes: 20,
} as const;

interface RunDisclosureProps {
  /** Where `selectForInferred` says this will run. Null while that is unknown. */
  target: WorkEffectiveTarget | null;
  /** The Mac's own name, when it is going to a Mac. */
  hostName: string | null;
  /** The apps switched on for this task, in the words the reader chose them by. */
  connectorLabels: readonly string[];
}

export function WorkRunDisclosure({ target, hostName, connectorLabels }: RunDisclosureProps) {
  const [open, setOpen] = React.useState(false);

  // Nothing is claimed while the target is unknown. A disclosure that said
  // "Juno's cloud" and then corrected itself once the host list landed would be
  // the one part of this surface the reader has no way to check.
  if (target === null) return null;

  const where = target === "cloud" ? "Juno’s cloud" : (hostName ?? "your Mac");
  const reaches =
    connectorLabels.length === 0
      ? "no connected apps"
      : connectorLabels.length <= 2
        ? connectorLabels.join(" and ")
        : `${connectorLabels.slice(0, -1).join(", ")} and ${connectorLabels[connectorLabels.length - 1]}`;

  return (
    <div className="mt-2.5 px-1.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-control py-0.5 text-left text-caption leading-relaxed text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="min-w-0 flex-1 truncate">
          Runs on {where}, reaches {reaches}, stops at ${RUN_CEILINGS.costUsd} or{" "}
          {RUN_CEILINGS.minutes} minutes.
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-base ease-out-soft",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Grid-rows rather than height, the same collapse the attachment strip
          above uses, so the reveal is animatable without measuring anything. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <dl className="mt-2 space-y-2 border-l border-border/60 pl-3">
            <Row label="Runs on">
              {target === "cloud"
                ? "Juno’s cloud. Nothing on your Mac is read or touched."
                : `${hostName ?? "Your Mac"}. It has to stay awake for the task to finish.`}
            </Row>
            <Row label="Reaches">
              {connectorLabels.length === 0
                ? "No connected apps. It works from the task, its project and any files attached to it."
                : `${reaches}. Every other app you have connected stays out of reach.`}
            </Row>
            <Row label="Stops at">
              {`$${RUN_CEILINGS.costUsd}, ${RUN_CEILINGS.tokens.toLocaleString("en-US")} tokens, or ${RUN_CEILINGS.minutes} minutes of working time — whichever comes first. If one is reached the task stops and tells you where it got to; waiting for you does not count against the clock.`}
            </Row>
          </dl>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-caption leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}
