"use client";

import * as React from "react";
import { StatusIcons } from "@/lib/app-icons";
import { hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ResearchRunView } from "@/components/research/use-research-run";

/**
 * What the run has actually established, per objective — and what it hasn't.
 *
 * REPLACES `SourceGraph`, which was the single loudest thing wrong with this
 * surface. That component sized each source node by `composite` and explained
 * itself in a three-line legend ("Circle area is the source's overall score ·
 * Dashed: never scored · Solid: read · Hollow: found, not read"). Its own header
 * comment was right that a graph whose geometry means nothing is worse than no
 * graph — and then shipped exactly that, because `composite` is null on every
 * source a chat-started run gathers, so all eighteen circles rendered at the
 * same floor radius. Eighteen identical dots in two rows, under a legend
 * describing an encoding none of them were using: decoration pretending to be a
 * measurement, occupying the most vertical space on the panel.
 *
 * The honest picture of the same matrix is a BAR PER OBJECTIVE, because the
 * quantity the run really persists per objective is `evidenceStrength` plus a
 * count of independent sources — and unlike a node radius, a bar that is absent
 * says "nothing yet" rather than "measured as poor".
 *
 * Three rules, all learned from what the graph got wrong:
 *
 *  1. NULL IS NOT ZERO. An objective with no coverage row draws no bar at all
 *     and says so in words. It never draws an empty bar, which reads as a
 *     measurement of nothing rather than the absence of a measurement.
 *  2. NOTHING IS COLOUR-ONLY. Covered/open is a word and an icon before it is a
 *     hue, so the ramp is reinforcement rather than the channel.
 *  3. WEAKER IS NOT WORSE. The source mix bar orders provenance strongest-first
 *     and paints the whole ladder in one neutral family. Painting a
 *     user-generated source amber says it is a PROBLEM when it is merely a
 *     weaker kind of witness — the same argument that made the graph use bands
 *     rather than hue, kept here.
 *
 * Conflicts sit at the bottom with the objectives rather than in an error slot,
 * for the reason the old panel gave and which still holds: two copies of one
 * wire story is a fact about the evidence, and hiding it is what makes three
 * sources look like three witnesses.
 */

/**
 * Phrases composed with counts at runtime. Template literals are invisible to
 * scripts/generate-i18n-catalog.mjs, so the fixed halves live in a const whose
 * name ends in `COPY` — the same convention as GRAPH_COPY and TIMELINE_COPY.
 */
const EVIDENCE_COPY = {
  objectives: "Objectives",
  covered: "covered",
  of: "of",
  sources: "sources",
  oneSource: "source",
  independent: "independent",
  noEvidence: "no source answers this yet",
  sourceMix: "Where the evidence comes from",
  unclassified: "not yet classified",
  conflicts: "Sources disagree",
  between: "between",
  severity: "severity",
} as const;

/**
 * Provenance, strongest first — the same ladder the old graph's bands used,
 * said in the words a bar-segment legend needs rather than an inspector's.
 *
 * `null` and `"unknown"` collapse into one trailing segment HERE and only here:
 * on a 6px-tall stacked bar the difference between "the classifier declined to
 * place it" and "nobody ever looked" cannot be drawn, and inventing two
 * indistinguishable segments to honour a distinction the geometry cannot carry
 * is how the graph got into trouble. The distinction survives where it can be
 * read — the source deck labels each row individually.
 */
const PROVENANCE: ReadonlyArray<{ type: string; label: string; fill: string }> = [
  { type: "official", label: "Official", fill: "bg-primary" },
  { type: "primary", label: "Primary", fill: "bg-primary/70" },
  { type: "reputable_secondary", label: "Established publication", fill: "bg-primary/45" },
  { type: "general", label: "General web", fill: "bg-primary/25" },
  { type: "user_generated", label: "User-generated", fill: "bg-muted-foreground/30" },
];

type Coverage = NonNullable<ResearchRunView["plan"]["coverage"]>;
type Objective = NonNullable<ResearchRunView["plan"]["objectives"]>[number];
type Conflict = NonNullable<ResearchRunView["plan"]["conflicts"]>[number];

/** One objective's rolled-up evidence, or null when the run has measured none. */
function objectiveEvidence(objectiveId: string, coverage: Coverage) {
  const rows = coverage.filter((entry) => entry.objectiveId === objectiveId);
  if (rows.length === 0) return null;
  const supporting = new Set(rows.flatMap((row) => row.supportingSourceIds));
  // The strongest requirement carries the objective: an objective is answered as
  // well as its best-evidenced requirement, and averaging in a requirement that
  // was never going to be met (the `missingReason` case) understates work that
  // did land.
  const strength = Math.max(...rows.map((row) => row.evidenceStrength ?? 0));
  const independent = Math.max(...rows.map((row) => row.independentSourceCount ?? 0));
  return {
    strength: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0,
    supporting: supporting.size,
    independent,
    missing: rows.find((row) => row.missingReason)?.missingReason ?? null,
    satisfied: rows.filter((row) => row.status === "satisfied").length,
    total: rows.length,
  };
}

export function EvidencePanel({
  objectives,
  coverage,
  conflicts,
  sources,
  className,
}: {
  objectives: Objective[];
  coverage: Coverage;
  conflicts: Conflict[];
  sources: ResearchRunView["sources"];
  className?: string;
}) {
  const covered = objectives.filter((objective) => objective.status === "covered").length;

  // The mix is over sources the report could actually cite. A source that was
  // found and never fetched is a lead, and counting leads in a provenance bar
  // is the same overstatement the read/unread dot exists to prevent.
  const readable = sources.filter((source) => source.read);
  const mix = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of readable) {
      const key = PROVENANCE.some((rung) => rung.type === source.sourceType)
        ? (source.sourceType as string)
        : "unclassified";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const ordered = PROVENANCE.filter((rung) => counts.has(rung.type)).map((rung) => ({
      ...rung,
      count: counts.get(rung.type) as number,
    }));
    const unclassified = counts.get("unclassified") ?? 0;
    return { ordered, unclassified, total: readable.length };
  }, [readable]);

  if (objectives.length === 0 && mix.total === 0 && conflicts.length === 0) return null;

  return (
    <div className={cn("space-y-4", className)}>
      {objectives.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-ui font-medium text-foreground">{EVIDENCE_COPY.objectives}</h4>
            <p className="shrink-0 text-caption tabular-nums text-muted-foreground">
              {covered} {EVIDENCE_COPY.of} {objectives.length} {EVIDENCE_COPY.covered}
            </p>
          </div>

          <ul className="mt-2.5 space-y-3">
            {objectives.map((objective) => {
              const evidence = objectiveEvidence(objective.id, coverage);
              const done = objective.status === "covered";
              return (
                <li key={objective.id} className="min-w-0">
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                        done ? "bg-success/15 text-success-ink" : "border border-border/70 text-muted-foreground"
                      )}
                    >
                      {done ? <StatusIcons.success className="size-2.5" /> : null}
                    </span>
                    <p className="min-w-0 flex-1 text-ui leading-snug text-foreground/85">{objective.question}</p>
                  </div>

                  <div className="mt-1.5 pl-6">
                    {evidence ? (
                      <>
                        {/* The bar is drawn only where a measurement exists.
                            An objective the coverage pass has never scored
                            falls to the sentence below instead — see rule 1. */}
                        <div className="h-1 overflow-hidden rounded-full bg-border/60">
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-slow ease-out-soft motion-reduce:transition-none",
                              done ? "bg-success" : "bg-warning"
                            )}
                            style={{ width: `${Math.max(4, evidence.strength * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 truncate text-caption text-muted-foreground">
                          {evidence.supporting}{" "}
                          {evidence.supporting === 1 ? EVIDENCE_COPY.oneSource : EVIDENCE_COPY.sources}
                          {evidence.independent > 0 ? ` · ${evidence.independent} ${EVIDENCE_COPY.independent}` : ""}
                          {evidence.missing ? ` · ${evidence.missing}` : ""}
                        </p>
                      </>
                    ) : (
                      <p className="text-caption text-muted-foreground">{EVIDENCE_COPY.noEvidence}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {mix.total > 0 && (
        <section>
          <h4 className="text-ui font-medium text-foreground">{EVIDENCE_COPY.sourceMix}</h4>
          <div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
            {mix.ordered.map((rung) => (
              <span
                key={rung.type}
                title={`${rung.label} · ${rung.count}`}
                className={cn("h-full first:rounded-l-full last:rounded-r-full", rung.fill)}
                style={{ width: `${(rung.count / mix.total) * 100}%` }}
              />
            ))}
            {mix.unclassified > 0 && (
              <span
                title={EVIDENCE_COPY.unclassified}
                className="h-full rounded-r-full bg-border"
                style={{ width: `${(mix.unclassified / mix.total) * 100}%` }}
              />
            )}
          </div>
          {/* The legend is the data, not an explanation of the drawing. The
              graph's three lines of instructions on how to read a picture were
              the tell that the picture could not be read. */}
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {mix.ordered.map((rung) => (
              <li key={rung.type} className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <span aria-hidden className={cn("size-1.5 rounded-full", rung.fill)} />
                {rung.label}
                <span className="tabular-nums text-foreground/70">{rung.count}</span>
              </li>
            ))}
            {mix.unclassified > 0 && (
              <li className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-border" />
                {EVIDENCE_COPY.unclassified}
                <span className="tabular-nums text-foreground/70">{mix.unclassified}</span>
              </li>
            )}
          </ul>
        </section>
      )}

      {conflicts.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 text-ui font-medium text-warning-foreground">
            <StatusIcons.warning aria-hidden className="size-3.5" />
            {EVIDENCE_COPY.conflicts}
          </h4>
          <ul className="mt-2 space-y-2">
            {conflicts.slice(0, 4).map((conflict) => {
              const hosts = [
                ...new Set(
                  conflict.sourceIds
                    .map((id) => sources.find((source) => source.id === id))
                    .filter((source): source is ResearchRunView["sources"][number] => !!source)
                    .map((source) => hostOf(source.url))
                ),
              ];
              return (
                <li key={conflict.id} className="min-w-0 rounded-field border border-warning/25 bg-warning/[0.06] p-2.5">
                  <p className="text-ui leading-snug text-foreground/85">{conflict.description}</p>
                  <p className="mt-1 truncate text-caption text-muted-foreground">
                    {conflict.severity} {EVIDENCE_COPY.severity}
                    {hosts.length > 0 ? ` · ${EVIDENCE_COPY.between} ${hosts.join(", ")}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
