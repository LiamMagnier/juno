"use client";

import * as React from "react";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import type { ResearchEmergingAnswer } from "@/types/research";
import type { WorkspaceQuestion } from "./workspace-model";

const KNOWN_COPY = {
  heading: "What we know so far",
  writing: "While the report is written",
  of: "questions with evidence",
  sources: (n: number) => (n === 1 ? "1 source" : `${n} sources`),
  note: "Researchers' notes from the sources, not yet the report's conclusions.",
} as const;

/**
 * The interim answer (RESEARCH_V2 §3): under each question, the strongest
 * note a researcher has made so far, in its own words, with the page it
 * quotes. Neither ChatGPT nor Claude shows anything readable before the
 * report; this is readable from the first finding, and it stays on screen
 * while the report is written and checked.
 *
 * Built from findings the workers already extracted: free, and unable to say
 * anything the evidence does not. Numbered as the plan numbers its questions,
 * divided by dot rules. A question's row rises in when its note first
 * appears or a stronger one replaces it; nothing loops, and reduced motion
 * places it.
 */
export function EmergingAnswers({
  answers,
  questions,
  language,
  writing,
  className,
}: {
  answers: readonly ResearchEmergingAnswer[];
  questions: readonly WorkspaceQuestion[];
  language: string | null | undefined;
  /** The run is writing or checking the report: the notes are what to read meanwhile. */
  writing: boolean;
  className?: string;
}) {
  const index = new Map(questions.map((question, i) => [question.id, i]));
  const rows = answers
    .filter((answer) => index.has(answer.questionId))
    .sort((a, b) => index.get(a.questionId)! - index.get(b.questionId)!);
  if (rows.length === 0) return null;
  return (
    <section className={className ? `rf-known ${className}` : "rf-known"} aria-label={KNOWN_COPY.heading}>
      <p className="rf-annot flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-foreground">{writing ? KNOWN_COPY.writing : KNOWN_COPY.heading}</span>
        <span className="tabular-nums">
          {rows.length}/{questions.length} {KNOWN_COPY.of}
        </span>
      </p>
      <ol className="rf-known-list">
        {rows.map((answer) => {
          const i = index.get(answer.questionId)!;
          const question = questions[i];
          return (
            // Keyed by the claim: a stronger note replacing a weaker one is a new row arriving.
            <li key={`${answer.questionId}:${answer.claim}`} className="rf-known-row">
              <span className="rf-known-n" aria-hidden>
                {i + 1}
              </span>
              <div className="min-w-0">
                <p lang={language ?? undefined} className="rf-known-q">
                  {question.question}
                </p>
                <p lang={language ?? undefined} className="rf-claim mt-1.5">
                  {answer.claim}
                </p>
                <p className="rf-annot mt-1.5 flex flex-wrap items-baseline gap-x-2">
                  {isRenderableSourceUrl(answer.url) ? (
                    <a href={answer.url} target="_blank" rel="noopener noreferrer" title={answer.title} className="rf-link">
                      <bdi translate="no">{hostOf(answer.url)}</bdi>
                    </a>
                  ) : (
                    <bdi translate="no">{answer.title}</bdi>
                  )}
                  {answer.sources > 1 && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{KNOWN_COPY.sources(answer.sources)}</span>
                    </>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="rf-annot rf-known-note">{KNOWN_COPY.note}</p>
    </section>
  );
}
