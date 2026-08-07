"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Paperclip } from "lucide-react";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { WorkToolbox } from "@/components/work/work-toolbox";

/**
 * What this task can reach, at the composer, while the task is under way.
 *
 * The [+] menu the thread composer opens. It is the same `WorkToolbox` the rail
 * renders under "Context" rather than a second list assembled here: a parallel
 * answer to "is Gmail linked" is a parallel answer that disagrees with the first
 * one the day somebody unlinks it, and the toolbox already reads the endpoints
 * that own both halves. What this adds is reachability — the rail is below a
 * transcript that can run to many screens, and the question "can it even see my
 * calendar" is asked while typing, not while scrolling.
 *
 * ── Why there is no "attach a file" button here ────────────────────────────
 *
 * A run is handed its attachments by `attachedSources` in scripts/work-runner.ts,
 * which reads the `WorkRunIO` manifest written at dispatch from the session's
 * file grants. Those grants are written once, by `POST /api/work/sessions`, and
 * no route edits them afterwards — `POST /sessions` refuses to re-grant on a
 * replay on purpose, so that a retry cannot rewrite the grants of a session
 * somebody is already running. There is therefore no request this component
 * could make that would put a new file in front of a run, and the same is true
 * of a skill (`applySkill` parses its invocation out of `WorkSession.goal`,
 * which is immutable) and of a connector (`connectorIds` is set at creation and
 * `evaluateConnector` refuses anything outside it).
 *
 * So the row below is a link and not a button. A [+] that opened a file picker,
 * uploaded the file and then dropped it would be the worst of the three
 * available behaviours: the reader would watch a progress bar complete and then
 * get an agent that had never seen the document. Saying where files are actually
 * attached, and going there in one click, is the honest version of the same
 * affordance.
 */
export function WorkThreadReach({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex max-h-[min(26rem,65vh)] flex-col">
      <ScrollFade className="min-h-0 flex-1" viewportClassName="space-y-4 p-3">
        <div>
          <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Files</p>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            A task is handed its files when it starts, so there is nothing here to add one to.
            To work from a new document, start a task with it attached.
          </p>
          <Link
            href="/work"
            onClick={onNavigate}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1.5 font-mono text-[11px] text-foreground/80 transition-colors duration-base ease-out-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            Start a task with a file
            <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </div>

        <div className="border-t border-border/60 pt-4">
          <WorkToolbox />
        </div>
      </ScrollFade>
    </div>
  );
}
