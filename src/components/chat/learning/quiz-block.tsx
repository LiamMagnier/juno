"use client";

import * as React from "react";
import { BlockShell, LessonKicker, Microcap, Reveal, TextToggle } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { QuizData } from "@/lib/learning-blocks";

const LETTERS = "ABCDEFGH";

type OptionState = "idle" | "correct" | "wrong" | "reveal" | "dim";

export interface QuizQuestionData {
  question: string;
  options: { label: string; correct: boolean; explanation?: string }[];
  explanation?: string;
  hint?: string;
}

/**
 * A self-contained quiz: walks through one or more questions (answer → learn →
 * advance) and ends on a recap that scores the run. One question degrades to
 * the plain single-question form (no progress, no recap). Purely client-side —
 * never sends a message. Shared by the standalone :::quiz block and the
 * step-lab's final-step check so the two can't drift.
 */
export function QuizInteraction({
  questions,
  onComplete,
  className,
}: {
  questions: QuizQuestionData[];
  /** Fires once when the run reaches its terminal state (answered / recap). */
  onComplete?: (score: number, total: number) => void;
  className?: string;
}) {
  const total = questions.length;
  const multi = total > 1;
  const [current, setCurrent] = React.useState(0);
  const [answers, setAnswers] = React.useState<(number | null)[]>(() => questions.map(() => null));
  const [showRecap, setShowRecap] = React.useState(false);
  const [hintOpen, setHintOpen] = React.useState(false);
  const hintId = React.useId();
  const firedRef = React.useRef(false);

  const score = React.useMemo(
    () => answers.filter((answer, i) => answer != null && questions[i].options[answer]?.correct).length,
    [answers, questions]
  );

  const fireComplete = (final: number) => {
    if (firedRef.current) return;
    firedRef.current = true;
    onComplete?.(final, total);
  };

  const q = questions[current];
  const selected = answers[current];
  const answered = selected != null;
  const chosen = selected != null ? q.options[selected] : null;
  const isCorrect = chosen?.correct ?? false;
  const correctIndex = q.options.findIndex((option) => option.correct);
  const explanation = chosen ? (chosen.explanation ?? q.explanation) : undefined;
  const isLast = current === total - 1;

  const choose = (index: number) => {
    if (answered) return;
    setAnswers((prev) => {
      const next = [...prev];
      next[current] = index;
      return next;
    });
    if (!multi) fireComplete(q.options[index]?.correct ? 1 : 0);
  };

  const advance = () => {
    if (isLast) {
      setShowRecap(true);
      fireComplete(score);
    } else {
      setCurrent((c) => c + 1);
      setHintOpen(false);
    }
  };

  const reset = () => {
    setAnswers(questions.map(() => null));
    setCurrent(0);
    setShowRecap(false);
    setHintOpen(false);
    firedRef.current = false;
  };

  // ── Recap ────────────────────────────────────────────────────────────────
  if (showRecap) {
    const perfect = score === total;
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <div className="flex flex-col gap-1">
          <Microcap className="text-primary">Recap</Microcap>
          <p className="font-serif text-[18px] font-medium leading-snug">
            You got <span className="text-primary">{score}</span> of {total} correct
            {perfect ? " — nothing missed." : "."}
          </p>
        </div>
        <ol className="flex flex-col divide-y divide-border/30">
          {questions.map((question, i) => {
            const answer = answers[i];
            const right = answer != null && question.options[answer]?.correct;
            const correctLabel = question.options.find((option) => option.correct)?.label;
            return (
              <li key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-2.5 py-2.5">
                <span
                  aria-hidden
                  className={cn("text-center font-mono text-[13px] font-semibold", right ? "text-success-ink" : "text-destructive-ink")}
                >
                  {right ? "✓" : "✕"}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-serif text-[15px] leading-6 text-foreground/90">{question.question}</span>
                  {!right && correctLabel && (
                    <span className="text-[13px] leading-5 text-muted-foreground">
                      Answer: <span className="text-foreground/80">{correctLabel}</span>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          onClick={reset}
          className="self-start rounded-[8px] py-1 font-mono text-[11px] font-semibold text-muted-foreground outline-none transition-colors duration-fast hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
        >
          Start over
        </button>
      </div>
    );
  }

  // ── A question ───────────────────────────────────────────────────────────
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {multi && (
        <div className="flex items-center justify-between gap-3">
          <Microcap>
            Question {current + 1} of {total}
          </Microcap>
          <span className="flex items-center gap-1" aria-hidden>
            {questions.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 rounded-full transition-all duration-base ease-out-soft",
                  i === current ? "w-4 bg-primary" : answers[i] != null ? "w-1.5 bg-primary/45" : "w-1.5 bg-muted-foreground/25"
                )}
              />
            ))}
          </span>
        </div>
      )}

      <p key={current} className="font-serif text-[17px] font-medium leading-snug tracking-[-0.01em] motion-safe:animate-fade-in">
        {q.question}
      </p>

      <div className="flex flex-col divide-y divide-border/30" role="group" aria-label="Answer options">
        {q.options.map((option, index) => {
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

      {q.hint && !answered && (
        <div className="flex flex-col">
          <TextToggle open={hintOpen} onToggle={() => setHintOpen((value) => !value)} label="Hint" controls={hintId} />
          <Reveal open={hintOpen} id={hintId}>
            <p className="px-2 pb-1 pt-1 font-serif text-[14px] italic leading-6 text-muted-foreground">{q.hint}</p>
          </Reveal>
        </div>
      )}

      {/* Answer key + advance. In multi mode a Next / See results button walks
          the run; single mode keeps its own Try again. */}
      <Reveal open={answered} className="duration-slow" aria-live="polite">
        {answered && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-border/50 pt-3">
            <p className="min-w-0 flex-1 basis-64 text-sm leading-6 text-muted-foreground">
              <span className={cn("font-serif text-[15px] font-medium italic", isCorrect ? "text-success-ink" : "text-destructive-ink")}>
                {isCorrect ? "Correct —" : "Not quite —"}
              </span>{" "}
              {explanation ?? (isCorrect ? "well spotted." : `the answer is ${LETTERS[correctIndex] ?? correctIndex + 1}.`)}
            </p>
            {multi ? (
              <button
                type="button"
                onClick={advance}
                className="shrink-0 rounded-[8px] py-1 font-mono text-[11px] font-semibold text-primary outline-none transition-colors duration-fast hover:text-primary/80 focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
              >
                {isLast ? "See results →" : "Next question →"}
              </button>
            ) : (
              <button
                type="button"
                onClick={reset}
                className="shrink-0 rounded-[8px] py-1 font-mono text-[11px] font-semibold text-muted-foreground outline-none transition-colors duration-fast hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </Reveal>
    </div>
  );
}

/**
 * Standalone :::quiz block — a magazine quiz. The kicker + optional title head
 * the shell; QuizInteraction owns the questions, progress, and recap.
 */
export function InteractiveQuizBlock({ quiz }: { quiz: QuizData }) {
  return (
    <BlockShell aria-label={quiz.title ? `Quiz: ${quiz.title}` : `Quick check: ${quiz.questions[0]?.question ?? ""}`}>
      <div className="flex flex-col gap-1.5 pb-3">
        <LessonKicker className="text-primary">Quick check</LessonKicker>
        {quiz.title && <h4 className="font-serif text-[19px] font-medium leading-snug tracking-[-0.01em]">{quiz.title}</h4>}
      </div>
      <QuizInteraction questions={quiz.questions} />
    </BlockShell>
  );
}
