"use client";

import * as React from "react";
import { SourceFavicon } from "@/components/chat/source-chip";
import type { SourceRowView } from "@/components/research/research-view";

/*
 * The report's own sources list (§9.12): one row per source, numbered in
 * citation order when `numbered`.
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
