"use client";

import * as React from "react";

import { SourceFavicon } from "@/components/chat/source-chip";
import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { Phrase } from "@/lib/i18n-phrase";
import type { SourceRow, SourcesSplit } from "@/lib/panel/sources-split";
import { cn } from "@/lib/utils";

import { PANEL_COPY } from "./copy";

/*
 * The Sources tab (SPEC §8.3.2): what the answer CITED, what the run read
 * without citing, and — only when there is neither — what a search merely
 * found. The split itself is `splitSources`, pure and tested; this only lists
 * it.
 *
 * Each row is a favicon from the page's own origin (never a favicon proxy, see
 * source-chip.tsx), the title on one line and the domain, and opens the page in
 * a new tab. Titles and domains are third-party text: verbatim, `translate="no"`,
 * bidi-isolated. No origin chip in this rework: `origin` only orders rows.
 */

/** Total rows the tab lists, for the tab's count and whether it is shown at all. */
export function sourcesCount(split: SourcesSplit): number {
  return split.cited.length + split.alsoRead.length + split.found.length;
}

function SourceLink({ row, instant }: { row: SourceRow; instant: boolean }) {
  const locale = useUiLocale();
  return (
    <li className="run-step" data-instant={instant ? "" : undefined}>
      <a
        href={row.url}
        target="_blank"
        rel="noopener noreferrer"
        className="-mx-1.5 flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
      >
        <SourceFavicon url={row.url} variant="cluster" className="size-4" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui text-foreground" translate="no" lang="" dir="auto" data-no-auto-translate>
            {row.title}
          </span>
          <bdi className="truncate text-caption text-muted-foreground" translate="no" lang="" data-no-auto-translate>
            {row.domain}
          </bdi>
        </span>
        {row.citedAs.length > 0 && (
          <span className="flex shrink-0 gap-1" data-no-auto-translate>
            <span className="sr-only">
              <Phrase text={PANEL_COPY.sources.citedAs} />
            </span>
            {row.citedAs.map((n) => (
              <span
                key={n}
                className="grid h-5 min-w-5 place-items-center rounded-full bg-secondary px-1.5 font-mono text-micro tabular-nums text-muted-foreground"
              >
                {formatNumber(n, locale)}
              </span>
            ))}
          </span>
        )}
        <span className="sr-only">
          <Phrase text={PANEL_COPY.call.opensInNewTab} />
        </span>
      </a>
    </li>
  );
}

function Group({
  heading,
  rows,
  quiet,
  instantKeys,
}: {
  heading: string;
  rows: SourceRow[];
  quiet?: boolean;
  instantKeys: ReadonlySet<string>;
}) {
  const locale = useUiLocale();
  const id = React.useId();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h3 id={id} className={cn("flex items-baseline gap-1.5 text-caption font-medium", quiet ? "text-muted-foreground/80" : "text-muted-foreground")}>
        <Phrase text={heading} />
        <span className="tabular-nums" data-no-auto-translate>
          {formatNumber(rows.length, locale)}
        </span>
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <SourceLink key={row.url} row={row} instant={instantKeys.has(row.url)} />
        ))}
      </ul>
    </section>
  );
}

export function ActivitySourcesTab({ split }: { split: SourcesSplit }) {
  const [instantKeys] = React.useState<ReadonlySet<string>>(
    () => new Set([...split.cited, ...split.alsoRead, ...split.found].map((row) => row.url))
  );
  if (sourcesCount(split) === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-ui text-muted-foreground">
          <Phrase text={PANEL_COPY.sources.empty} />
        </p>
        <p className="mt-1 text-caption text-muted-foreground">
          <Phrase text={PANEL_COPY.sources.emptyDetail} />
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Group heading={PANEL_COPY.sources.cited} rows={split.cited} instantKeys={instantKeys} />
      <Group heading={PANEL_COPY.sources.alsoRead} rows={split.alsoRead} instantKeys={instantKeys} />
      <Group heading={PANEL_COPY.sources.found} rows={split.found} quiet instantKeys={instantKeys} />
    </div>
  );
}
