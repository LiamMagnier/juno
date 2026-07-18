"use client";

import * as React from "react";
import { BlockShell, LessonKicker, Reveal, TextToggle } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { QuizOption } from "@/lib/learning-blocks";

const LETTERS = "ABCDEFGH";

type OptionState = "idle" | "correct" | "wrong" | "reveal" | "dim";

export interface QuizInteractionData {
  options: QuizOption[];
  explanation?: string;
  hint?: string;
}

/**
 * The shared quiz interaction — option rows, optional hint, resolution
 * choreography, and the editorial answer-key footnote. Used by the standalone
 * quiz block AND the step-lab's final-step check, so the two can never drift.
 *
 * Resolution order teaches: the chosen row resolves first, distractors recede
 * with it, and (when wrong) the correct row surfaces a beat later so the eye
 * lands on it as the explanation arrives.
 */
export function QuizInteraction({
  quiz,
  onAnswered,
  className,
}: {
  quiz: QuizInteractionData;
  /** Fires each time an answer is committed (not on reset). */
  onAnswered?: (correct: boolean) => void;
  className?: string;
}) {
  const [selected, setSelected] = React.useState<number | null>(null);
  const [hintOpen, setHintOpen] = React.useState(false);
  const hintId = React.useId();
  const answered = selected != null;
  const chosen = selected != null ? quiz.options[selected] : null;
  const isCorrect = chosen?.correct ?? false;
  const correctIndex = quiz.options.findIndex((option) => option.correct);
  const explanation = chosen ? (chosen.explanation ?? quiz.explanation) : undefined;

  const choose = (index: number) => {
    if (answered) return;
    setSelected(index);
    onAnswered?.(quiz.options[index]?.correct ?? false);
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-col divide-y divide-border/30" role="group" aria-label="Answer options">
        {quiz.options.map((option, index) => {
          const state: OptionState = !answered
            ? "idle"
            : selected === index
              ? option.correct
                ? "correct"
                : "wrong"
              : option.correct
                ? "reveal"
                : "dim";
          return (
            <button
              key={index}
              type="button"
              aria-disabled={answered}
              onClick={() => choose(index)}
              className={cn(
                "grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-baseline gap-3 border-l-2 border-transparent px-2 py-3 text-left outline-none",
                "transition-[background-color,border-color,opacity] duration-base ease-out-soft",
                "focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
                state === "idle" && "cursor-pointer hover:bg-accent/40",
                state === "correct" && "border-l-success/70 bg-success/[0.08]",
                state === "wrong" && "border-l-destructive/60 bg-destructive/[0.06] motion-safe:animate-nudge",
                // The surfaced answer arrives a beat AFTER the chosen row resolves.
                state === "reveal" && "border-l-success/70 [transition-delay:150ms]",
                state === "dim" && "opacity-50",
                answered && "cursor-default"
              )}
            >
              <span
                className={cn(
                  "relative text-center font-mono text-[12px] font-semibold transition-colors duration-base ease-out-soft",
                  state === "correct" || state === "reveal"
                    ? "text-success"
                    : state === "wrong"
                      ? "text-destructive"
                      : "text-muted-foreground"
                )}
              >
                {/* One-shot success flourish — a single pulse-ring iteration. */}
                {state === "correct" && (
                  <span
                    aria-hidden
                    className="absolute -inset-1.5 rounded-full border border-success/60 motion-safe:animate-pulse-ring-once"
                  />
                )}
                {state === "correct" || state === "reveal" ? (
                  <span className="motion-safe:animate-pop-in">✓</span>
                ) : state === "wrong" ? (
                  <span className="motion-safe:animate-pop-in">✕</span>
                ) : (
                  LETTERS[index] ?? index + 1
                )}
              </span>
              <span className="min-w-0 font-serif text-[15px] leading-6 text-foreground">{option.label}</span>
            </button>
          );
        })}
      </div>

      {/* Hint on demand — scaffolds without spoiling; gone once answered. */}
      {quiz.hint && !answered && (
        <div className="flex flex-col pt-2">
          <TextToggle open={hintOpen} onToggle={() => setHintOpen((value) => !value)} label="Hint" controls={hintId} />
          <Reveal open={hintOpen} id={hintId}>
            <p className="px-2 pb-1 pt-1 font-serif text-[14px] italic leading-6 text-muted-foreground">{quiz.hint}</p>
          </Reveal>
        </div>
      )}

      {/* The answer key — an editorial footnote, not another box. */}
      <Reveal open={answered} className="duration-slow" aria-live="polite">
        {answered && (
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-border/50 pt-3">
            <p className="min-w-0 flex-1 basis-64 text-sm leading-6 text-muted-foreground">
              {/* -ink tones: the fill colors only reach ~3:1 as light-mode text. */}
              <span className={cn("font-serif text-[15px] font-medium italic", isCorrect ? "text-success-ink" : "text-destructive-ink")}>
                {isCorrect ? "Correct —" : "Not quite —"}
              </span>{" "}
              {explanation ??
                (isCorrect ? "well spotted." : `the answer is ${LETTERS[correctIndex] ?? correctIndex + 1}.`)}
            </p>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setHintOpen(false);
              }}
              className="shrink-0 rounded-[8px] py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground outline-none transition-colors duration-fast hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
            >
              Try again
            </button>
          </div>
        )}
      </Reveal>
    </div>
  );
}

/**
 * One-question local check — a magazine quiz, not a form. The question is the
 * title; options are hairline-separated serif rows; feedback is an answer-key
 * footnote. Purely client-side, never sends a message.
 */
export function InteractiveQuizBlock({ quiz }: { quiz: QuizInteractionData & { question: string } }) {
  return (
    <BlockShell aria-label={`Quick check: ${quiz.question}`}>
      <div className="flex flex-col gap-1.5 pb-2">
        <LessonKicker className="text-primary">Quick check</LessonKicker>
        <h4 className="font-serif text-[19px] font-medium leading-snug tracking-[-0.01em]">{quiz.question}</h4>
      </div>
      <QuizInteraction quiz={quiz} />
    </BlockShell>
  );
}
