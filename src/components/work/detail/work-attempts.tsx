"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkRun } from "@/lib/work/serializers";
import { attemptDurationMs } from "@/components/work/detail/work-attempt-timing";
import {
  WorkStatusDot,
  formatDuration,
  formatMicroUsd,
  statusSentence,
  workTimeAgo,
} from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/*
 * The attempts before this one.
 *
 * A task retried three times used to show only the newest run, and the two
 * before it were unreachable from anywhere in the product — which is the worst
 * possible arrangement for the one case where history is the whole point. A
 * retry is an experiment, and an experiment with no record of the previous
 * conditions is just a repeated guess: did it get further this time, did it cost
 * more, did it run somewhere else, was it the same model.
 *
 * Every attempt already exists as its own `WorkRun` row, with its own outcome,
 * spend, target, model and duration. Nothing new has to be recorded for this
 * panel — it only has to be read back.
 *
 * READ THIS BEFORE CHANGING THE FETCH. `GET /api/work/sessions/[id]/runs` does
 * not exist yet: the route file exports POST only, which is what dispatches a
 * run. The sibling `GET /api/work/schedules/[id]/runs` is the shape this expects
 * — `{ runs: ClientWorkRun[] }`, newest attempt first — and adding the session
 * equivalent is a handful of lines against the same serializer. Until somebody
 * does, this panel degrades to the honest sentence at the bottom of the file
 * rather than to an error, and it will light up the moment the route lands with
 * no change here.
 *
 * The request is made only when `attempt > 1`. A task with one attempt has no
 * history to fetch and asking anyway would spend a request per page load on
 * every task in the product to learn something the run row already stated.
 */

interface RunsResponse {
  runs?: unknown;
}

/** Narrow enough to render safely; the fields below are the ones this panel reads. */
function isRun(value: unknown): value is ClientWorkRun {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.attempt === "number";
}

type HistoryState =
  | { kind: "loading" }
  | { kind: "ok"; runs: ClientWorkRun[] }
  /** The endpoint answered with something this build cannot read, or not at all. */
  | { kind: "unavailable" };

export function WorkAttempts({
  sessionId,
  current,
}: {
  sessionId: string;
  /** The attempt on screen. Its own row is marked rather than repeated below. */
  current: ClientWorkRun;
}) {
  const [state, setState] = React.useState<HistoryState>({ kind: "loading" });
  const attempt = current.attempt;

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/work/sessions/${sessionId}/runs?limit=10`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as RunsResponse;
        const runs = Array.isArray(body.runs) ? body.runs.filter(isRun) : [];
        if (!live) return;
        setState(runs.length > 0 ? { kind: "ok", runs } : { kind: "unavailable" });
      } catch {
        if (live) setState({ kind: "unavailable" });
      }
    })();
    return () => {
      live = false;
    };
    // Re-read when a new attempt starts: the run that was current a moment ago
    // has just become history, and this panel is where it goes.
  }, [sessionId, attempt]);

  if (state.kind === "loading") {
    return (
      <div className="space-y-1.5">
        {[...Array(2)].map((_, index) => (
          <Skeleton
            key={index}
            className="h-10 w-full rounded-control"
            style={staggerDelay(index, "tight")}
          />
        ))}
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div className="space-y-1.5">
        <AttemptRow run={current} isCurrent />
        {/*
         * Said plainly, and without a retry button, because retrying would not
         * help: nothing this page can call knows about the earlier attempts.
         * Promising them "soon" would be this panel making a commitment on
         * somebody else's behalf.
         */}
        <p className="pt-1 text-ui leading-relaxed text-muted-foreground">
          {attempt === 2
            ? "One earlier attempt ran before this one."
            : `${attempt - 1} earlier attempts ran before this one.`}{" "}
          Each was recorded, but nothing on this page can read them back yet, so what changed
          between them isn’t something Juno can show you here.
        </p>
      </div>
    );
  }

  // Newest first, so the attempt on screen leads and the history reads backwards
  // from it — which is the order somebody comparing a retry with its predecessor
  // reads in anyway.
  const ordered = [...state.runs].sort((left, right) => right.attempt - left.attempt);

  return (
    <ol className="space-y-1.5">
      {ordered.map((run) => (
        <li key={run.id}>
          <AttemptRow run={run} isCurrent={run.id === current.id} />
        </li>
      ))}
    </ol>
  );
}

function AttemptRow({ run, isCurrent }: { run: ClientWorkRun; isCurrent: boolean }) {
  // Deliberately not a live clock. This panel is a record of attempts, and the
  // one that is still going is described by the rest of the page in far more
  // detail than a ticking number here would add.
  const ran = attemptDurationMs(run);

  return (
    <div
      className={cn(
        // `rounded-control`, the list-row rung. `rounded-lg` is 24px here, which
        // on a 30px row is very nearly a pill.
        "rounded-control px-2 py-1.5",
        // Two rungs, not one alpha of the same fill. On a pure-black ground the
        // old muted/50-vs-muted/30 pair collapsed to the same wash, so the row
        // you are looking at and the row under your pointer were indistinguishable.
        isCurrent ? "bg-accent" : "transition-colors duration-base ease-out-soft hover:bg-secondary"
      )}
    >
      <div className="flex items-baseline gap-2">
        <WorkStatusDot status={run.status} />
        <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">
          #{run.attempt}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui leading-relaxed",
            isCurrent ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {/* The run's own words about how it ended come first. `statusSentence`
              is the fallback rather than the default, because "The run itself
              reported that it could not finish" is true of every failure and
              tells a person comparing two of them nothing. */}
          {run.terminalDetail ?? statusSentence(run.status)}
        </span>
        {isCurrent && (
          <span className="shrink-0 font-mono text-micro text-muted-foreground">this one</span>
        )}
      </div>
      {/* The three numbers a comparison is actually made on. Omitted individually
          rather than shown as zero: a run that never started has no duration,
          and printing "0s" would say it ran instantly. */}
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-3 pl-[18px] font-mono text-micro tabular-nums text-muted-foreground">
        {ran !== null && <span>{formatDuration(ran)}</span>}
        {run.usage.costMicroUsd > 0 && <span>{formatMicroUsd(run.usage.costMicroUsd)}</span>}
        {run.effectiveModel !== null && (
          <span className="min-w-0 truncate">{run.effectiveModel}</span>
        )}
        {run.startedAt !== null && <span>{workTimeAgo(run.startedAt)}</span>}
      </p>
    </div>
  );
}
