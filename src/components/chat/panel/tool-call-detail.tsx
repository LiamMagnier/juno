"use client";

import * as React from "react";

import { SourceFavicon } from "@/components/chat/source-chip";
import { Button } from "@/components/ui/button";
import {
  Clock,
  Code2,
  FileText,
  Globe,
  Image as ImageIcon,
  MessagesSquare,
  Plug,
  Search,
  Sigma,
  Telescope,
  Workflow,
  type IconComponent,
} from "@/components/ui/icons";
import type { ActionApprovalDecision, ClientActionApproval } from "@/lib/action-approval";
import { formatClock, useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs, phraseText } from "@/lib/i18n-phrase";
import { sourceDomain } from "@/lib/panel/sources-split";
import { TOOL_ARGS_NOTE, TOOL_RESULT_NOTE } from "@/lib/run-receipt";
import type { PhraseSpec, ToolPresentation } from "@/lib/run/types";
import type { ToolIconKind } from "@/lib/tools/types";
import { cn } from "@/lib/utils";

import { PANEL_COPY } from "./copy";
import {
  answeredPhrase,
  approvalChoices,
  sendApprovalDecision,
  type ApprovalControlState,
} from "./panel-approval";
import {
  approvalReceiptPhrase,
  argumentsOf,
  askToRunAgainSpec,
  canAskToRunAgain,
  clampLines,
  toolRowState,
  type ToolItem,
} from "./panel-model";

/*
 * One call, opened (SPEC §8.3.1): what the model asked for, what came back,
 * who approved it, and what went wrong — plus the compact approval control a
 * waiting row carries.
 *
 * Everything shown here is what the server recorded, verbatim: arguments are
 * the redacted head `tool-detail.ts` kept (or the tool's safe presentation
 * parameters), results are the envelope-stripped head, and an absent payload
 * is replaced by the sentence that says why (`TOOL_ARGS_NOTE`,
 * `TOOL_RESULT_NOTE`) rather than by an empty box. Third-party text — a
 * page's address, a connector's error line — is `translate="no"` and
 * bidi-isolated.
 */

/** One glyph per tool kind (`ToolPresentation.icon`). */
export const TOOL_KIND_ICONS: Readonly<Record<ToolIconKind, IconComponent>> = {
  search: Search,
  globe: Globe,
  document: FileText,
  image: ImageIcon,
  code: Code2,
  chats: MessagesSquare,
  clock: Clock,
  calculator: Sigma,
  task: Workflow,
  research: Telescope,
  connector: Plug,
};

const ARGS_LINES = 12;
const RESULT_LINES = 12;
const OUTPUT_LINES = 40;

function SectionHeading({ text }: { text: string }) {
  return (
    <h4 className="text-caption font-medium text-muted-foreground">
      <Phrase text={text} />
    </h4>
  );
}

/** A monospace block cut at `maxLines`, with "Show all". Verbatim, never translated. */
function ClampedBlock({ text, maxLines }: { text: string; maxLines: number }) {
  const [all, setAll] = React.useState(false);
  const { head, hidden } = React.useMemo(() => clampLines(text, maxLines), [text, maxLines]);
  return (
    <div>
      <pre
        translate="no"
        data-no-auto-translate
        className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-secondary px-2.5 py-2 font-mono text-caption text-foreground/85"
      >
        {all ? text : head}
      </pre>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
          className="mt-1 text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
        >
          <Phrase text={all ? PANEL_COPY.call.showLess : PANEL_COPY.call.showAll} />
        </button>
      )}
    </div>
  );
}

/** A small muted phrase (with its arguments) under a block. */
function Caption({ spec, className }: { spec: PhraseSpec | readonly PhraseSpec[]; className?: string }) {
  return <PhraseWithArgs spec={spec} className={cn("block text-caption text-muted-foreground", className)} />;
}

function ExternalRow({ url, title }: { url: string; title?: string }) {
  const domain = sourceDomain(url);
  if (!domain) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-ui transition-colors duration-fast ease-out-soft hover:bg-accent"
    >
      <SourceFavicon url={url} variant="cluster" className="size-4" />
      {title ? (
        <span className="min-w-0 flex-1 truncate text-foreground" translate="no" lang="" dir="auto" data-no-auto-translate>
          {title}
        </span>
      ) : null}
      <bdi translate="no" lang="" data-no-auto-translate className={cn("truncate text-muted-foreground", !title && "flex-1")}>
        {domain}
      </bdi>
      <span className="sr-only">
        <Phrase text={PANEL_COPY.call.opensInNewTab} />
      </span>
    </a>
  );
}

/** The web part of a result: search results, or the page a fetch opened. */
function WebResult({ item }: { item: ToolItem }) {
  const { call } = item;
  const web = call.web;
  if (!web) return null;
  if (call.tool === "web_search" || call.tool === "provider_web_search" || call.tool === "provider_x_search") {
    const results = web.results ?? [];
    if (results.length === 0) return call.status === "succeeded" ? <Caption spec={{ parts: [{ phrase: PANEL_COPY.call.noResults }] }} /> : null;
    return (
      <ul className="-mx-1.5 flex flex-col">
        {results.map((result, i) => (
          <li key={`${result.url}-${i}`}>
            <ExternalRow url={result.url} title={result.title} />
          </li>
        ))}
      </ul>
    );
  }
  if (call.tool === "web_fetch") {
    const address = web.finalUrl ?? web.requestedUrl;
    const line: PhraseSpec[] = [];
    if (web.chars != null) {
      line.push({ parts: [{ phrase: PANEL_COPY.call.shown }, { kind: "count", n: web.chars, ...PANEL_COPY.units.character }] });
    }
    if (web.totalChars != null && web.chars != null && web.totalChars > web.chars) {
      line.push({ parts: [{ phrase: PANEL_COPY.call.fullLength }, { kind: "count", n: web.totalChars, ...PANEL_COPY.units.character }] });
    }
    if (web.pages != null) line.push({ parts: [{ phrase: PANEL_COPY.call.pages }, { kind: "number", value: web.pages }] });
    return (
      <div className="flex flex-col gap-1">
        {address ? (
          <div className="-mx-1.5">
            <ExternalRow url={address} />
          </div>
        ) : null}
        {line.length > 0 && <Caption spec={line} />}
        {web.injection ? (
          <p className="text-caption text-warning-foreground">
            <Phrase text={PANEL_COPY.call.injection} />
          </p>
        ) : null}
      </div>
    );
  }
  return web.injection ? (
    <p className="text-caption text-warning-foreground">
      <Phrase text={PANEL_COPY.call.injection} />
    </p>
  ) : null;
}

/** The answered approval as one line: "Allowed once · 14:02". */
export function ApprovalReceipt({ item }: { item: ToolItem }) {
  const locale = useUiLocale();
  const approval = item.call.approval;
  if (!approval || approval.status === "pending") return null;
  const receipt = approvalReceiptPhrase(approval);
  if (!receipt) return null;
  const decidedAt = approval.decidedAt ? new Date(approval.decidedAt) : null;
  const time = decidedAt && !Number.isNaN(decidedAt.getTime()) ? formatClock(decidedAt, locale) : "";
  return (
    <p className="text-caption text-muted-foreground">
      <Phrase text={receipt} />
      {time ? (
        <>
          <span aria-hidden="true"> · </span>
          <time dateTime={approval.decidedAt ?? undefined} data-no-auto-translate>
            {time}
          </time>
        </>
      ) : null}
    </p>
  );
}

/**
 * The decision a waiting call needs, in the row itself (SPEC §8.3.1): Allow
 * once, Always allow (only when the card would offer it) and Decline, posted
 * to the same endpoint with the same digest as the transcript's card.
 */
export function ApprovalControl({
  approval,
  item,
  presentation,
  fetchImpl,
}: {
  approval: ClientActionApproval;
  item: ToolItem;
  presentation: ToolPresentation;
  fetchImpl: typeof fetch;
}) {
  const locale = useUiLocale();
  const [state, setState] = React.useState<ApprovalControlState>({ kind: "idle" });
  const choices = approvalChoices(approval, state);
  const sending = state.kind === "sending";

  const decide = React.useCallback(
    async (decision: ActionApprovalDecision) => {
      setState({ kind: "sending", decision });
      setState(await sendApprovalDecision(approval, decision, fetchImpl));
    },
    [approval, fetchImpl]
  );

  if (state.kind === "answered") {
    return (
      <p role="status" className="text-caption text-muted-foreground">
        <Phrase text={answeredPhrase(state.decision)} />
      </p>
    );
  }
  const closed = state.kind === "refused" && !state.retry;
  // The group's name carries the call's own phrase, so a screen reader hears
  // WHICH call it is answering (U6). Composed text: built with phraseText and
  // set where AutoTranslate does not rewrite it (§10.1 rule 5).
  const groupName = phraseText([{ parts: [{ phrase: PANEL_COPY.approval.group }] }, ...presentation.running(item.call)], locale);

  return (
    <div role="group" aria-label={groupName} data-no-auto-translate className="flex flex-col gap-1.5">
      {!closed && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" disabled={sending} onClick={() => void decide("allow_once")}>
            <Phrase text={PANEL_COPY.approval.allowOnce} />
          </Button>
          {choices.alwaysAllow && (
            <Button size="sm" variant="outline" disabled={sending} onClick={() => void decide("allow_scope")}>
              <Phrase text={PANEL_COPY.approval.alwaysAllow} />
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => void decide("deny")}>
            <Phrase text={PANEL_COPY.approval.decline} />
          </Button>
        </div>
      )}
      <p role="status" className={cn("text-caption", state.kind === "refused" ? "text-warning-foreground" : "text-muted-foreground")}>
        {sending ? (
          <Phrase text={PANEL_COPY.approval.sending} />
        ) : state.kind === "refused" ? (
          <Phrase text={state.phrase} />
        ) : null}
      </p>
    </div>
  );
}

/** The opened row: arguments, result, approval, error, and "Ask to run again". */
export function ToolCallDetail({
  item,
  presentation,
  seedDraft,
}: {
  item: ToolItem;
  presentation: ToolPresentation;
  seedDraft?: (text: string) => void;
}) {
  const locale = useUiLocale();
  const { call, detail } = item;
  const state = toolRowState(call);
  const args = argumentsOf(call, detail);
  const figure = state === "succeeded" ? presentation.figure(call) : null;
  const connector = call.origin === "connector";
  const outputLines = call.tool === "run_code" ? OUTPUT_LINES : RESULT_LINES;
  const ended = state === "failed" || state === "declined" || state === "cancelled";
  const retry = seedDraft && canAskToRunAgain(call);

  return (
    <div className="flex flex-col gap-3 pb-1 pt-2">
      <section className="flex flex-col gap-1">
        <SectionHeading text={PANEL_COPY.call.arguments} />
        {args.text ? (
          <>
            <ClampedBlock text={args.text} maxLines={ARGS_LINES} />
            {args.truncated && <Caption spec={{ parts: [{ phrase: PANEL_COPY.call.shortened }] }} />}
          </>
        ) : args.noteKey ? (
          <p className="text-caption text-muted-foreground">
            <Phrase text={TOOL_ARGS_NOTE[args.noteKey]} />
          </p>
        ) : null}
      </section>

      {(call.web || figure || detail?.result || (connector && detail?.resultNote) || call.cached) && (
        <section className="flex flex-col gap-1">
          <SectionHeading text={call.tool === "run_code" ? PANEL_COPY.call.output : PANEL_COPY.call.result} />
          <WebResult item={item} />
          {figure && <Caption spec={figure} />}
          {detail?.result ? (
            <>
              <ClampedBlock text={detail.result} maxLines={outputLines} />
              {detail.resultTruncated && (
                <Caption
                  spec={
                    detail.resultChars != null
                      ? [
                          { parts: [{ phrase: PANEL_COPY.call.shortened }] },
                          { parts: [{ phrase: PANEL_COPY.call.fullLength }, { kind: "count", n: detail.resultChars, ...PANEL_COPY.units.character }] },
                        ]
                      : { parts: [{ phrase: PANEL_COPY.call.shortened }] }
                  }
                />
              )}
            </>
          ) : connector && detail?.resultNote && !(detail.resultNote === "pending" && ended) ? (
            <p className="text-caption text-muted-foreground">
              <Phrase text={TOOL_RESULT_NOTE[detail.resultNote]} />
            </p>
          ) : null}
          {call.cached && <Caption spec={{ parts: [{ phrase: PANEL_COPY.call.cached }] }} />}
        </section>
      )}

      {call.approval && call.approval.status !== "pending" && (
        <section className="flex flex-col gap-1">
          <SectionHeading text={PANEL_COPY.call.approval} />
          <ApprovalReceipt item={item} />
        </section>
      )}

      {ended && (
        <section className="flex flex-col gap-1">
          <SectionHeading text={PANEL_COPY.call.error} />
          <PhraseWithArgs
            spec={presentation.failed(call)}
            className={cn("text-ui", state === "failed" ? "text-warning-foreground" : "text-muted-foreground")}
          />
          {call.error?.detail ? (
            <p translate="no" lang="" dir="auto" data-no-auto-translate className="break-words text-caption text-muted-foreground">
              {call.error.detail}
            </p>
          ) : null}
        </section>
      )}

      {call.timeoutMs != null && call.timeoutMs > 0 && (
        <Caption spec={{ parts: [{ phrase: PANEL_COPY.call.timeLimit }, { kind: "duration", ms: call.timeoutMs, style: "narrow" }] }} />
      )}

      {retry && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2 text-muted-foreground"
            onClick={() => seedDraft?.(phraseText(askToRunAgainSpec(call), locale))}
          >
            <Phrase text={PANEL_COPY.call.askToRunAgain} />
          </Button>
        </div>
      )}
    </div>
  );
}
