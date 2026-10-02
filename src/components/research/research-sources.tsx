"use client";

import * as React from "react";
import { SourceFavicon } from "@/components/chat/source-chip";
import { RESEARCH_COPY } from "@/components/research/copy";
import type { SourceRowView, SourceSections } from "@/components/research/research-view";
import { Phrase } from "@/lib/i18n-phrase";

/*
 * The Sources tab (SPEC §9.11.4) and the report's own sources list (§9.12):
 * "Cited" (after the report, numbered in citation order), "Read" (opened, not
 * cited) and "Found" (searched, never opened), each with its count in the
 * heading. One count vocabulary everywhere (bug 11). The empty state is in
 * the right tense: "No sources yet" while the run works, "No sources were
 * read" once it is over (bug 21).
 */

export function SourceRows({ rows, numbered = false }: { rows: readonly SourceRowView[]; numbered?: boolean }) {
  return (
    <ol className="flex flex-col">
      {rows.map((row) => (
        <li key={row.key}>
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2 rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
          >
            {numbered && (
              <span className="w-5 shrink-0 pt-px text-right font-mono text-caption tabular-nums text-muted-foreground">{row.cited}</span>
            )}
            <SourceFavicon url={row.url} variant="list" className="mt-px" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-caption font-medium text-foreground/90">{row.title}</span>
              <bdi translate="no" className="block truncate text-caption text-muted-foreground">
                {row.domain}
              </bdi>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}

function Group({ label, rows, numbered }: { label: string; rows: readonly SourceRowView[]; numbered?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="flex items-baseline gap-2 px-2 text-ui font-medium text-foreground">
        <Phrase text={label} />
        <span className="font-mono text-caption tabular-nums text-muted-foreground" data-no-auto-translate>
          {rows.length}
        </span>
      </h3>
      <SourceRows rows={rows} numbered={numbered} />
    </section>
  );
}

export function ResearchSources({ sections, live }: { sections: SourceSections; live: boolean }) {
  const empty = sections.cited.length + sections.read.length + sections.found.length === 0;
  if (empty) {
    return (
      <p className="text-caption text-muted-foreground">
        <Phrase text={live ? RESEARCH_COPY.sources.noneYet : RESEARCH_COPY.sources.noneRead} />
      </p>
    );
  }
  return (
    <div className="space-y-5">
      <Group label={RESEARCH_COPY.sources.cited} rows={sections.cited} numbered />
      <Group label={RESEARCH_COPY.sources.read} rows={sections.read} />
      <Group label={RESEARCH_COPY.sources.found} rows={sections.found} />
    </div>
  );
}
