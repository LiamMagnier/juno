"use client";

import * as React from "react";
import { SourceFavicon, isRenderableSourceUrl } from "@/components/chat/source-chip";
import type { SourceRowView } from "@/components/research/research-view";
import { isPrivateSourceUrl } from "@/lib/research/private-sources";

/*
 * The report's own sources list (§9.12): one row per source, numbered in
 * citation order when `numbered`. The person's own sources (files, mail,
 * calendar…) draw their kind's glyph and "Your …" where a domain would be,
 * and are not links: they have no address anyone could open.
 */

const ROW = "flex items-start gap-2 rounded-control px-2 py-1.5";

export function SourceRows({ rows, numbered = false }: { rows: readonly SourceRowView[]; numbered?: boolean }) {
  return (
    <ol className="flex flex-col">
      {rows.map((row) => {
        const own = isPrivateSourceUrl(row.url);
        const body = (
          <>
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
          </>
        );
        return (
          <li key={row.key} data-private-source={own || undefined}>
            {isRenderableSourceUrl(row.url) ? (
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`${ROW} transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none`}
              >
                {body}
              </a>
            ) : (
              <div className={ROW} title={row.title}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
