"use client";

import * as React from "react";

import type { PanelFocus } from "@/components/chat/run/run-block";
import { ReceiptLine, ToolStepRow } from "@/components/chat/run/step-row";
import { PanelRightOpen } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { StatusIcons } from "@/lib/app-icons";
import { useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs, phraseText } from "@/lib/i18n-phrase";
import { MUST_ACT_NOTICES, noticeLine, RUN_COPY } from "@/lib/run/presentation";
import { headlineOf } from "@/lib/run/timeline";
import type { RunItem, RunView } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The whole run, in order, one click below the line (SPEC §7.8): reasoning as
 * readable prose, commentary as a muted quote, every tool row with its figure,
 * duration and approval receipt, and the notices. It is the same list live
 * and at rest; a row that arrives while it is open enters once
 * (`.run-step`'s `@starting-style`), and nothing re-keys on a status change.
 *
 * A tool row opens the Activity panel on that call; the header's panel button
 * opens it at the top. Provider text (reasoning, commentary) is verbatim and
 * never translated; every phrase around it is.
 */

/** Past this, a reasoning item is clamped to six lines behind "Show more". */
const CLAMP_CHARS = 480;
const CLAMP_LINES = 6;

function ReasoningItem({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const headline = headlineOf(text);
  // The headline is the bold first line; the prose is everything after it.
  const body = headline ? text.trimStart().split("\n").slice(1).join("\n").trim() : text;
  const long = body.length > CLAMP_CHARS || body.split("\n").length > CLAMP_LINES;
  return (
    <div className="min-w-0">
      {headline ? (
        <p lang="" translate="no" data-no-auto-translate className="text-ui font-medium text-foreground/90">
          {headline}
        </p>
      ) : null}
      {body ? (
        <p
          lang=""
          translate="no"
          data-no-auto-translate
          className={cn("whitespace-pre-wrap break-words text-body text-muted-foreground", long && !open && "line-clamp-6")}
        >
          {body}
        </p>
      ) : null}
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-caption font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <Phrase text={open ? RUN_COPY.showLess : RUN_COPY.showMore} />
        </button>
      ) : null}
    </div>
  );
}

function NoticeItem({ item }: { item: Extract<RunItem, { kind: "notice" }> }) {
  const line = item.notice ? noticeLine(item.notice) : null;
  // Warning ink for what the reader must act on (and legacy warning rows); an informational notice is muted.
  const mustAct = !item.notice || MUST_ACT_NOTICES.has(item.notice.code);
  const Icon = mustAct ? StatusIcons.warning : StatusIcons.info;
  return (
    <p className={cn("flex min-w-0 items-start gap-2 text-caption", mustAct ? "text-warning-foreground" : "text-muted-foreground")}>
      <Icon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      {line ? (
        <PhraseWithArgs spec={line} className="min-w-0" />
      ) : (
        // A notice this build cannot type (a legacy row, or a newer code): its English line, verbatim.
        <span lang="en" className="min-w-0">
          {item.legacyTitle}
          {item.legacyDetail ? ` · ${item.legacyDetail}` : ""}
        </span>
      )}
    </p>
  );
}

export function RunTimelineInline({
  id,
  view,
  onOpenPanel,
  className,
}: {
  id: string;
  view: RunView;
  onOpenPanel(focus?: PanelFocus): void;
  className?: string;
}) {
  const locale = useUiLocale();
  // Rows present at first render appear together; later ones stagger in as they arrive.
  const [initial] = React.useState(() => new Set(view.items.map((item) => item.key)));
  let arrivals = 0;
  const openLabel = phraseText({ parts: [{ phrase: RUN_COPY.openInPanel }] }, locale);

  return (
    <div id={id} className={cn("relative mt-1 border-s border-border/60 ps-4", className)}>
      <div className="absolute end-0 top-0">
        <Pressable
          kind="icon"
          size="sm"
          onClick={() => onOpenPanel()}
          aria-label={openLabel}
          title={openLabel}
          data-no-auto-translate
        >
          <PanelRightOpen aria-hidden="true" className="size-3.5" />
        </Pressable>
      </div>
      <ol className="space-y-2 pe-8 pt-1">
        {view.items.map((item) => {
          const fresh = !initial.has(item.key);
          const index = fresh ? arrivals++ : 0;
          return (
            <li
              key={item.key}
              className="run-step min-w-0"
              data-instant={fresh ? undefined : ""}
              style={{ "--i": index } as React.CSSProperties}
            >
              {item.kind === "reasoning" ? (
                <ReasoningItem text={item.text} />
              ) : item.kind === "commentary" ? (
                <blockquote lang="" translate="no" data-no-auto-translate className="border-s-2 border-border ps-3 text-body italic text-muted-foreground">
                  {item.text}
                </blockquote>
              ) : item.kind === "tool" ? (
                <div className="min-w-0">
                  <Pressable kind="row" size="sm" onClick={() => onOpenPanel({ callId: item.call.callId })} className="-mx-2 w-[calc(100%+1rem)]">
                    <ToolStepRow item={item} variant="timeline" className="min-w-0 flex-1" />
                  </Pressable>
                  {item.call.approval ? <ReceiptLine approval={item.call.approval} className="block ps-5" /> : null}
                </div>
              ) : (
                <NoticeItem item={item} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
