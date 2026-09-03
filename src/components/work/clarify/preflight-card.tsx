"use client";

import * as React from "react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import type { PreflightClarificationAnswer } from "@/lib/preflight-clarification";
import { cn } from "@/lib/utils";
import {
  recommendedOption,
  type WorkPreflightQuestion,
} from "@/components/work/clarify/preflight";

/*
 * "Before it starts" — the pre-flight card under the Work composer.
 *
 * Every question opens on its recommendation, already chosen. That is the whole
 * ergonomics of this surface and it decides everything else about it: the
 * primary button is not "submit my answers", it is "these are right" — one
 * press, no reading required — and disagreeing costs one extra click on the row
 * you disagree with. A card that opened with nothing selected would be a form,
 * and a form in front of a composer is a toll.
 *
 * Skipping is not a button that has to be found. The send control on the
 * composer above never stops working while this is open, so the fastest way
 * past the card is the same key that has always started a task; the Skip here
 * exists so the card can be got rid of, not so it can be escaped. Nothing in
 * this file may ever gate `canStart`.
 *
 * Drawn in Juno's register rather than Cowork's: hairline border, the card
 * surface, a mono eyebrow, a serif question line, and rows that sit quietly
 * until they are chosen. The recommendation wears a small mono badge rather
 * than a filled accent block — the reader is being told what Juno would do, not
 * being pushed at.
 */

interface PreflightCardProps {
  questions: readonly WorkPreflightQuestion[];
  disabled: boolean;
  /**
   * The chosen answers as text, plus the apps whose "yes" has to become a
   * grant. The two are handed over together because they are one decision and
   * a caller that applied only the first would write "switch GitHub on" into
   * the goal of a task that cannot reach GitHub.
   */
  onAccept: (answers: PreflightClarificationAnswer[], grantConnectorIds: string[]) => void;
  onSkip: () => void;
}

export function WorkPreflightCard({ questions, disabled, onAccept, onSkip }: PreflightCardProps) {
  /**
   * Which option is chosen per question, seeded with the recommendations.
   *
   * Re-seeded whenever the set of questions changes rather than merged into:
   * the questions are re-read from the goal on every keystroke, so a question
   * that comes back after the sentence around it was rewritten is a different
   * question wearing the same id, and carrying the old choice forward would be
   * the card answering on the reader's behalf.
   *
   * The separator is a NUL, because a question id is an arbitrary string
   * and any printable separator could appear inside one. Written as an escape
   * rather than the raw byte this line used to hold: a literal NUL makes git
   * classify the file as binary, so every diff, merge and grep over it went
   * silently past.
   */
  const questionKey = questions.map((question) => question.id).join("\u0000");
  const [chosen, setChosen] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    setChosen(
      Object.fromEntries(
        questions.map((question) => [question.id, recommendedOption(question).label])
      )
    );
    // `questionKey` is the identity of the set; the array is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionKey]);

  const accept = () => {
    if (disabled) return;
    const answers: PreflightClarificationAnswer[] = [];
    const grants: string[] = [];
    for (const question of questions) {
      const value = chosen[question.id] ?? recommendedOption(question).label;
      answers.push({
        questionId: question.id,
        question: question.question,
        source: "option",
        value,
      });
      // Only the recommended answer to a connector question is a grant. "No —
      // work only from what is in the task" is the switch staying off, which is
      // where it already is.
      if (question.grantsConnectorId && value === recommendedOption(question).label) {
        grants.push(question.grantsConnectorId);
      }
    }
    onAccept(answers, grants);
  };

  const allRecommended = questions.every(
    (question) => (chosen[question.id] ?? recommendedOption(question).label) === recommendedOption(question).label
  );

  return (
    <section
      aria-label="Questions before this task starts"
      // Full `bg-card` and a full-strength border. At `bg-card/40` this hung off
      // an elevated composer shell at ~2.6% lightness on black — the card that asks
      // run-defining questions was less present than the box above it.
      className="mt-3 overflow-hidden rounded-popover border border-border bg-card motion-safe:animate-rise-in"
    >
      <header className="flex items-start gap-3 px-3.5 pt-3.5 sm:px-4">
        <div className="min-w-0 flex-1">
          {/* `text-label` supplies 0.10em, the config's stated editorial maximum
              for caps. The two badges on this card were hand-tracked at 0.16em and
              0.14em — past the ceiling, and disagreeing with each other. */}
          <p className="font-mono text-label text-muted-foreground">
            Before it starts
          </p>
          {/* Says what the card is for in the one sentence that makes accepting
              it safe: these are decisions being made either way, and this is the
              only moment they are cheap to change. */}
          <p className="mt-1 max-w-prose text-ui leading-relaxed text-muted-foreground">
            {questions.length === 1
              ? "Juno would decide this on its own. Its answer is already chosen."
              : `Juno would decide these ${questions.length} on its own. Its answers are already chosen.`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onSkip}
          disabled={disabled}
          aria-label="Dismiss these questions"
          className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <ActionIcons.dismiss className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="flex flex-col gap-3.5 px-3.5 py-3.5 sm:gap-4 sm:px-4 sm:py-4">
        {questions.map((question) => {
          const current = chosen[question.id] ?? recommendedOption(question).label;
          return (
            <div key={question.id} role="radiogroup" aria-label={question.question}>
              {/* `text-body` → `text-body-lg`, which is the ladder. The
                  arbitrary pair here spelled `text-body`'s own size out longhand
                  and then hand-added a -0.01em the rung does not carry, and
                  stepped up to Tailwind's `text-base` — a size the Juno scale
                  does not have. `leading-snug` stays: these are questions, and
                  the rung's 1.6 is a reading measure. */}
              <p className="font-sans text-body font-medium leading-snug text-foreground sm:text-body-lg">
                {question.question}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {question.options.map((option) => {
                  const selected = option.label === current;
                  return (
                    // `Pressable kind="row"` decides what selected looks like on
                    // this surface. This had invented a third selected idiom —
                    // a foreground tint — beside the schedule editor's native
                    // radios and SegmentedControl, and sat at
                    // `rounded-composer-action`, a radius derived for the
                    // composer's 36px send button and for nothing else.
                    <Pressable
                      key={option.label}
                      kind="row"
                      size="lg"
                      selected={selected}
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      onClick={() => setChosen((prev) => ({ ...prev, [question.id]: option.label }))}
                      className="min-h-10 coarse:min-h-11"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-fast ease-out-soft",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-border"
                        )}
                      >
                        {selected && <StatusIcons.success className="size-2.5" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1 text-ui leading-relaxed">{option.label}</span>
                      {option.recommended && (
                        // The word Cowork uses, in Juno's smallest mono. It is a
                        // label on the option rather than a sentence under it,
                        // so the row can be read in one pass.
                        <span className="shrink-0 font-mono text-label text-muted-foreground">
                          Recommended
                        </span>
                      )}
                    </Pressable>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3.5 py-2.5 sm:px-4">
        {/* No `rounded-composer-control` override: that radius is derived for the
            composer's seated controls, and `size="sm"` already supplies
            `rounded-control`, the general small-control rung. */}
        <Button type="button" size="sm" onClick={accept} disabled={disabled}>
          {/* Two labels, one button. Saying "Use these answers" when nothing has
              been changed would hide the fact that the reader is agreeing to
              Juno's own picks, which is the fact the card exists to expose. */}
          {allRecommended ? "Use the recommended answers" : "Use these answers"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSkip}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground"
        >
          Skip
        </Button>
        <p className="ml-auto hidden text-caption text-muted-foreground sm:block">
          Answers go into the task, where you can edit them.
        </p>
      </div>
    </section>
  );
}
