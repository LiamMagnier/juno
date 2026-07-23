"use client";

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dialogSurfaceClassName } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  PendingPreflightClarification,
  PreflightClarificationAnswer,
  PreflightClarificationAnswerValue,
  PreflightClarificationQuestion,
} from "@/lib/preflight-clarification";

type AnswerMap = Record<string, PreflightClarificationAnswer>;

interface ComposerClarificationPopoverProps {
  pending: PendingPreflightClarification;
  disabled?: boolean;
  onSubmit: (answers: PreflightClarificationAnswer[]) => Promise<boolean> | boolean;
  onSkip: () => Promise<boolean> | boolean;
  onClose: () => void;
  variant?: "card" | "inline";
  onAnswersChange?: (answers: PreflightClarificationAnswer[]) => void;
}

function valuePresent(value: PreflightClarificationAnswerValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  return typeof value === "string" && value.trim().length > 0;
}

function valueAsString(value: PreflightClarificationAnswerValue | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return typeof value === "string" ? value : "";
}

function optionSelected(answer: PreflightClarificationAnswer | undefined, option: string): boolean {
  if (!answer || answer.source !== "option") return false;
  if (Array.isArray(answer.value)) return answer.value.includes(option);
  return answer.value === option;
}

function activeAnswer(question: PreflightClarificationQuestion, answer: PreflightClarificationAnswer | undefined): boolean {
  if (question.required) return valuePresent(answer?.value);
  return true;
}

/**
 * Pre-answer clarification surface.
 *
 * Editorial, calm, content-first: serif question, quiet mono progress, soft
 * option rows (not pill spam), deliberate motion. `inline` lives inside the
 * composer shell; `card` floats above it with a caret.
 */
export function ComposerClarificationPopover({
  pending,
  disabled,
  onSubmit,
  onSkip,
  onClose,
  variant = "card",
  onAnswersChange,
}: ComposerClarificationPopoverProps) {
  const questions = pending.result.questions;
  const [index, setIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<AnswerMap>({});
  const [stepKey, setStepKey] = React.useState(0);
  const active = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const currentAnswer = answers[active.id];
  const isFinal = index === questions.length - 1;
  const canContinue = activeAnswer(active, currentAnswer);
  const customValue = currentAnswer?.source === "else" ? valueAsString(currentAnswer.value) : "";
  const customIsLong = active.type === "text-long";
  const multi = questions.length > 1;

  React.useEffect(() => {
    setIndex(0);
    setAnswers({});
    setStepKey((k) => k + 1);
  }, [pending.id]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Number keys 1–9 select options when not typing in a field.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const n = Number(event.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const option = active.options[n - 1];
      if (!option) return;
      event.preventDefault();
      selectOption(option);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // selectOption closes over active; rebind when the step changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentAnswer, disabled]);

  const saveAnswer = React.useCallback((question: PreflightClarificationQuestion, answer: PreflightClarificationAnswer | null) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (answer && valuePresent(answer.value)) next[question.id] = answer;
      else delete next[question.id];
      return next;
    });
  }, []);

  const selectOption = (option: string) => {
    if (disabled) return;
    if (active.type === "multi-choice") {
      const previous = currentAnswer?.source === "option" && Array.isArray(currentAnswer.value) ? currentAnswer.value : [];
      const next = previous.includes(option) ? previous.filter((item) => item !== option) : [...previous, option];
      saveAnswer(active, {
        questionId: active.id,
        question: active.question,
        source: "option",
        value: next,
      });
      return;
    }
    saveAnswer(active, {
      questionId: active.id,
      question: active.question,
      source: "option",
      value: option,
    });
  };

  const setCustom = (value: string) => {
    saveAnswer(
      active,
      value.trim()
        ? {
            questionId: active.id,
            question: active.question,
            source: "else",
            value,
          }
        : null
    );
  };

  const collectAnswers = React.useCallback(() => Object.values(answers).filter((answer) => valuePresent(answer.value)), [answers]);

  React.useEffect(() => {
    onAnswersChange?.(collectAnswers());
  }, [answers, collectAnswers, onAnswersChange]);

  const goTo = (nextIndex: number) => {
    setIndex(nextIndex);
    setStepKey((k) => k + 1);
  };

  const continueOrSubmit = async () => {
    if (disabled || !canContinue) return;
    if (!isFinal) {
      goTo(Math.min(questions.length - 1, index + 1));
      return;
    }
    await onSubmit(collectAnswers());
  };

  const skip = async () => {
    if (disabled) return;
    await onSkip();
  };

  const onCustomKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void continueOrSubmit();
    }
  };

  // Inline sits *inside* the composer shell, so it stays a quiet 18px well.
  // Floating is a real layer above it and wears the shared modal surface —
  // it used to invent its own 22/24px radius and opaque card fill.
  const shellClass =
    variant === "inline"
      ? "relative flex w-full flex-col overflow-hidden rounded-[18px] border border-border/55 bg-card/40 text-foreground"
      : cn("relative mb-2 flex w-full flex-col overflow-hidden", dialogSurfaceClassName);

  return (
    <div
      role="dialog"
      aria-label={pending.result.title || "Quick question"}
      aria-describedby="clarification-question"
      className={cn(
        shellClass,
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-slow motion-safe:ease-out-expo motion-reduce:animate-none"
      )}
    >
      {/* Subtle top sheen — depth without chrome noise */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-[hsl(var(--sheen)/0.55)] to-transparent"
      />

      {/* Header */}
      <header className="relative flex items-start gap-3 px-3.5 pb-0 pt-3.5 sm:gap-3.5 sm:px-5 sm:pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono text-[10px] font-medium text-muted-foreground">
              {multi ? `Question ${index + 1} of ${questions.length}` : "One quick question"}
            </span>
            {pending.result.title ? (
              <>
                <span aria-hidden className="text-border">
                  ·
                </span>
                <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-foreground/85">
                  {pending.result.title}
                </span>
              </>
            ) : null}
          </div>
          {pending.result.description ? (
            <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              {pending.result.description}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          disabled={disabled}
          aria-label="Cancel clarification"
          className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>

      {/* Progress — only when multi-step; hairline segments, not a loud bar */}
      {multi ? (
        <div
          className="relative mx-3.5 mt-3 flex gap-1 sm:mx-5"
          aria-label={`Question ${index + 1} of ${questions.length}`}
        >
          {questions.map((item, itemIndex) => {
            const filled = itemIndex <= index;
            const answered = valuePresent(answers[item.id]?.value);
            return (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => goTo(itemIndex)}
                aria-label={`Go to question ${itemIndex + 1}${answered ? ", answered" : ""}`}
                aria-current={itemIndex === index ? "step" : undefined}
                className={cn(
                  "h-1 flex-1 rounded-full transition-[background-color,transform] duration-base ease-out-soft",
                  filled ? "bg-foreground/70" : "bg-foreground/10",
                  itemIndex === index && "ring-1 ring-foreground/15 ring-offset-1 ring-offset-card"
                )}
              />
            );
          })}
        </div>
      ) : null}

      {/* Body — keyed so each step rises in cleanly */}
      <div
        key={`${pending.id}-${active.id}-${stepKey}`}
        className="relative flex flex-col gap-3.5 px-3.5 py-3.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-1 motion-safe:duration-base motion-safe:ease-out-soft motion-reduce:animate-none sm:gap-4 sm:px-5 sm:py-4"
      >
        <h3
          id="clarification-question"
          className="font-serif text-[1.125rem] font-medium leading-snug tracking-[-0.02em] text-foreground sm:text-[1.25rem] sm:leading-snug"
        >
          {active.question}
        </h3>

        {active.options.length > 0 ? (
          <ul className="flex flex-col gap-1.5 sm:gap-2" aria-label="Options" role="listbox" aria-multiselectable={active.type === "multi-choice"}>
            {active.options.map((option, optionIndex) => {
              const selected = optionSelected(currentAnswer, option);
              return (
                <li
                  key={option}
                  className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:fill-mode-both motion-reduce:animate-none"
                  style={{ animationDelay: `${Math.min(optionIndex, 8) * 35}ms` }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "group/opt flex min-h-11 w-full items-start gap-3 rounded-[14px] border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform,color] duration-base ease-out-soft",
                      "sm:min-h-12 sm:items-center sm:rounded-[15px] sm:px-3.5 sm:py-3",
                      "active:scale-[0.99] motion-reduce:active:scale-100",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                      "disabled:pointer-events-none disabled:opacity-55",
                      selected
                        ? "border-foreground/20 bg-foreground/[0.04] shadow-soft dark:border-foreground/18 dark:bg-foreground/[0.06]"
                        : "border-border/60 bg-background/40 hover:border-border hover:bg-accent/40"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-medium tabular-nums transition-[background-color,border-color,color,transform] duration-base ease-out-soft sm:mt-0 sm:size-7",
                        selected
                          ? "border-foreground bg-foreground text-background scale-100"
                          : "border-border/70 bg-card text-muted-foreground group-hover/opt:border-foreground/25"
                      )}
                      aria-hidden
                    >
                      {selected ? (
                        <Check className="size-3.5 motion-safe:animate-in motion-safe:zoom-in-75 motion-safe:duration-fast" strokeWidth={2.5} />
                      ) : (
                        optionIndex + 1
                      )}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-[0.9375rem] leading-snug tracking-[-0.01em] transition-colors duration-fast",
                        selected ? "font-medium text-foreground" : "text-foreground/90"
                      )}
                    >
                      {option}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {active.allowElse ? (
          <label
            className={cn(
              "flex flex-col gap-2 rounded-[14px] border px-3 py-2.5 transition-[border-color,background-color] duration-base ease-out-soft sm:rounded-[15px] sm:px-3.5 sm:py-3",
              currentAnswer?.source === "else"
                ? "border-foreground/20 bg-foreground/[0.03]"
                : "border-dashed border-border/70 bg-transparent focus-within:border-border focus-within:bg-muted/20"
            )}
          >
            <span className="font-mono text-[10px] font-medium text-muted-foreground">
              {active.elseLabel || "Or write your own"}
            </span>
            {customIsLong ? (
              <Textarea
                value={customValue}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={onCustomKeyDown}
                disabled={disabled}
                placeholder={active.elsePlaceholder || "Type your answer…"}
                maxLength={1000}
                rows={3}
                className="min-h-[4.5rem] resize-none border-0 bg-transparent p-0 text-[0.9375rem] shadow-none focus-visible:ring-0"
              />
            ) : (
              <Input
                value={customValue}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={onCustomKeyDown}
                disabled={disabled}
                placeholder={active.elsePlaceholder || "Type your answer…"}
                maxLength={1000}
                className="h-auto border-0 bg-transparent p-0 text-[0.9375rem] shadow-none focus-visible:ring-0"
              />
            )}
          </label>
        ) : null}
      </div>

      {/* Footer actions */}
      <footer className="relative flex flex-col gap-2 border-t border-border/50 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <button
          type="button"
          onClick={() => void skip()}
          disabled={disabled}
          className="order-2 self-start rounded-lg px-1 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-50 sm:order-1"
        >
          Use your judgment
        </button>

        <div className="order-1 flex w-full items-center justify-end gap-2 sm:order-2 sm:w-auto">
          {multi ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => goTo(Math.max(0, index - 1))}
              disabled={disabled || index === 0}
              className="rounded-full px-3"
            >
              <ChevronLeft className="size-4" />
              <span className="sr-only sm:not-sr-only">Back</span>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void continueOrSubmit()}
            disabled={disabled || !canContinue}
            className={cn(
              "min-w-[7.5rem] rounded-full px-4 shadow-none transition-[transform,opacity,background-color] duration-base ease-out-soft",
              "active:scale-[0.98] motion-reduce:active:scale-100"
            )}
          >
            {isFinal ? "Continue" : "Next"}
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </footer>

      {/* Card caret only when floating above the composer */}
      {variant === "card" ? (
        <span
          aria-hidden
          className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-b border-r border-border/60 bg-card/85"
        />
      ) : null}
    </div>
  );
}
