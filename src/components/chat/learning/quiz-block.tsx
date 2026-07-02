"use client";

import * as React from "react";
import { CheckCircle2, HelpCircle, RotateCcw, XCircle } from "lucide-react";
import { BlockShell, LessonKicker, Reveal } from "@/components/chat/learning/block-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QuizData } from "@/lib/learning-blocks";

const LETTERS = "ABCDEFGH";

type OptionState = "idle" | "correct" | "wrong" | "reveal" | "dim";

/**
 * One-question local check. Feedback is purely client-side state — never
 * sends a message or fetches. After answering, the correct option is always
 * surfaced and a "Try again" ghost resets the state.
 */
export function InteractiveQuizBlock({ quiz }: { quiz: QuizData }) {
  const [selected, setSelected] = React.useState<number | null>(null);
  const answered = selected != null;
  const chosen = selected != null ? quiz.options[selected] : null;
  const isCorrect = chosen?.correct ?? false;
  const correctIndex = quiz.options.findIndex((option) => option.correct);
  const explanation = chosen ? (chosen.explanation ?? quiz.explanation) : undefined;

  return (
    <BlockShell
      aria-label={`Quick check: ${quiz.question}`}
    >
      <div className="px-4 py-4 sm:px-5">
        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary">
            <HelpCircle aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <LessonKicker className="text-primary/80">Quick check</LessonKicker>
              <span className="rounded-full border border-border/65 bg-background/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {quiz.options.length} choices
              </span>
            </div>
            <h4 className="pt-1.5 font-serif text-[18px] font-semibold leading-tight tracking-tight">{quiz.question}</h4>
          </div>
        </div>
      </div>

      <div className="grid gap-2 px-3 pb-3 sm:px-4" role="group" aria-label="Answer options">
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
            <Button
              key={index}
              type="button"
              variant="outline"
              aria-disabled={answered}
              onClick={() => {
                if (!answered) setSelected(index);
              }}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-3 whitespace-normal rounded-[12px] px-3 py-2.5 text-left text-sm leading-6 shadow-none",
                "motion-safe:animate-rise-in [animation-fill-mode:backwards]",
                state === "idle" && "border-border/70 bg-background/45 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent/30",
                state === "correct" && "border-success/55 bg-success/10",
                state === "wrong" && "border-destructive/50 bg-destructive/10",
                state === "reveal" && "border-success/45 bg-success/5 ring-1 ring-success/35",
                state === "dim" && "border-border/60 bg-background/30 opacity-55",
                answered && "cursor-default"
              )}
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-sm border font-mono text-[11px] font-semibold transition-colors duration-base ease-out-soft",
                  state === "correct" || state === "reveal"
                    ? "border-success/50 bg-success/15 text-success"
                    : state === "wrong"
                      ? "border-destructive/50 bg-destructive/15 text-destructive"
                      : "border-border/70 bg-muted/60 text-muted-foreground"
                )}
              >
                {LETTERS[index] ?? index + 1}
              </span>
              <span className="min-w-0 flex-1">{option.label}</span>
              {state === "correct" && <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />}
              {state === "wrong" && <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />}
              {state === "reveal" && <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success/70" />}
            </Button>
          );
        })}
      </div>

      <Reveal open={answered} aria-live="polite">
        {answered && (
          <div className="px-3 pb-4 sm:px-4">
            <div
              className={cn(
                "rounded-[14px] border px-3 py-3",
                isCorrect ? "border-success/35 bg-success/5" : "border-destructive/30 bg-destructive/5"
              )}
            >
              <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-[10px] border",
                    isCorrect ? "border-success/35 bg-success/10 text-success" : "border-destructive/35 bg-destructive/10 text-destructive"
                  )}
                >
                  {isCorrect ? <CheckCircle2 aria-hidden className="size-4" /> : <XCircle aria-hidden className="size-4" />}
                </span>
                <p className="text-sm leading-6 text-muted-foreground">
                  <span className={cn("font-semibold", isCorrect ? "text-success" : "text-destructive")}>
                    {isCorrect ? "Correct" : "Not quite"}
                  </span>
                  {explanation ? (
                    <>. {explanation}</>
                  ) : isCorrect ? (
                    "."
                  ) : (
                    <>. The correct answer is {LETTERS[correctIndex] ?? correctIndex + 1}.</>
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(null)}
                  className="h-8 gap-1.5 rounded-[10px] px-2.5 font-mono text-[10px] uppercase text-muted-foreground coarse:h-10"
                >
                  <RotateCcw aria-hidden className="size-3" />
                  Try again
                </Button>
              </div>
            </div>
          </div>
        )}
      </Reveal>
    </BlockShell>
  );
}
