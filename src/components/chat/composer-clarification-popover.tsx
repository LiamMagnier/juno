"use client";

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, HelpCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
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
  const active = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const currentAnswer = answers[active.id];
  const isFinal = index === questions.length - 1;
  const canContinue = activeAnswer(active, currentAnswer);
  const customValue = currentAnswer?.source === "else" ? valueAsString(currentAnswer.value) : "";
  const customIsLong = active.type === "text-long";

  React.useEffect(() => {
    setIndex(0);
    setAnswers({});
  }, [pending.id]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const continueOrSubmit = async () => {
    if (disabled || !canContinue) return;
    if (!isFinal) {
      setIndex((current) => Math.min(questions.length - 1, current + 1));
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

  if (variant === "inline") {
    return (
      <div
        role="dialog"
        aria-label={pending.result.title}
        className="relative flex w-full flex-col overflow-hidden rounded-[18px] border border-border/60 bg-background/72 text-foreground shadow-soft motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 duration-base ease-out-expo"
      >
        <div className="flex flex-row items-start gap-3 space-y-0 p-4 pb-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-primary/15 bg-primary/10 text-primary">
            <HelpCircle className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-primary">Quick question</span>
              <span className="font-mono text-label uppercase text-muted-foreground">
                {index + 1} of {questions.length}
              </span>
            </div>
            <h3 className="mt-1 text-base font-semibold leading-tight">{pending.result.title}</h3>
            {pending.result.description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{pending.result.description}</p>}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} disabled={disabled} aria-label="Cancel clarification">
            <X data-icon="inline-start" />
          </Button>
        </div>

        {questions.length > 1 && (
          <div className="mx-4 flex h-1 gap-1 overflow-hidden rounded-full bg-muted" aria-label={`Question ${index + 1} of ${questions.length}`}>
            {questions.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => setIndex(itemIndex)}
                aria-label={`Go to question ${itemIndex + 1}`}
                className={cn("h-full flex-1 rounded-full transition-colors duration-base", itemIndex <= index ? "bg-primary" : "bg-transparent")}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 p-4 pt-3">
          <div>
            <h4 className="text-lg font-semibold leading-snug">{active.question}</h4>
          </div>

          {active.options.length > 0 && (
            <div className="flex flex-col gap-2" aria-label="Quick options">
              {active.options.map((option, optionIndex) => {
                const selected = optionSelected(currentAnswer, option);
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-[13px] border bg-card/55 px-3 py-2.5 text-left text-sm transition-all duration-base hover:border-primary/40 hover:bg-accent/40 disabled:opacity-60",
                      selected && "border-primary/55 bg-primary/10 shadow-soft"
                    )}
                    aria-pressed={selected}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-[8px] border bg-background font-mono text-caption font-semibold text-muted-foreground transition-colors duration-fast",
                        selected && "border-primary/45 bg-primary text-primary-foreground"
                      )}
                    >
                      {selected ? <Check className="size-3.5" /> : optionIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1 font-medium leading-5">{option}</span>
                  </button>
                );
              })}
            </div>
          )}

          {active.allowElse && (
            <label
              className={cn(
                "flex flex-col gap-1.5 rounded-[13px] border bg-muted/20 p-3 transition-colors duration-base",
                currentAnswer?.source === "else" && "border-primary/55 bg-primary/10"
              )}
            >
              <span className="font-mono text-label uppercase text-muted-foreground">{active.elseLabel}</span>
              {customIsLong ? (
                <Textarea
                  value={customValue}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={onCustomKeyDown}
                  disabled={disabled}
                  placeholder={active.elsePlaceholder}
                  maxLength={1000}
                  rows={3}
                  className="min-h-20 resize-none bg-background/80 rounded-[10px]"
                />
              ) : (
                <Input
                  value={customValue}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={onCustomKeyDown}
                  disabled={disabled}
                  placeholder={active.elsePlaceholder}
                  maxLength={1000}
                  className="bg-background/80 rounded-[10px]"
                />
              )}
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/55 bg-muted/15 p-3">
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
            <Button type="button" variant="ghost" size="sm" onClick={skip} disabled={disabled}>
              Use your judgment
            </Button>
            {questions.length > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={disabled || index === 0}>
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => void continueOrSubmit()} disabled={disabled || !canContinue}>
              {isFinal ? "Continue" : "Next"}
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card
      variant="elevated"
      role="dialog"
      aria-label={pending.result.title}
      className="relative mb-2 overflow-hidden rounded-[18px] border-border/70 bg-card/95 shadow-float backdrop-blur motion-safe:animate-rise-in"
    >
      <span
        aria-hidden="true"
        className="absolute -bottom-1 left-1/2 size-3 -translate-x-1/2 rotate-45 border-b border-r bg-card"
      />
      <CardHeader className="flex-row items-start gap-3 space-y-0 p-3 pb-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary shadow-soft">
          <HelpCircle className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-md font-mono text-label uppercase">
              Tune answer
            </Badge>
            <span className="font-mono text-label uppercase text-muted-foreground">
              {index + 1} of {questions.length}
            </span>
          </div>
          <h3 className="mt-1 text-base font-semibold leading-tight">{pending.result.title}</h3>
          {pending.result.description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{pending.result.description}</p>}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} disabled={disabled} aria-label="Cancel clarification">
          <X data-icon="inline-start" />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-3 pt-2">
        <div>
          <p className="font-mono text-label uppercase text-muted-foreground">{active.id.replace(/_/g, " ")}</p>
          <h4 className="mt-1 text-lg font-semibold leading-tight">{active.question}</h4>
        </div>

        {active.options.length > 0 && (
          <div className="flex flex-col gap-2" aria-label="Quick options">
            {active.options.map((option, optionIndex) => {
              const selected = optionSelected(currentAnswer, option);
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  onClick={() => selectOption(option)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-full border bg-background/70 pl-2.5 pr-5 py-2.5 text-left text-sm transition-all duration-base hover:-translate-y-0.5 hover:border-primary/45 hover:bg-accent/35 disabled:opacity-60",
                    selected && "border-primary/60 bg-primary/10 shadow-soft"
                  )}
                  aria-pressed={selected}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border bg-card font-mono text-caption font-semibold text-muted-foreground transition-colors duration-fast",
                      selected && "border-primary/45 bg-primary/20 text-primary"
                    )}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium leading-5">{option}</span>
                </button>
              );
            })}
          </div>
        )}

        {active.allowElse && (
          <label
            className={cn(
              "flex flex-col gap-1.5 rounded-[16px] border bg-muted/25 p-3 transition-colors duration-base",
              currentAnswer?.source === "else" && "border-primary/55 bg-primary/10"
            )}
          >
            <span className="font-mono text-label uppercase text-muted-foreground">{active.elseLabel}</span>
            {customIsLong ? (
              <Textarea
                value={customValue}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={onCustomKeyDown}
                disabled={disabled}
                placeholder={active.elsePlaceholder}
                maxLength={1000}
                rows={3}
                className="min-h-20 resize-none bg-background/80 rounded-[10px]"
              />
            ) : (
              <Input
                value={customValue}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={onCustomKeyDown}
                disabled={disabled}
                placeholder={active.elsePlaceholder}
                maxLength={1000}
                className="bg-background/80 rounded-[10px]"
              />
            )}
          </label>
        )}
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t border-border/70 p-3 sm:flex-row sm:items-center sm:justify-between">
        {questions.length > 1 && (
          <div className="flex items-center gap-1.5" aria-label="Clarification progress">
            {questions.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => setIndex(itemIndex)}
                aria-label={`Go to question ${itemIndex + 1}`}
                className={cn("size-2 rounded-full bg-muted transition-all duration-base", itemIndex === index && "w-5 bg-primary")}
              />
            ))}
          </div>
        )}
        <div className={cn("flex w-full flex-wrap justify-end gap-2 sm:w-auto", questions.length <= 1 && "ml-auto")}>
          <Button type="button" variant="ghost" size="sm" onClick={skip} disabled={disabled}>
            Skip
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={disabled || index === 0}>
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Button>
          <Button type="button" size="sm" onClick={() => void continueOrSubmit()} disabled={disabled || !canContinue}>
            {isFinal ? "Continue" : "Next"}
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
