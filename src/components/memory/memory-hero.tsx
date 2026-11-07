"use client";

import * as React from "react";
import { RollingNumber } from "@/components/ui/micro";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { ConstellationTopic } from "@/components/memory/memory-constellation";
import { relativeTime } from "@/components/memory/memory-time";

/**
 * The top of Memory: what this page is and three figures. (The dot-matrix
 * constellation beside them was retired on 7 Nov 2026 as decoration; the
 * topics are listed in full below.)
 * The figures are the three questions a reader arrives with: how much does it
 * know, about how many things, and is it still learning.
 */
export function MemoryHero({
  actions,
  count,
  topics,
  lastLearned,
  scopes,
}: {
  previews?: Record<string, string[]>;
  actions: React.ReactNode;
  count: number;
  topics: ConstellationTopic[];
  /** When the newest memory was learned, or null when there is none. */
  lastLearned: string | null;
  liveTopicId: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** The scope chips, under the figures. */
  scopes?: React.ReactNode;
}) {
  const hasData = topics.length > 0;
  return (
    <section aria-labelledby="memory-title" className="relative">
      <div className="relative">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-4">
            <h1 id="memory-title" className="mem-display mem-rise text-foreground" style={{ ["--i" as string]: 0 }}>
              Memory
            </h1>
            <div className="mem-rise pt-2" style={{ ["--i" as string]: 1 }}>
              {actions}
            </div>
          </div>
          <p
            className="mem-rise mt-4 max-w-[30rem] text-pretty text-body-lg text-muted-foreground"
            style={{ ["--i" as string]: 1 }}
          >
            {`What ${PRODUCT_NAME} carries from one chat to the next. Everything here is yours to read, correct or forget.`}
          </p>

          {hasData && (
            <dl className="mem-rise mt-9 grid max-w-[30rem] grid-cols-3" style={{ ["--i" as string]: 2 }}>
              <Figure label="Memories">
                <RollingNumber value={count} />
              </Figure>
              <Figure label="Topics">
                <RollingNumber value={topics.length} />
              </Figure>
              <Figure label="Last learned">
                <span className="mem-figure-sm">{lastLearned ? relativeTime(lastLearned) : "Not yet"}</span>
              </Figure>
            </dl>
          )}

          {scopes && (
            <div className="mem-rise mt-8" style={{ ["--i" as string]: 3 }}>
              {scopes}
            </div>
          )}
        </div>

      </div>
    </section>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-2 border-l border-[var(--mem-line)] pl-4 first:border-l-0 first:pl-0">
      <dt className="mem-annot">{label}</dt>
      <dd className="mem-figure truncate text-foreground">{children}</dd>
    </div>
  );
}
