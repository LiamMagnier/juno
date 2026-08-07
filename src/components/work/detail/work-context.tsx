"use client";

import * as React from "react";
import { ExternalLink, FileText, Link2 } from "lucide-react";
import { RailHeading, RailSection } from "@/components/work/detail/work-rail";
import type { WorkReference } from "@/components/work/work-detail-panels";
import { WorkToolbox } from "@/components/work/work-toolbox";

/*
 * What this task could see and reach.
 *
 * Three panels used to answer half of this question each and none of them said
 * so. "Files and sources" listed what the run had read; "Skills and apps" listed
 * what it was allowed to apply and connect to; the connectors inside that second
 * list were the ceiling on the first. A reader wanting to know why a task missed
 * something obvious — the file was never given to it, the app was never linked —
 * had to assemble that from two headings that never mentioned each other.
 *
 * One section, one explainer line, two halves: what it looked at, and what it
 * could have looked at.
 *
 * The written half of the reference list is NOT here. A file the run changed is
 * something it produced, not something it could see, and it lives under Outputs
 * with the documents. `WorkReference` has carried the `direction` that makes
 * that split possible since it was written; this is the first surface to use it.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 *
 * There is no control here for adding a file or an app to a running task, and
 * that is not an oversight. What a task may reach is resolved at dispatch and
 * enforced by the executor; a button on this page would look like permission
 * while the run it belongs to has already started and decided. `work-toolbox.tsx`
 * makes the same argument at more length and is the place it belongs.
 */

export function WorkContextSection({
  read,
  defaultOpen,
}: {
  /** The `read` half of the reference list — pages cited, records opened. */
  read: readonly WorkReference[];
  defaultOpen: boolean;
}) {
  return (
    <RailSection name="context" title="Context" defaultOpen={defaultOpen}>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        What this task could see and reach — the pages it read, and the skills and apps it was
        given.
      </p>

      {/* Omitted rather than explained when the run has cited nothing. A heading
          over "nothing has been read yet" is the sentence this rail was rebuilt
          to stop printing. */}
      {read.length > 0 && (
        <div>
          <RailHeading>Read</RailHeading>
          <ul className="space-y-1">
            {read.map((reference) => (
              <SourceCard key={reference.id} reference={reference} />
            ))}
          </ul>
        </div>
      )}

      <WorkToolbox />
    </RailSection>
  );
}

/**
 * One thing the run looked at.
 *
 * A citation is only checkable if you can reach it, so a source that parses as
 * an http(s) URL is a link and everything else is a name. `deriveReferences`
 * already made that judgement — a citation can name a connector record or a
 * granted folder just as easily as a page, and an anchor whose href is
 * `gmail:18f2c…` is a promise the browser cannot keep — so this only has to
 * render the two cases it was handed.
 */
function SourceCard({ reference }: { reference: WorkReference }) {
  const linked = reference.url !== null;
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-card/40 px-2.5 py-2">
      <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        {linked ? (
          <Link2 className="h-3.5 w-3.5 text-source" />
        ) : (
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        {reference.url !== null ? (
          <a
            href={reference.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded text-[13px] leading-snug text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate">{reference.label}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        ) : (
          <span className="block truncate text-[13px] leading-snug text-foreground">
            {reference.label}
          </span>
        )}
        {reference.detail !== null && (
          // The passage actually relied on, where there is one. It is what makes
          // a citation checkable rather than decorative, so it is clamped to two
          // lines rather than truncated to one.
          <span className="mt-0.5 block overflow-hidden text-[11.5px] leading-relaxed text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {reference.detail}
          </span>
        )}
      </span>
    </li>
  );
}
