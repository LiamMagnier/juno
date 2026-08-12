"use client";

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
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

  // One radius across both placements (18px = the popover rung; the inline variant
  // was also stepping to 20px at sm for no reason), and the floating placement takes
  // the shared overlay material instead of a sixth hand-copied version of it. This
  // surface is anchored to the composer exactly like a popover, so it should not
  // have been shipping two radii and two materials depending on where it sits.
  const shellClass =
    variant === "inline"
      // `bg-card/40` was a no-op: the inline variant is rendered INSIDE the
      // composer shell, which is itself `bg-card`, so card at 40% over card
      // resolved to card. A step inside a card is --secondary, per the ladder.
      ? "relative flex w-full flex-col overflow-hidden rounded-popover border border-border/55 bg-secondary text-foreground"
      : "relative mb-2 flex w-full flex-col overflow-hidden rounded-popover overlay-glass";

  return (
    <div
      role="dialog"
      aria-label={pending.result.title || "Quick question"}
      aria-describedby="clarification-question"
      className={cn(
        shellClass,
        // The floating-layer entrance, same as every other one. The old chain ran
        // 360ms on ease-out-expo, which needs ~440ms to read as anything but a
        // lunge-then-crawl. It grows out of the composer edge it is pinned to.
        "origin-bottom motion-safe:animate-pop-in motion-reduce:animate-none"
      )}
    >
      {/* Header */}
      <header className="relative flex items-start gap-3 px-3.5 pb-0 pt-3.5 sm:gap-3.5 sm:px-5 sm:pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
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
                  // "Which question am I on" was marked with a ring drawn from
                  // --foreground — a white halo in dark that also computes to
                  // ~1.1:1 against the card, so the only wayfinding mark on the
                  // rail was both a glow and invisible. Colour carries it now:
                  // the current segment is the accent, past segments are ink,
                  // future ones are the muted track.
                  filled ? "bg-foreground/70" : "bg-muted",
                  itemIndex === index && "bg-primary"
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
                  style={staggerDelay(optionIndex, "tight")}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "group/opt flex min-h-11 w-full items-start gap-3 rounded-menu border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform,color] duration-base ease-out-soft",
                      "sm:min-h-12 sm:items-center sm:rounded-menu sm:px-3.5 sm:py-3",
                      "active:scale-[0.99] motion-reduce:active:scale-100",
                      // No hand-rolled ring. `ring-offset-card` paints a solid
                      // CARD-coloured gap, and this component renders in two
                      // places — inline over the composer and floating as a
                      // popover — so in the floating case the focused option
                      // wore a 2px ring of a surface that is not underneath it.
                      // The global `:focus-visible` outline (globals.css) is the
                      // authoritative indicator and leaves the real surface
                      // showing; `outline-none` here was suppressing it.
                      "disabled:pointer-events-none disabled:opacity-55",
                      selected
                        // `dark:border-foreground/18` is off Tailwind's opacity
                        // scale and compiled to nothing, so the dark fill next to
                        // it landed without its paired border. Bracketed so the
                        // 18 the tuning wanted actually ships.
                        ? "border-foreground/20 bg-foreground/[0.04] shadow-soft dark:border-foreground/[0.18] dark:bg-foreground/[0.06]"
                        // Was `bg-background/40`, which is the PAGE colour painted
                        // inside a floating panel: on dark that is black at 40%
                        // over the 13% popover, i.e. each unanswered option read
                        // as a hole punched through the panel. An unselected row
                        // needs no fill at all — the border carries it, and the
                        // hover lands on a real rung (accent at full strength;
                        // accent/40 over accent-lightness popover was invisible).
                        : "border-border/60 bg-transparent hover:border-border hover:bg-accent"
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
              "flex flex-col gap-2 rounded-menu border px-3 py-2.5 transition-[border-color,background-color] duration-base ease-out-soft sm:rounded-menu sm:px-3.5 sm:py-3",
              currentAnswer?.source === "else"
                ? "border-foreground/20 bg-foreground/[0.03]"
                : "border-dashed border-border/70 bg-transparent focus-within:border-border focus-within:bg-muted/20"
            )}
          >
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
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
          // `rounded-lg` is 16px — the SURFACE rung, on a bare text button one
          // line tall, so the focus outline bowed out at the corners. `control`
          // is the rung the ghost buttons beside it already sit on.
          className="order-2 self-start rounded-control px-1 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:opacity-50 sm:order-1"
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
              // No `shadow-none`. Utilities beat the components layer, so it was
              // erasing the inset top highlight Button's `default` variant draws
              // — the only elevation cue a solid coral fill has left on a black
              // ground. This is the primary action of the panel.
              "min-w-[7.5rem] rounded-full px-4 transition-[transform,opacity,background-color] duration-base ease-out-soft",
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
          // The caret has to be made of the same material as the panel it points
          // out of. That material is now `.overlay-glass`, which is an OPAQUE
          // --popover with `backdrop-filter: none` — so the old `bg-popover/90`
          // plus a blur was a second, translucent material meeting the panel at
          // its bottom edge, and the seam showed. Full opacity, no blur.
          className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-b border-r border-border/60 bg-popover"
        />
      ) : null}
    </div>
  );
}
