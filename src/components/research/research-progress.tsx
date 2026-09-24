"use client";

import * as React from "react";
import { SourceFavicon } from "@/components/chat/source-chip";
import { RESEARCH_COPY } from "@/components/research/copy";
import { QUESTION_STATUS_PHRASE, activityLines, steeringLine } from "@/components/research/research-view";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { useUiLocale, formatClock } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import type { ResearchEventDTO } from "@/lib/research/domain";
import { claimLoop, useLoopOwner } from "@/lib/run/store";
import { cn } from "@/lib/utils";
import type { ResearchQuestionView } from "@/types/research";

/*
 * The Progress tab (SPEC §9.11.4): the questions with their status, the
 * reader's guidance, the activity stream and "Found so far".
 *
 * - A question's chip cross-fades between states (220 ms) rather than
 *   swapping. The question being searched is the panel's one loop owner
 *   (priority 1, §7.9.1): its marker breathes while nothing outranks it, and
 *   the header never loops.
 * - The activity stream is one line per round boundary and notable event,
 *   newest first, at most 50, each keyed by its event so a poll never deals
 *   the list again (bug 24); lines present when the tab opens carry
 *   `data-instant` so they do not all enter at once.
 * - Content (queries, claims, quotes) carries the run's language; the chrome
 *   is in the reader's.
 */

function QuestionRow({ question, runId, lang }: { question: ResearchQuestionView; runId: string; lang?: string }) {
  const searching = question.status === "searching";
  const loopId = `research-question:${runId}:${question.id}`;
  React.useEffect(() => {
    if (!searching) return;
    return claimLoop(loopId, 1);
  }, [loopId, searching]);
  const owns = useLoopOwner(loopId);
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        aria-hidden
        className={cn("run-marker mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50", searching && "bg-foreground/70")}
        data-state={searching ? "running" : undefined}
        data-loop={searching && !owns ? "off" : undefined}
        data-run-loop-owner={searching && owns ? "" : undefined}
      />
      <span lang={lang} className="min-w-0 flex-1 text-body text-foreground/90">
        {question.question}
      </span>
      <span
        key={question.status}
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-caption motion-safe:animate-fade-in",
          question.status === "covered" && "bg-success/10 text-success-ink",
          question.status === "partial" && "bg-secondary text-foreground/80",
          question.status === "thin" && "bg-warning/10 text-warning-foreground",
          (question.status === "pending" || question.status === "searching") && "bg-secondary text-muted-foreground",
        )}
      >
        <Phrase text={QUESTION_STATUS_PHRASE[question.status]} />
      </span>
    </li>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-ui font-medium text-foreground">{children}</h3>;
}

export function ResearchProgress({ run, events }: { run: ResearchRunView; events: readonly ResearchEventDTO[] }) {
  const locale = useUiLocale();
  const lang = run.language ?? undefined;
  const questions = run.questions ?? [];
  const steering = run.steering ?? [];
  const findings = run.latestFindings ?? [];
  const lines = React.useMemo(() => activityLines(events), [events]);
  // Lines on screen when the tab opened are not "new": they must not all play their entrance.
  const initial = React.useRef<Set<string> | null>(null);
  initial.current ??= new Set(lines.map((l) => l.key));

  return (
    <div className="space-y-6">
      {questions.length > 0 && (
        <section>
          <SectionHeading>
            <Phrase text={RESEARCH_COPY.progress.questions} />
          </SectionHeading>
          <ol className="divide-y divide-border/50">
            {questions.map((question) => (
              <QuestionRow key={question.id} question={question} runId={run.id} lang={lang} />
            ))}
          </ol>
        </section>
      )}

      {steering.length > 0 && (
        <section>
          <SectionHeading>
            <Phrase text={RESEARCH_COPY.progress.guidance} />
          </SectionHeading>
          <ul className="space-y-1.5">
            {steering.map((entry) => (
              <li key={`${entry.createdAt}:${entry.text}`} className="text-caption text-muted-foreground">
                <PhraseWithArgs spec={steeringLine(entry)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionHeading>
          <Phrase text={RESEARCH_COPY.progress.activity} />
        </SectionHeading>
        {lines.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.progress.nothingYet} />
          </p>
        ) : (
          <ol className="space-y-1" lang={lang}>
            {lines.map((line, i) => (
              <li
                key={line.key}
                className={cn(
                  "run-step flex items-baseline gap-2 text-caption",
                  line.tone === "warning" ? "text-warning-foreground" : "text-foreground/80",
                )}
                style={{ "--i": i } as React.CSSProperties}
                data-instant={initial.current?.has(line.key) ? "" : undefined}
              >
                <time
                  dateTime={line.at}
                  className="w-12 shrink-0 font-mono tabular-nums text-muted-foreground"
                  data-no-auto-translate
                >
                  {formatClock(new Date(line.at), locale)}
                </time>
                <PhraseWithArgs spec={line.line} className="min-w-0 flex-1" />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <SectionHeading>
          <Phrase text={RESEARCH_COPY.progress.foundSoFar} />
        </SectionHeading>
        {findings.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            <Phrase text={RESEARCH_COPY.progress.noFindings} />
          </p>
        ) : (
          <ul className="space-y-4" lang={lang}>
            {findings.map((finding) => (
              <li key={finding.id} className="run-step space-y-1.5">
                <p className="text-body text-foreground">{finding.claim}</p>
                <blockquote className="border-s-2 border-border ps-3 text-caption italic text-muted-foreground">{finding.quote}</blockquote>
                <a
                  href={finding.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-card px-2 py-0.5 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <SourceFavicon url={finding.url} variant="inline" />
                  <bdi translate="no" className="truncate">
                    {finding.title}
                  </bdi>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
