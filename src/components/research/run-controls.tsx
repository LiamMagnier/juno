"use client";

import * as React from "react";
import { Check, ChevronDown, Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { staggerDelay } from "@/lib/motion";
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
  lede: "Here's how Juno will research this. Adjust anything before it starts.",
  ledeFallback: "Juno will run these searches. Edit any of them before it starts.",
  start: "Start researching",
  discard: "Cancel research",
  showQueries: "Show the searches",
  hideQueries: "Hide the searches",
  step: "Step",
  search: "Search",
  focus: "Research focus",
  addConstraint: "Add a constraint",
  addSource: "Add a source URL",
  showFocus: "Set focus and sources",
  hideFocus: "Hide focus and sources",
  sources: "Sources to read first",
  approach: "Approach",
  questions: "Questions to answer",
  schedule: "How the work will run",
  criteria: "A complete answer includes",
  risks: "Where evidence may be thin",
  primary: "primary source",
  fresh: "fresh",
} as const;

/** The plan's objectives as the gate and the plan tab receive them. */
export interface PlanObjectiveView {
  id: string;
  question: string;
  rationale?: string;
  importance?: number;
  status?: string;
  evidenceRequirements?: Array<{
    id: string;
    description: string;
    minimumIndependentSources?: number;
    requiresPrimarySource?: boolean;
    freshnessRule?: string;
    status?: string;
  }>;
}

/** A section of the plan: a mono eyebrow over its content, staggered in. */
function PlanSection({
  label,
  index,
  children,
  className,
}: {
  label: string;
  index: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      style={staggerDelay(index, "base")}
      className={cn("motion-safe:animate-rise-in [animation-fill-mode:backwards]", className)}
    >
      <p className="font-mono text-label text-muted-foreground">{label}</p>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** The evidence contract behind one sub-question, as a quiet row of chips. */
function EvidenceChips({ objective }: { objective: PlanObjectiveView }) {
  const requirements = objective.evidenceRequirements ?? [];
  if (requirements.length === 0) return null;
  const independent = Math.max(...requirements.map((r) => r.minimumIndependentSources ?? 1));
  const primary = requirements.some((r) => r.requiresPrimarySource);
  const fresh = requirements.map((r) => r.freshnessRule).find(Boolean);
  const chips = [
    independent > 1 ? `${independent} independent sources` : "1 source",
    primary ? PLAN_COPY.primary : null,
    fresh ? `${PLAN_COPY.fresh} · ${fresh}` : null,
  ].filter((chip): chip is string => !!chip);
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Evidence needed">
      {chips.map((chip) => (
        <li
          key={chip}
          className="rounded-full border border-border bg-background px-2 py-0.5 font-mono text-micro text-muted-foreground"
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}

/**
 * The plan, read-only: the approach, the sub-questions with their evidence
 * contracts, the schedule, the bar for done and the risks. Shared by the gate
 * (which wraps the schedule in editors) and the console's Plan tab, so the
 * plan a person approved and the plan the run reports are one rendering.
 */
export function PlanOutline({
  approach,
  objectives,
  steps,
  queries,
  successCriteria,
  risks,
  renderSteps,
  startIndex = 0,
}: {
  approach?: string;
  objectives: PlanObjectiveView[];
  steps: string[];
  queries: string[];
  successCriteria?: string[];
  risks?: string[];
  /** The gate supplies editable steps; the tab renders them as text. */
  renderSteps?: (steps: string[]) => React.ReactNode;
  startIndex?: number;
}) {
  let index = startIndex;
  const scheduleSteps = steps.length ? steps : queries;
  return (
    <div className="flex flex-col gap-5">
      {approach && (
        <PlanSection label={PLAN_COPY.approach} index={index++}>
          <p className="text-body leading-relaxed text-foreground/90">{approach}</p>
        </PlanSection>
      )}
      {objectives.length > 0 && (
        <PlanSection label={PLAN_COPY.questions} index={index++}>
          <ol className="flex flex-col gap-3">
            {objectives.map((objective, i) => (
              <li key={objective.id} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-caption font-medium tabular-nums text-muted-foreground"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium leading-snug text-foreground">{objective.question}</p>
                  {objective.rationale && (
                    <p className="mt-0.5 text-ui leading-relaxed text-muted-foreground">{objective.rationale}</p>
                  )}
                  <EvidenceChips objective={objective} />
                </div>
              </li>
            ))}
          </ol>
        </PlanSection>
      )}
      {scheduleSteps.length > 0 && (
        <PlanSection label={PLAN_COPY.schedule} index={index++}>
          {renderSteps ? (
            renderSteps(scheduleSteps)
          ) : (
            <ol className="flex flex-col gap-2">
              {scheduleSteps.map((step, i) => (
                <li key={i} className="flex gap-3 text-ui leading-relaxed text-foreground/90">
                  <span className="w-4 shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}
        </PlanSection>
      )}
      {!!successCriteria?.length && (
        <PlanSection label={PLAN_COPY.criteria} index={index++}>
          <ul className="flex flex-col gap-1.5">
            {successCriteria.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-ui leading-relaxed text-foreground/90">
                <Check aria-hidden className="mt-1 size-3.5 shrink-0 text-success-ink" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </PlanSection>
      )}
      {!!risks?.length && (
        <PlanSection label={PLAN_COPY.risks} index={index++}>
          <ul className="flex flex-col gap-1.5">
            {risks.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-ui leading-relaxed text-muted-foreground">
                <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-warning" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </PlanSection>
      )}
    </div>
  );
}

/**
 * The plan gate: nothing expensive has happened yet, and this is what the run
 * intends to do — the planner's approach, the sub-questions a complete answer
 * needs and the evidence that would settle each, the order the work will run
 * in, the bar for done. Editable where editing changes the investigation: the
 * schedule (the steps the objectives are rebuilt from when they change) and
 * the searches one disclosure down. The approach and the questions are the
 * planner's reasoning and are read, not rewritten — a person who disagrees
 * with them adds a constraint or cancels.
 *
 * A plan with no structure — an older run, or a planner that ignored the
 * format — falls back to the step list, and with no steps to the query list,
 * which is exactly the screen this replaced. Nothing regresses to blank.
 */
export function PlanReview({
  steps,
  queries,
  constraints,
  pinnedSources,
  approach,
  objectives = [],
  successCriteria,
  risks,
  busy,
  onConfirm,
  onDiscard,
}: {
  steps: string[];
  queries: string[];
  constraints: string[];
  pinnedSources: string[];
  approach?: string;
  objectives?: PlanObjectiveView[];
  successCriteria?: string[];
  risks?: string[];
  busy: boolean;
  onConfirm: (plan: { steps: string[]; queries: string[]; constraints: string[]; pinnedSources: string[] }) => void;
  onDiscard: () => void;
}) {
  const [stepDraft, setStepDraft] = React.useState<string[] | null>(null);
  const [queryDraft, setQueryDraft] = React.useState<string[] | null>(null);
  const [queriesOpen, setQueriesOpen] = React.useState(false);
  const [focusOpen, setFocusOpen] = React.useState(false);
  const [constraintDraft, setConstraintDraft] = React.useState("");
  const [sourceDraft, setSourceDraft] = React.useState("");
  const [constraintValues, setConstraintValues] = React.useState(constraints);
  const [sourceValues, setSourceValues] = React.useState(pinnedSources);

  const currentSteps = stepDraft ?? steps;
  const currentQueries = queryDraft ?? queries;
  const hasSteps = currentSteps.length > 0;
  const structured = !!approach || objectives.length > 0;

  // The editable list is whichever one is really the plan here.
  const primary = hasSteps ? currentSteps : currentQueries;
  const setPrimary = hasSteps ? setStepDraft : setQueryDraft;
  const primaryLabel = hasSteps ? PLAN_COPY.step : PLAN_COPY.search;

  const editor = (
    <ol className="flex flex-col gap-2">
      {primary.map((value, i) => (
        <li key={i} className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-2 w-4 shrink-0 font-mono text-caption tabular-nums text-muted-foreground"
          >
            {i + 1}
          </span>
          <textarea
            disabled={busy}
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
              "min-w-0 flex-1 resize-none rounded-control border border-transparent bg-transparent px-2.5 py-1.5 outline-none",
              "text-ui leading-relaxed text-foreground/90",
              "transition-[background-color,border-color] duration-fast ease-out-soft hover:bg-secondary focus-visible:border-border focus-visible:bg-secondary motion-reduce:transition-none"
            )}
          />
        </li>
      ))}
    </ol>
  );

  return (
    <div>
      <p className="text-ui text-muted-foreground">
        {structured || hasSteps ? PLAN_COPY.lede : PLAN_COPY.ledeFallback}
      </p>

      <div className="mt-5">
        <PlanOutline
          approach={approach}
          objectives={objectives}
          steps={hasSteps ? currentSteps : []}
          queries={currentQueries}
          successCriteria={successCriteria}
          risks={risks}
          renderSteps={() => editor}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={busy || primary.every((value) => !value.trim())}
          onClick={() =>
            onConfirm({
              steps: currentSteps.map((s) => s.trim()).filter(Boolean),
              queries: currentQueries.map((q) => q.trim()).filter(Boolean),
              constraints: constraintValues.map((value) => value.trim()).filter(Boolean),
              pinnedSources: sourceValues.map((value) => value.trim()).filter(Boolean),
            })
          }
        >
          {PLAN_COPY.start}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDiscard} className="text-muted-foreground">
          {PLAN_COPY.discard}
        </Button>
      </div>

      {/* The searches, for the reader who wants them. Only when the steps are
          carrying the plan — with no steps the queries ARE the plan above. */}
      {hasSteps && currentQueries.length > 0 && (
        <div className="mt-5 border-t border-border pt-3">
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
            <ol className="mt-2 flex flex-col motion-safe:animate-research-detail-in">
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
                    className="min-w-0 flex-1 rounded-control bg-transparent px-2 py-1.5 text-ui text-muted-foreground outline-none transition-colors duration-fast ease-out-soft hover:bg-secondary focus-visible:bg-secondary focus-visible:text-foreground motion-reduce:transition-none"
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <button
          type="button"
          aria-expanded={focusOpen}
          onClick={() => setFocusOpen((value) => !value)}
          className="pressable -ml-1 inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-ui text-muted-foreground hover:text-foreground"
        >
          {focusOpen ? PLAN_COPY.hideFocus : PLAN_COPY.showFocus}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
              focusOpen && "rotate-180"
            )}
          />
        </button>

        {focusOpen && (
          <div className="mt-3 space-y-4 motion-safe:animate-research-detail-in">
            <FocusList
              label={PLAN_COPY.focus}
              values={constraintValues}
              emptyLabel={PLAN_COPY.addConstraint}
              draft={constraintDraft}
              onDraftChange={setConstraintDraft}
              onAdd={() => {
                const value = constraintDraft.trim();
                if (!value) return;
                setConstraintValues((current) => [...current, value]);
                setConstraintDraft("");
              }}
              onRemove={(index) => setConstraintValues((current) => current.filter((_, i) => i !== index))}
            />
            <FocusList
              label={PLAN_COPY.sources}
              values={sourceValues}
              emptyLabel={PLAN_COPY.addSource}
              draft={sourceDraft}
              onDraftChange={setSourceDraft}
              onAdd={() => {
                const value = sourceDraft.trim();
                if (!value) return;
                setSourceValues((current) => [...current, value]);
                setSourceDraft("");
              }}
              onRemove={(index) => setSourceValues((current) => current.filter((_, i) => i !== index))}
              source
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FocusList({
  label,
  values,
  emptyLabel,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  source = false,
}: {
  label: string;
  values: string[];
  emptyLabel: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  source?: boolean;
}) {
  return (
    <section>
      <p className="text-ui font-medium text-foreground">{label}</p>
      {values.length > 0 && (
        <ul className="mt-2 space-y-1">
          {values.map((value, index) => (
            <li key={`${value}-${index}`} className="flex min-w-0 items-center gap-2 rounded-control bg-secondary/45 px-2 py-1.5 text-ui text-muted-foreground">
              {source ? <Link2 aria-hidden className="size-3.5 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{value}</span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${value}`}
                className="pressable inline-flex size-9 shrink-0 items-center justify-center rounded-control hover:bg-accent hover:text-foreground"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <input
          type={source ? "url" : "text"}
          inputMode={source ? "url" : "text"}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={emptyLabel}
          aria-label={emptyLabel}
          className="min-w-0 flex-1 rounded-control bg-secondary/50 px-2.5 py-1.5 text-base text-foreground outline-none ring-1 ring-transparent placeholder:text-muted-foreground/70 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={onAdd}
          aria-label={emptyLabel}
          className="pressable inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
