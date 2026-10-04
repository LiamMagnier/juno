"use client";

import * as React from "react";
import { RunGlyph } from "@/components/chat/run/run-glyph";
import { RESEARCH_COPY, estimateLine, isResearchRefusal, phrase, researchRefusalLine } from "@/components/research/copy";
import {
  MAX_QUESTION_CHARS,
  addQuestion,
  addSource,
  approachOf,
  canAddQuestion,
  canRemoveQuestion,
  canStart,
  clarificationsOf,
  draftEstimate,
  draftSeed,
  editQuestion,
  markNotifyAsked,
  notifyAsked,
  notifyPromptVisible,
  planBody,
  planRevisionOf,
  removeQuestion,
  removeSource,
  seedDraft,
  setAnswer,
  startRequest,
  type ScopeDraft,
} from "@/components/research/scope-draft";
import { useResearchRun, type ResearchRunView } from "@/components/research/use-research-run";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs, phraseText, usePhrase } from "@/lib/i18n-phrase";
import { claimLoop } from "@/lib/run/store";
import type { PhraseLine } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * Research's one gate (SPEC §9.11.2, DECISIONS R2): the approach, the
 * questions (editable in place), the optional clarifications, the sources it
 * favours plus any the reader adds, and the estimate line, with Start as the
 * primary action. Nothing is spent on the research itself until Start.
 *
 * - While the run plans: a skeleton the height of the Research row (the glyph
 *   and "Planning the research"), no card chrome, so the card's arrival is
 *   the only change.
 * - At the tail of the transcript it is full size. Elsewhere (the reader kept
 *   chatting while it planned) it is a one-line "Plan ready · Review" row of
 *   the skeleton's height, which expands only on the reader's click.
 * - Every edit recomputes the estimate line client-side (`estimateFor`
 *   against the caps the server sent), time and pages only, never money.
 * - "Update plan" appears after an edit and asks the planner to rewrite the
 *   plan; meanwhile the card stays mounted at its size, dimmed and busy, and
 *   never falls back to the skeleton. The draft re-seeds when the rewritten
 *   plan lands (keyed by run and plan revision, bug 29).
 * - Start sends the edited questions, answers and sources, collapses the card
 *   in place and hands focus to the host (bug 12). Controls are disabled
 *   while a request is out (bug 28).
 * - Below 28rem the footer is sticky, so Start stays reachable above the
 *   composer dock.
 *
 * The draft's rules live in `scope-draft.ts` (pure, tested); this is its view.
 */

export interface ScopeCardProps {
  runId: string;
  /** Full size only at the transcript tail; elsewhere a one-line "Plan ready · Review" row. */
  atTail: boolean;
  /** After Start: the host moves focus to what replaces the card. */
  onStarted(runId: string): void;
  /** In the transcript workspace: reuse the gate without a second surface. */
  embedded?: boolean;
}

/** How long the collapse on Start takes before the card unmounts (`.run-collapse`, 220 ms + slack). */
const COLLAPSE_MS = 260;

function sessionNotificationPermission(): string | null {
  try {
    return typeof Notification === "undefined" ? null : Notification.permission;
  } catch {
    return null;
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The skeleton and the one-line row share the Research row's geometry: 2.25rem, glyph, one line. */
function RowFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex h-9 min-h-9 items-center gap-2.5 px-2 leading-6 coarse:h-11", className)}>{children}</div>;
}

function PlanningSkeleton({ runId }: { runId: string }) {
  const loopId = `research-plan:${runId}`;
  React.useEffect(() => claimLoop(loopId, 4), [loopId]);
  return (
    <RowFrame className="text-reading text-muted-foreground">
      <RunGlyph phase="thinking" calm loopId={loopId} />
      <span role="status">
        <Phrase text={RESEARCH_COPY.phase.planning} />
      </span>
    </RowFrame>
  );
}

export function ScopeCard({ runId, atTail, onStarted, embedded = false }: ScopeCardProps) {
  const research = useResearchRun(runId);
  const { run, phase, events } = research;
  const atGate = phase === "awaiting_start";

  const [expanded, setExpanded] = React.useState(false);
  // Held while Start is out: its answer moves the run past the gate before the
  // collapse begins, and the card must not blink out in between.
  const [holding, setHolding] = React.useState(false);
  const [collapsing, setCollapsing] = React.useState(false);
  const [gone, setGone] = React.useState(false);

  // Start collapses the card in place, then it leaves the transcript to the console.
  React.useEffect(() => {
    if (!collapsing) return;
    const timer = window.setTimeout(() => setGone(true), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [collapsing]);

  // A typed "yes" confirms from the chat (§9.6.1): the run leaves the gate
  // without this card's Start, and the host moves focus all the same.
  const wasAtGate = React.useRef(false);
  React.useEffect(() => {
    if (!phase) return;
    const left = wasAtGate.current && !atGate && phase !== "stopped" && phase !== "failed";
    wasAtGate.current = atGate;
    if (!left || holding || collapsing) return;
    onStarted(runId);
  }, [phase, atGate, holding, collapsing, onStarted, runId]);

  if (!run || gone) return null;
  if (phase === "planning") return <PlanningSkeleton runId={runId} />;
  if (!atGate && !collapsing && !holding) return null;

  if (!atTail && !expanded && !collapsing && !holding) {
    return (
      <Pressable
        kind="row"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        className="h-9 min-h-9 gap-2.5 rounded-control px-2 py-0 leading-6 coarse:h-11 coarse:min-h-11"
      >
        <RunGlyph phase="waiting" loopId={`research-plan:${runId}`} />
        <PhraseWithArgs
          spec={[phrase(RESEARCH_COPY.scope.planReady), phrase(RESEARCH_COPY.scope.review)]}
          className="min-w-0 flex-1 truncate text-ui text-foreground/80"
        />
        <ChevronRight aria-hidden className="size-3.5 text-muted-foreground rtl:-scale-x-100" />
      </Pressable>
    );
  }

  return (
    <div className="run-collapse" data-open={collapsing ? "false" : "true"}>
      <div className="run-collapse__inner" inert={collapsing}>
        <ScopeCardBody
          run={run}
          events={events}
          busy={research.busy || research.disconnected || research.failed}
          embedded={embedded}
          act={research.act}
          onStartSent={() => setHolding(true)}
          onStartAnswered={(ok) => {
            if (ok) {
              setCollapsing(true);
              onStarted(runId);
            }
            setHolding(false);
          }}
        />
      </div>
    </div>
  );
}

function ScopeCardBody({
  run,
  events,
  busy,
  act,
  onStartSent,
  onStartAnswered,
  embedded,
}: {
  run: ResearchRunView;
  events: ReturnType<typeof useResearchRun>["events"];
  busy: boolean;
  act: ReturnType<typeof useResearchRun>["act"];
  onStartSent(): void;
  onStartAnswered(ok: boolean): void;
  embedded: boolean;
}) {
  const locale = useUiLocale();
  const revision = planRevisionOf(events);
  const seed = draftSeed(run.id, revision);
  const [draft, setDraft] = React.useState<ScopeDraft>(() => seedDraft(run, revision));
  // A rewritten plan replaces the draft (bug 29); a poll of the same plan does not.
  if (draft.seed !== seed) setDraft(seedDraft(run, revision));

  const [sourceText, setSourceText] = React.useState("");
  const [sourceInvalid, setSourceInvalid] = React.useState(false);
  const [error, setError] = React.useState<PhraseLine | null>(null);
  const [focusKey, setFocusKey] = React.useState<string | null>(null);
  const questionRefs = React.useRef(new Map<string, HTMLTextAreaElement>());

  // The notify line: decided once when the card appears, recorded as asked at once (R7).
  const [notify, setNotify] = React.useState(() =>
    notifyPromptVisible({
      minutesUpTo: run.estimate?.minutesUpTo ?? null,
      permission: sessionNotificationPermission(),
      asked: notifyAsked(localStore()),
    }),
  );
  React.useEffect(() => {
    if (notify) markNotifyAsked(localStore());
  }, [notify]);

  React.useEffect(() => {
    if (!focusKey) return;
    questionRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const revising = !!run.revising;
  const locked = busy || revising;
  const clarifications = clarificationsOf(run);
  const approach = approachOf(run);
  const estimate = draftEstimate(draft, run);
  const kinds = run.plan.sourceKinds ?? [];
  const contentLang = run.language ?? undefined;

  const questionLabel = usePhrase(RESEARCH_COPY.scope.question);
  const removeLabel = usePhrase(RESEARCH_COPY.scope.removeQuestion);
  const removeSourceLabel = usePhrase(RESEARCH_COPY.scope.removeSource);
  const answerPlaceholder = usePhrase(RESEARCH_COPY.scope.answerPlaceholder);
  const sourcePlaceholder = usePhrase(RESEARCH_COPY.scope.sourcePlaceholder);
  const groupName = usePhrase(RESEARCH_COPY.scope.groupName);
  const startName = usePhrase(RESEARCH_COPY.scope.startName);

  const send = async (path: string, body: Record<string, unknown>) => {
    setError(null);
    const result = await act(path, body);
    if (result.ok) return true;
    const reason = result.data.reason;
    setError(
      isResearchRefusal(reason)
        ? researchRefusalLine(reason, (result.data.params ?? {}) as Record<string, string | number>, { heading: false })
        : [phrase(RESEARCH_COPY.scope.couldNotStart)],
    );
    return false;
  };

  const start = async () => {
    const request = startRequest(run.state, draft);
    // The clarify gate answers and comes back to this card for Start; only a
    // confirmed plan leaves it.
    const leaves = request.path === "/plan";
    if (leaves) onStartSent();
    const ok = await send(request.path, request.body);
    if (leaves) onStartAnswered(ok);
  };

  const submitSource = () => {
    const { draft: next, ok } = addSource(draft, sourceText);
    setSourceInvalid(!ok);
    if (ok) {
      setDraft(next);
      setSourceText("");
    }
  };

  return (
    <section
      role="group"
      aria-label={groupName}
      aria-busy={locked || undefined}
      data-revising={revising || undefined}
      className={cn(
        "rf-scope @container/scope relative text-card-foreground transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
        !embedded && "rounded-card border border-border/70 bg-card",
        revising && "opacity-60",
      )}
    >
      <div className="space-y-5 px-4 pb-2 pt-4">
        {approach && (
          <p lang={contentLang} className="rf-lead text-foreground">
            {approach}
          </p>
        )}
        {(run.plannedBy === "goal" || run.plannedBy === "lines") && (
          // RESEARCH_V2 F4: the plan nobody (or a simpler planner) drafted says so, before anything is spent.
          <p role="note" className="rf-planned-by text-ui text-muted-foreground">
            <Phrase text={run.plannedBy === "goal" ? RESEARCH_COPY.scope.plannedByGoal : RESEARCH_COPY.scope.plannedByLines} />
          </p>
        )}

        <div className="space-y-2">
          <h3 className="rf-annot text-foreground">
            <Phrase text={RESEARCH_COPY.scope.questions} />
          </h3>
          <ol className="space-y-1.5">
            {draft.questions.map((question, i) => (
              <li key={question.key} className="flex items-start gap-2">
                <span aria-hidden className="w-5 shrink-0 pt-2 text-right font-mono text-caption tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <textarea
                  ref={(el) => {
                    if (el) questionRefs.current.set(question.key, el);
                    else questionRefs.current.delete(question.key);
                  }}
                  lang={contentLang}
                  rows={1}
                  maxLength={MAX_QUESTION_CHARS}
                  value={question.text}
                  disabled={locked}
                  aria-label={phraseText([{ parts: [{ phrase: questionLabel }, { kind: "number", value: i + 1 }] }], locale)}
                  data-no-auto-translate
                  onChange={(e) => setDraft((d) => editQuestion(d, question.key, e.target.value))}
                  className="min-h-9 flex-1 resize-none rounded-field border border-transparent bg-transparent px-2 py-1.5 text-body text-foreground [field-sizing:content] hover:border-input focus-visible:border-primary focus-visible:outline-none disabled:opacity-60"
                />
                {canRemoveQuestion(draft) && (
                  <Pressable
                    kind="icon"
                    size="sm"
                    disabled={locked}
                    aria-label={removeLabel}
                    onClick={() => setDraft((d) => removeQuestion(d, question.key))}
                    className="mt-1"
                  >
                    <X className="size-3.5" />
                  </Pressable>
                )}
              </li>
            ))}
          </ol>
          {canAddQuestion(draft) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => {
                const { draft: next, key } = addQuestion(draft);
                setDraft(next);
                setFocusKey(key);
              }}
              className="gap-1.5 text-muted-foreground"
            >
              <Plus className="size-3.5" />
              <Phrase text={RESEARCH_COPY.scope.addQuestion} />
            </Button>
          )}
        </div>

        {clarifications.length > 0 && (
          <div className="space-y-3">
            <h3 className="rf-annot text-foreground">
              <Phrase text={RESEARCH_COPY.scope.beforeIStart} />
            </h3>
            {clarifications.map((clarification) => {
              const answer = draft.answers[clarification.id] ?? "";
              return (
                <div key={clarification.id} className="space-y-1.5">
                  <p lang={contentLang} id={`clarify-${run.id}-${clarification.id}`} className="text-body text-foreground/90">
                    {clarification.question}
                  </p>
                  {clarification.options.length > 0 ? (
                    <div role="radiogroup" aria-labelledby={`clarify-${run.id}-${clarification.id}`} className="flex flex-wrap gap-1.5">
                      {clarification.options.map((option) => {
                        const selected = answer === option;
                        return (
                          <Pressable
                            key={option}
                            kind="chip"
                            role="radio"
                            aria-checked={selected}
                            selected={selected}
                            disabled={locked}
                            lang={contentLang}
                            onClick={() => setDraft((d) => setAnswer(d, clarification.id, selected ? "" : option))}
                          >
                            {option}
                          </Pressable>
                        );
                      })}
                    </div>
                  ) : (
                    <Input
                      value={answer}
                      disabled={locked}
                      placeholder={answerPlaceholder}
                      aria-labelledby={`clarify-${run.id}-${clarification.id}`}
                      data-no-auto-translate
                      onChange={(e) => setDraft((d) => setAnswer(d, clarification.id, e.target.value))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="rf-annot me-2 text-foreground">
              <Phrase text={RESEARCH_COPY.scope.sources} />
            </h3>
            {kinds.length > 0 && (
              <span lang={contentLang} className="rf-annot">
                {kinds.join(" · ")}
              </span>
            )}
          </div>
          {draft.pinnedSources.length > 0 && (
            <ul className="space-y-1">
              {draft.pinnedSources.map((url) => (
                <li key={url} className="flex items-center gap-2 text-caption text-muted-foreground">
                  <bdi translate="no" className="min-w-0 flex-1 truncate font-mono">
                    {url}
                  </bdi>
                  <Pressable kind="icon" size="sm" disabled={locked} aria-label={removeSourceLabel} onClick={() => setDraft((d) => removeSource(d, url))}>
                    <X className="size-3.5" />
                  </Pressable>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitSource();
            }}
          >
            <Input
              type="url"
              inputMode="url"
              value={sourceText}
              disabled={locked}
              placeholder={sourcePlaceholder}
              aria-invalid={sourceInvalid || undefined}
              aria-describedby={sourceInvalid ? `source-error-${run.id}` : undefined}
              data-no-auto-translate
              onChange={(e) => {
                setSourceText(e.target.value);
                setSourceInvalid(false);
              }}
              className="h-8 flex-1 text-caption"
            />
            <Button type="submit" variant="outline" size="sm" disabled={locked || !sourceText.trim()}>
              <Phrase text={RESEARCH_COPY.scope.addSourceAction} />
            </Button>
          </form>
          {sourceInvalid && (
            <p id={`source-error-${run.id}`} className="text-caption text-warning-foreground">
              <Phrase text={RESEARCH_COPY.scope.invalidSource} />
            </p>
          )}
        </div>
      </div>

      <footer className={cn("sticky bottom-0 z-[1] space-y-2 border-t px-4 py-3 @[28rem]/scope:static", embedded ? "border-[var(--rf-line)] bg-background" : "rounded-b-card border-border/60 bg-card")}>
        {estimate && <PhraseWithArgs spec={estimateLine(estimate)} className="block text-caption text-muted-foreground" />}
        {notify && (
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.scope.notifyMe} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNotify(false);
                try {
                  void Notification.requestPermission();
                } catch {
                  // No Notification API here: the line simply goes away.
                }
              }}
            >
              <Phrase text={RESEARCH_COPY.scope.notifyAction} />
            </Button>
          </div>
        )}
        {revising && (
          <p role="status" className="text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.scope.updating} />
          </p>
        )}
        {error && (
          <p role="alert" className="text-caption text-warning-foreground">
            <PhraseWithArgs spec={error} />
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={locked} onClick={() => void send("/plan", { decision: "cancel" })}>
            <Phrase text={RESEARCH_COPY.scope.cancel} />
          </Button>
          {draft.edited && (
            <Button variant="outline" size="sm" disabled={locked} onClick={() => void send("/plan", planBody(draft, "revise"))}>
              <Phrase text={RESEARCH_COPY.scope.updatePlan} />
            </Button>
          )}
          <Button size="sm" disabled={locked || !canStart(draft)} aria-label={startName} onClick={() => void start()}>
            <Phrase text={RESEARCH_COPY.scope.start} />
          </Button>
        </div>
      </footer>
    </section>
  );
}
