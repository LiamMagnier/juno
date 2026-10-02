"use client";

import * as React from "react";
import { RESEARCH_COPY } from "@/components/research/copy";
import type { ResearchRunView } from "@/components/research/use-research-run";
import { formatCurrencyEur, useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import type { PhraseLine } from "@/lib/run/types";

/*
 * The Details tab (SPEC §9.11.4, §8.3.3): who wrote the report, the team it
 * ran with, the pages it read, how long it worked, and what it spent — the
 * one place in Research where money shows, in the plan's currency (EUR, in
 * the reader's locale; DECISIONS §4b). Spend is omitted rather than guessed
 * when the caller did not pass the EUR rate.
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-caption text-muted-foreground">
        <Phrase text={label} />
      </dt>
      <dd className="min-w-0 text-end text-caption text-foreground" data-no-auto-translate>
        {children}
      </dd>
    </div>
  );
}

export function ResearchDetails({ run, eurPerUsd }: { run: ResearchRunView; eurPerUsd?: number }) {
  const locale = useUiLocale();
  const team: PhraseLine | null = run.sizing
    ? [
        { parts: [{ kind: "count", n: run.sizing.workers, one: RESEARCH_COPY.count.researcher, other: RESEARCH_COPY.count.researchers }] },
        { parts: [{ kind: "count", n: run.sizing.rounds, one: RESEARCH_COPY.count.round, other: RESEARCH_COPY.count.rounds }] },
      ]
    : null;
  const pages = run.counts?.pages ?? run.counts?.read ?? run.sources.filter((s) => s.read).length;
  const spend = run.spend?.microUsd ?? run.costMicroUsd;
  const ceiling = run.spend ? run.spend.ceilingMicroUsd : run.budgetMicroUsd;
  const money = (micro: string) => {
    const value = Number(micro);
    return eurPerUsd === undefined || !Number.isFinite(value) ? null : formatCurrencyEur(value, eurPerUsd, locale);
  };

  return (
    <dl className="divide-y divide-border/50">
      {run.leadModel && (
        <Row label={RESEARCH_COPY.details.leadModel}>
          <bdi translate="no">{run.leadModel.label}</bdi>
        </Row>
      )}
      {team && (
        <Row label={RESEARCH_COPY.details.team}>
          <PhraseWithArgs spec={team} />
        </Row>
      )}
      <Row label={RESEARCH_COPY.details.pagesRead}>
        <PhraseWithArgs spec={{ parts: [{ kind: "number", value: pages }] }} />
      </Row>
      {typeof run.workingMs === "number" && (
        <Row label={RESEARCH_COPY.details.workingTime}>
          <PhraseWithArgs spec={{ parts: [{ kind: "duration", ms: run.workingMs, style: "long" }] }} />
        </Row>
      )}
      {money(spend) && <Row label={RESEARCH_COPY.details.spend}>{money(spend)}</Row>}
      {ceiling && money(ceiling) && <Row label={RESEARCH_COPY.details.ceiling}>{money(ceiling)}</Row>}
    </dl>
  );
}
