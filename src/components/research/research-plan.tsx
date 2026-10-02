"use client";

import * as React from "react";
import { RESEARCH_COPY, estimateLine } from "@/components/research/copy";
import { limitedByPhrase } from "@/components/research/research-view";
import { approachOf } from "@/components/research/scope-draft";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";

/*
 * The Plan tab (SPEC §9.11.4): the approach, the questions (read-only once
 * the run started), the sources it favours and the ones the reader added,
 * the constraints and the steering history, the estimate the run started
 * with, and — when something other than the scope bounded the run — what did,
 * in words ("Sized to your plan's limit"). No money here: that is Details.
 */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-ui font-medium text-foreground">
        <Phrase text={label} />
      </h3>
      {children}
    </section>
  );
}

export function ResearchPlan({ run }: { run: ResearchRunView }) {
  const lang = run.language ?? undefined;
  const approach = approachOf(run);
  const questions = run.questions?.length
    ? run.questions.map((q) => ({ id: q.id, question: q.question }))
    : (run.plan.objectives ?? []).map((o) => ({ id: o.id, question: o.question }));
  const kinds = run.plan.sourceKinds ?? [];
  const limited = limitedByPhrase(run.sizing?.limitedBy);
  const steering = run.steering ?? [];

  return (
    <div className="space-y-6">
      {approach && (
        <Section label={RESEARCH_COPY.plan.approach}>
          <p lang={lang} className="text-body text-foreground/90">
            {approach}
          </p>
        </Section>
      )}
      {questions.length > 0 && (
        <Section label={RESEARCH_COPY.plan.questions}>
          <ol className="list-decimal space-y-1 ps-5 text-body text-foreground/90" lang={lang}>
            {questions.map((q) => (
              <li key={q.id}>{q.question}</li>
            ))}
          </ol>
        </Section>
      )}
      {kinds.length > 0 && (
        <Section label={RESEARCH_COPY.plan.sources}>
          <div className="flex flex-wrap gap-1.5" lang={lang}>
            {kinds.map((kind) => (
              <span key={kind} className="rounded-full bg-secondary px-2 py-0.5 text-caption text-muted-foreground">
                {kind}
              </span>
            ))}
          </div>
        </Section>
      )}
      {run.plan.pinnedSources.length > 0 && (
        <Section label={RESEARCH_COPY.plan.pinned}>
          <ul className="space-y-1">
            {run.plan.pinnedSources.map((url) => (
              <li key={url} className="truncate font-mono text-caption text-muted-foreground">
                <bdi translate="no">{url}</bdi>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {run.plan.constraints.length > 0 && (
        <Section label={RESEARCH_COPY.plan.constraints}>
          <ul className="list-disc space-y-1 ps-5 text-caption text-foreground/80" lang={lang}>
            {run.plan.constraints.map((constraint) => (
              <li key={constraint}>{constraint}</li>
            ))}
          </ul>
        </Section>
      )}
      {steering.length > 0 && (
        <Section label={RESEARCH_COPY.plan.guidance}>
          <ul className="space-y-1 text-caption text-foreground/80">
            {steering.map((entry) => (
              <li key={`${entry.createdAt}:${entry.text}`}>{entry.text}</li>
            ))}
          </ul>
        </Section>
      )}
      {run.estimate && (
        <Section label={RESEARCH_COPY.plan.estimate}>
          <PhraseWithArgs spec={estimateLine(run.estimate)} className="block text-caption text-muted-foreground" />
          {limited && (
            <p className="text-caption text-muted-foreground">
              <Phrase text={limited} />
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
