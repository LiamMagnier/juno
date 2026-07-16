"use client";

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, CircleHelp, Send, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  answerDisplayValue,
  type ClarificationAnswer,
  type ClarificationAnswerValue,
  type ClarificationQuestion,
  type ClarificationWizardBlock,
  type SubmitClarificationWizardPayload,
} from "@/lib/clarification-wizard";
import { cn } from "@/lib/utils";

interface ClarificationWizardBlockProps {
  block: ClarificationWizardBlock;
  messageId: string;
  originalUserMessage: string;
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (payload: SubmitClarificationWizardPayload) => Promise<void> | void;
}

type AnswerMap = Record<string, ClarificationAnswer>;

function valueToArray(value: ClarificationAnswerValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

function valueIsPresent(value: ClarificationAnswerValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().length > 0;
}

function initialAnswerMap(block: ClarificationWizardBlock): AnswerMap {
  const map: AnswerMap = {};
  for (const answer of block.answers) map[answer.id] = answer;
  return map;
}

function questionLabel(question: ClarificationQuestion, index: number) {
  return question.id || `Question ${index + 1}`;
}

function OptionButton({
  index,
  selected,
  disabled,
  children,
  onClick,
}: {
  index: number;
  selected: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-12 w-full items-start gap-3 rounded-lg border bg-background/70 px-3 py-3 text-left transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent/40 active:translate-y-0 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60",
        selected && "border-primary/55 bg-primary/10 shadow-soft"
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md border bg-card font-mono text-[11px] font-semibold text-muted-foreground transition-colors duration-base ease-out-soft",
          selected && "border-primary/45 bg-primary text-primary-foreground"
        )}
      >
        {selected ? <Check className="size-3.5" /> : index + 1}
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium leading-5">{children}</span>
    </button>
  );
}

function Summary({ block, answers }: { block: ClarificationWizardBlock; answers: ClarificationAnswer[] }) {
  const visibleAnswers = answers.length ? answers : block.answers;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary">
          <Check className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold leading-5">Clarification saved</h4>
            <Badge variant="secondary" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">
              Read-only
            </Badge>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">Juno will use these details to continue the original request.</p>
        </div>
      </div>
      <div className="grid gap-2">
        {visibleAnswers.length ? (
          visibleAnswers.map((answer) => (
            <div key={answer.id} className="rounded-lg border bg-background/65 px-3 py-2.5">
              <p className="text-xs font-semibold leading-4 text-muted-foreground">{answer.question ?? answer.id}</p>
              <p className="mt-1 text-sm leading-5">{answerDisplayValue(answer)}</p>
            </div>
          ))
        ) : (
          <div className="rounded-lg border bg-background/65 px-3 py-2.5 text-sm text-muted-foreground">
            No details were added.
          </div>
        )}
      </div>
    </div>
  );
}

export function ClarificationWizardBlock({
  block,
  messageId,
  originalUserMessage,
  disabled,
  busy,
  onSubmit,
}: ClarificationWizardBlockProps) {
  const [closed, setClosed] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [answerMap, setAnswerMap] = React.useState<AnswerMap>(() => initialAnswerMap(block));
  const [customDrafts, setCustomDrafts] = React.useState<Record<string, string>>({});
  const [localSubmitted, setLocalSubmitted] = React.useState(block.submitted);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    setClosed(false);
    setActiveIndex(0);
    setAnswerMap(initialAnswerMap(block));
    setCustomDrafts({});
    setLocalSubmitted(block.submitted);
  }, [block]);

  const questions = block.questions;
  const activeQuestion = questions[Math.min(activeIndex, questions.length - 1)];
  const activeAnswer = answerMap[activeQuestion.id];
  const controlsDisabled = disabled || busy || submitting || localSubmitted;
  const answered = valueIsPresent(activeAnswer?.value) || activeAnswer?.skipped === true;
  const canMoveForward = !activeQuestion.required || answered;
  const progress = `${activeIndex + 1} of ${questions.length}`;

  const saveAnswer = React.useCallback((question: ClarificationQuestion, value: ClarificationAnswerValue, skipped = false) => {
    setAnswerMap((prev) => ({
      ...prev,
      [question.id]: {
        id: question.id,
        question: question.question,
        value,
        skipped,
      },
    }));
  }, []);

  const applyCustomDraft = React.useCallback(() => {
    const draft = customDrafts[activeQuestion.id]?.trim();
    if (!draft) return false;
    saveAnswer(activeQuestion, draft);
    return true;
  }, [activeQuestion, customDrafts, saveAnswer]);

  const collectAnswers = React.useCallback(
    (nextMap = answerMap): ClarificationAnswer[] =>
      questions.map((question) => {
        const answer = nextMap[question.id];
        if (answer) return answer;
        return { id: question.id, question: question.question, skipped: true };
      }),
    [answerMap, questions]
  );

  const submit = React.useCallback(
    async (nextMap = answerMap) => {
      const answers = collectAnswers(nextMap);
      const skippedQuestions = answers.filter((answer) => answer.skipped).map((answer) => answer.question ?? answer.id);
      setSubmitting(true);
      setLocalSubmitted(true);
      try {
        await onSubmit({
          messageId,
          blockId: block.blockId,
          originalUserMessage,
          answers,
          skippedQuestions,
        });
      } catch {
        setLocalSubmitted(false);
      } finally {
        setSubmitting(false);
      }
    },
    [answerMap, block.blockId, collectAnswers, messageId, onSubmit, originalUserMessage]
  );

  const moveNext = React.useCallback(() => {
    let nextMap = answerMap;
    const draft = customDrafts[activeQuestion.id]?.trim();
    if (!activeAnswer && draft) {
      nextMap = {
        ...answerMap,
        [activeQuestion.id]: { id: activeQuestion.id, question: activeQuestion.question, value: draft },
      };
      setAnswerMap(nextMap);
    }
    if (activeIndex < questions.length - 1) {
      setActiveIndex((index) => Math.min(questions.length - 1, index + 1));
      return;
    }
    void submit(nextMap);
  }, [activeAnswer, activeIndex, activeQuestion, answerMap, customDrafts, questions.length, submit]);

  const skip = React.useCallback(() => {
    const nextMap = {
      ...answerMap,
      [activeQuestion.id]: { id: activeQuestion.id, question: activeQuestion.question, skipped: true },
    };
    setAnswerMap(nextMap);
    if (activeIndex < questions.length - 1) {
      setActiveIndex((index) => Math.min(questions.length - 1, index + 1));
      return;
    }
    void submit(nextMap);
  }, [activeIndex, activeQuestion, answerMap, questions.length, submit]);

  if (closed) return null;

  if (localSubmitted || block.submitted) {
    return (
      <section className="my-4 overflow-hidden rounded-lg border bg-card text-foreground shadow-soft motion-safe:animate-rise-in">
        <Summary block={block} answers={collectAnswers()} />
      </section>
    );
  }

  const renderQuestionInput = () => {
    const selectedValues = valueToArray(activeAnswer?.value);

    if (activeQuestion.type === "text" || activeQuestion.type === "textarea") {
      const value = typeof activeAnswer?.value === "string" ? activeAnswer.value : "";
      const commonProps = {
        value,
        disabled: controlsDisabled,
        placeholder: activeQuestion.customPlaceholder ?? "Type your answer",
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => saveAnswer(activeQuestion, event.target.value),
      };
      return activeQuestion.type === "textarea" ? (
        <Textarea {...commonProps} className="min-h-24 resize-none" />
      ) : (
        <Input {...commonProps} />
      );
    }

    if (activeQuestion.type === "checkbox" && activeQuestion.options.length === 0) {
      const checked = activeAnswer?.value === true;
      return (
        <OptionButton index={0} selected={checked} disabled={controlsDisabled} onClick={() => saveAnswer(activeQuestion, !checked)}>
          Yes
        </OptionButton>
      );
    }

    return (
      <div className="grid gap-2">
        {activeQuestion.options.map((option, index) => {
          const selected =
            activeQuestion.type === "multi-choice" || activeQuestion.type === "checkbox"
              ? selectedValues.includes(option)
              : activeAnswer?.value === option;
          return (
            <OptionButton
              key={`${activeQuestion.id}-${option}`}
              index={index}
              selected={selected}
              disabled={controlsDisabled}
              onClick={() => {
                if (activeQuestion.type === "multi-choice" || activeQuestion.type === "checkbox") {
                  const next = selected ? selectedValues.filter((value) => value !== option) : [...selectedValues, option];
                  saveAnswer(activeQuestion, next);
                  return;
                }
                saveAnswer(activeQuestion, option);
              }}
            >
              {option}
            </OptionButton>
          );
        })}
      </div>
    );
  };

  return (
    <section className="my-4 overflow-hidden rounded-lg border bg-card text-foreground shadow-soft motion-safe:animate-rise-in">
      <div className="border-b bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary shadow-soft">
            <CircleHelp className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="rounded-md font-mono text-[10px] uppercase tracking-[0.14em]">
                Clarify
              </Badge>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{progress}</span>
            </div>
            <h3 className="mt-2 text-base font-semibold leading-tight">{block.title}</h3>
            {block.description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{block.description}</p>}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setClosed(true)} aria-label={block.closeLabel}>
            <X data-icon="inline-start" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* Keyed per step so each question animates in as the wizard advances. */}
        <div key={activeIndex} className="flex flex-col gap-4 motion-safe:animate-rise-in">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {questionLabel(activeQuestion, activeIndex)}
            </p>
            <h4 className="mt-1 text-lg font-semibold leading-6">{activeQuestion.question}</h4>
            {activeQuestion.helperText && <p className="mt-1 text-sm leading-5 text-muted-foreground">{activeQuestion.helperText}</p>}
          </div>

          {renderQuestionInput()}

          {activeQuestion.allowCustom && activeQuestion.type !== "text" && activeQuestion.type !== "textarea" && (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <Input
                value={customDrafts[activeQuestion.id] ?? ""}
                disabled={controlsDisabled}
                placeholder={activeQuestion.customPlaceholder ?? "Something else"}
                onChange={(event) => setCustomDrafts((prev) => ({ ...prev, [activeQuestion.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyCustomDraft();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" disabled={controlsDisabled} onClick={applyCustomDraft}>
                Use
              </Button>
            </div>
          )}
        </div>

        {disabled && (
          <div className="rounded-lg border bg-muted/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
            This card will become interactive when Juno finishes writing.
          </div>
        )}

        <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-0.5">
            {questions.map((question, index) => (
              <button
                key={question.id}
                type="button"
                disabled={controlsDisabled}
                aria-label={`Go to question ${index + 1}`}
                aria-current={index === activeIndex ? "step" : undefined}
                onClick={() => setActiveIndex(index)}
                className="group/dot flex h-5 items-center justify-center px-1 coarse:h-7 coarse:px-1.5 disabled:pointer-events-none"
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full bg-muted transition-all duration-base ease-out-soft group-hover/dot:bg-muted-foreground/40",
                    index === activeIndex && "w-5 bg-primary group-hover/dot:bg-primary"
                  )}
                />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={controlsDisabled} onClick={skip}>
              {block.skipLabel}
            </Button>
            {questions.length > 1 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={controlsDisabled || activeIndex === 0}
                onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
              >
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
            )}
            <Button type="button" size="sm" disabled={controlsDisabled || !canMoveForward} onClick={moveNext}>
              {activeIndex === questions.length - 1 ? block.submitLabel : "Next"}
              {activeIndex === questions.length - 1 ? <Send data-icon="inline-end" /> : <ChevronRight data-icon="inline-end" />}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
