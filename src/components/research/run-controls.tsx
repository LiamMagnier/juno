"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The plan gate — the one moment a person's hands have to reach into a run
 * before any money moves.
 *
 * This file also held `SteerControls`: a text field for adding constraints plus
 * Pause and Stop buttons, rendered inside the research panel. Both jobs moved to
 * the composer, which is where a person types at a conversation and where the
 * stop button already lives — a second input and a second set of transport
 * controls a few hundred pixels above the real ones was the surface arguing with
 * itself. See the `steering` prop in composer.tsx and `useConversationResearch`.
 */

const PLAN_COPY = {
  lede: "Juno will work through this. Edit any step before it starts.",
  ledeFallback: "Juno will run these searches. Edit any of them before it starts.",
  start: "Start researching",
  discard: "Discard this run",
  showQueries: "Show the searches",
  hideQueries: "Hide the searches",
  step: "Step",
  search: "Search",
} as const;

/**
 * The plan gate: nothing expensive has happened yet, and this is what the run
 * intends to do. Editable, because the whole point of stopping here is that the
 * user can change it.
 *
 * WHAT IT SHOWS, and why that changed. It used to render the raw query list —
 * "best AI subscription 2026", "claude max vs chatgpt pro price" — as a stack of
 * bordered inputs. That is the machine's shopping list, and the question the
 * gate actually asks ("is this going to cover what I care about?") cannot be
 * answered from a bag of search strings: you can read fourteen of them and still
 * not know whether anyone is going to check the vendors' own pricing pages. So
 * the planner now writes a plan in sentences alongside the queries (see
 * PLANNER_SYSTEM in tools.ts), and the gate leads with that. The queries are
 * still here, still editable, one disclosure down — they are how the plan
 * executes, and the person who wants to tune them is a different person from the
 * one deciding whether to spend the money.
 *
 * Steps are editable too, and that is not decoration: they are what the writer's
 * objectives are built from, so a step the user rewrites changes the
 * investigation rather than just the label on it.
 *
 * A plan with no steps — an older run, or a planner that ignored the format —
 * falls back to the query list as the primary content, which is exactly the
 * screen this replaced. Nothing regresses to blank.
 */
export function PlanReview({
  steps,
  queries,
  busy,
  onConfirm,
  onDiscard,
}: {
  steps: string[];
  queries: string[];
  busy: boolean;
  onConfirm: (plan: { steps: string[]; queries: string[] }) => void;
  onDiscard: () => void;
}) {
  const [stepDraft, setStepDraft] = React.useState<string[] | null>(null);
  const [queryDraft, setQueryDraft] = React.useState<string[] | null>(null);
  const [queriesOpen, setQueriesOpen] = React.useState(false);

  const currentSteps = stepDraft ?? steps;
  const currentQueries = queryDraft ?? queries;
  const hasSteps = currentSteps.length > 0;

  // The primary list is whichever one is really the plan here. Everything below
  // reads from this pair so there is one layout, not two.
  const primary = hasSteps ? currentSteps : currentQueries;
  const setPrimary = hasSteps ? setStepDraft : setQueryDraft;
  const primaryLabel = hasSteps ? PLAN_COPY.step : PLAN_COPY.search;

  return (
    <div>
      <p className="text-ui text-muted-foreground">{hasSteps ? PLAN_COPY.lede : PLAN_COPY.ledeFallback}</p>

      <ol className="mt-3.5 flex flex-col gap-0.5">
        {primary.map((value, i) => (
          <li key={i} className="flex items-start gap-3">
            {/* A hollow node per step, echoing the spine the run draws once it
                is going — the gate is the same five acts before they happen. */}
            <span
              aria-hidden
              className="mt-[13px] size-[7px] shrink-0 rounded-full border border-border bg-transparent"
            />
            {/* Chromeless at rest, an input on focus. A full-chrome field per
                row draws five boxes where the reader needs one list — the plan
                is to be READ first and edited second. */}
            <textarea
              value={value}
              rows={1}
              aria-label={`${primaryLabel} ${i + 1}`}
              onChange={(e) => {
                const next = [...primary];
                next[i] = e.target.value;
                setPrimary(next);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              ref={(el) => {
                if (!el) return;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              className={cn(
                "min-w-0 flex-1 resize-none rounded-control bg-transparent px-2 py-1.5 outline-none",
                "text-body leading-relaxed text-foreground/90",
                "transition-colors duration-fast ease-out-soft hover:bg-secondary/50 focus-visible:bg-secondary/60 motion-reduce:transition-none"
              )}
            />
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={busy || primary.every((value) => !value.trim())}
          onClick={() =>
            onConfirm({
              steps: currentSteps.map((s) => s.trim()).filter(Boolean),
              queries: currentQueries.map((q) => q.trim()).filter(Boolean),
            })
          }
        >
          {PLAN_COPY.start}
        </Button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="pressable rounded-control px-1 py-0.5 text-ui text-muted-foreground underline-offset-4 hover:text-destructive hover:underline disabled:opacity-50"
        >
          {PLAN_COPY.discard}
        </button>
      </div>

      {/* The searches, for the reader who wants them. Only when the steps are
          carrying the plan — with no steps the queries ARE the plan above, and
          a disclosure holding a duplicate of the list you are looking at is
          worse than no disclosure. */}
      {hasSteps && currentQueries.length > 0 && (
        <div className="mt-4 border-t border-border/50 pt-3">
          <button
            type="button"
            aria-expanded={queriesOpen}
            onClick={() => setQueriesOpen((value) => !value)}
            className="pressable -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-ui text-muted-foreground hover:text-foreground"
          >
            {queriesOpen ? PLAN_COPY.hideQueries : PLAN_COPY.showQueries}
            <span className="tabular-nums text-muted-foreground/70">{currentQueries.length}</span>
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                queriesOpen && "rotate-180"
              )}
            />
          </button>

          {queriesOpen && (
            <ol className="mt-2 flex flex-col">
              {currentQueries.map((query, i) => (
                <li key={i} className="flex items-center gap-3">
                  <span aria-hidden className="w-4 shrink-0 text-caption tabular-nums text-muted-foreground/60">
                    {i + 1}
                  </span>
                  <input
                    value={query}
                    aria-label={`${PLAN_COPY.search} ${i + 1}`}
                    onChange={(e) => {
                      const next = [...currentQueries];
                      next[i] = e.target.value;
                      setQueryDraft(next);
                    }}
                    className="min-w-0 flex-1 rounded-control bg-transparent px-2 py-1.5 text-ui text-muted-foreground outline-none transition-colors duration-fast ease-out-soft hover:bg-secondary/50 focus-visible:bg-secondary/60 focus-visible:text-foreground motion-reduce:transition-none"
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
