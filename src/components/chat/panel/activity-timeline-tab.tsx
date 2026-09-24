"use client";

import * as React from "react";

import { RunGlyph } from "@/components/chat/run/run-glyph";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight, Info, Plug, TriangleAlert } from "@/components/ui/icons";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import { sourceDomain } from "@/lib/panel/sources-split";
import type { PhraseSpec, RunItem, RunView } from "@/lib/run/types";
import { cn } from "@/lib/utils";

import { PANEL_COPY } from "./copy";
import {
  isWarningNotice,
  noticeLine,
  paragraphsOf,
  pendingApprovalFor,
  splitHeadline,
  toolLineKind,
  toolRowState,
  type ToolItem,
} from "./panel-model";
import { usePanelPorts } from "./panel-ports";
import { ApprovalControl, ApprovalReceipt, TOOL_KIND_ICONS, ToolCallDetail } from "./tool-call-detail";
import type { PanelMessage } from "./use-panel-message";

/*
 * The Timeline tab (SPEC §8.3.1): the run's own order — reasoning as readable
 * prose, commentary, tool rows and notices — the same `RunView.items` the
 * transcript's inline timeline lists, set here for reading rather than
 * glancing.
 *
 * Live, rows arrive with the `.run-step` entrance (globals.css §7.9), which
 * plays on insertion only: rows already there when the tab mounted carry
 * `data-instant`, so opening the panel or switching back to this tab does not
 * deal the whole list in again. The list follows new rows only while the
 * reader is at the bottom.
 *
 * The one loop owner (§7.9.1): while the panel is open on a working run, its
 * live item — the running call's marker, or the live reasoning glyph when
 * nothing runs — claims priority 1, so the transcript line goes still.
 */

const FOLLOW_SLACK_PX = 24;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function prefersReducedMotion(from: Element | null): boolean {
  if (from?.closest('[data-motion="reduce"]')) return true;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Keeps the scroller pinned to the bottom while it already was, as the list grows. */
function useFollowBottom(listRef: React.RefObject<HTMLElement | null>, size: number) {
  const pinned = React.useRef(true);
  React.useEffect(() => {
    const scroller = listRef.current?.closest(".right-shell__scroller");
    if (!scroller) return;
    const onScroll = () => {
      pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [listRef]);
  useIsomorphicLayoutEffect(() => {
    const scroller = listRef.current?.closest(".right-shell__scroller");
    if (scroller && pinned.current) scroller.scrollTop = scroller.scrollHeight;
  }, [listRef, size]);
}

/**
 * A page read's title: its row's `detail` once the fetch knew the title (it is
 * the host until then, SPEC §2.4). Found by the call id, never by a title.
 */
function pageTitleOf(message: PanelMessage, call: ToolItem["call"]): string | undefined {
  const event = message.activity?.find((entry) => entry.call?.callId === call.callId);
  const detail = event?.detail?.trim();
  const address = call.web?.finalUrl ?? call.web?.requestedUrl;
  const host = address ? sourceDomain(address) : null;
  return detail && detail.replace(/^www\./, "") !== host && detail !== address ? detail : undefined;
}

/** Claims the loop for the panel's live item while it is the live item. */
function useLoopClaim(loopId: string, claim: boolean) {
  const ports = usePanelPorts();
  React.useEffect(() => (claim ? ports.claimLoop(loopId, 1) : undefined), [claim, loopId, ports]);
  return ports.useLoopOwner(loopId);
}

/** The ring around a running call's icon; it loops only while it owns the loop. */
function RunningMarker({ loopId, claim, children }: { loopId: string; claim: boolean; children: React.ReactNode }) {
  const owner = useLoopClaim(loopId, claim);
  return (
    <span
      className="run-marker grid size-5 place-items-center rounded-full"
      data-state="running"
      data-loop={owner ? undefined : "off"}
      data-run-loop-owner={owner ? "" : undefined}
    >
      {children}
    </span>
  );
}

function LiveReasoningGlyph({ loopId, claim }: { loopId: string; claim: boolean }) {
  useLoopClaim(loopId, claim);
  return <RunGlyph phase="thinking" loopId={loopId} />;
}

function ReasoningRow({ item, live, instant, loopKey }: { item: Extract<RunItem, { kind: "reasoning" }>; live: boolean; instant: boolean; loopKey: string | null }) {
  const { headline, body } = React.useMemo(() => splitHeadline(item.text), [item.text]);
  const paragraphs = React.useMemo(() => paragraphsOf(body), [body]);
  return (
    <li className="run-step flex gap-2.5 py-2" data-instant={instant ? "" : undefined}>
      <span className="mt-1 grid size-5 shrink-0 place-items-center">
        {live && item.live ? <LiveReasoningGlyph loopId={`panel:${item.key}`} claim={loopKey === item.key} /> : null}
      </span>
      {/* Model prose: never translated, never clamped (the panel scrolls). */}
      <div className="min-w-0 flex-1" data-no-auto-translate>
        {headline ? (
          <h3 translate="no" lang="" dir="auto" className="mb-1 text-ui font-semibold text-foreground">
            {headline}
          </h3>
        ) : null}
        <div className="prose-juno space-y-3 text-reading text-foreground/85" dir="auto">
          {paragraphs.map((paragraph, i) => (
            <p key={i} className="whitespace-pre-wrap break-words" style={{ contentVisibility: "auto", containIntrinsicSize: "0 96px" }}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </li>
  );
}

function CommentaryRow({ item, instant }: { item: Extract<RunItem, { kind: "commentary" }>; instant: boolean }) {
  const paragraphs = React.useMemo(() => paragraphsOf(item.text), [item.text]);
  return (
    <li className="run-step flex gap-2.5 py-2" data-instant={instant ? "" : undefined}>
      <span className="size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-caption text-muted-foreground">
          <Phrase text={PANEL_COPY.timeline.commentary} />
        </p>
        <div className="space-y-2 border-s-2 border-border/70 ps-3 text-body text-muted-foreground" data-no-auto-translate dir="auto">
          {paragraphs.map((paragraph, i) => (
            <p key={i} className="whitespace-pre-wrap break-words">
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </li>
  );
}

function NoticeRow({ item, instant }: { item: Extract<RunItem, { kind: "notice" }>; instant: boolean }) {
  const warning = item.notice ? isWarningNotice(item.notice) : false;
  const line = React.useMemo(() => (item.notice ? noticeLine(item.notice) : null), [item.notice]);
  return (
    <li className="run-step flex items-start gap-2.5 py-1.5" data-instant={instant ? "" : undefined}>
      <span className="grid size-5 shrink-0 place-items-center">
        {warning ? (
          <TriangleAlert className="size-3.5 text-warning-foreground" />
        ) : (
          <Info className="size-3.5 text-muted-foreground" />
        )}
      </span>
      {line ? (
        <PhraseWithArgs spec={line} className={cn("min-w-0 flex-1 text-ui", warning ? "text-warning-foreground" : "text-muted-foreground")} />
      ) : (
        // A pre-rework row: its English title is all there is (INV-20).
        <span className="min-w-0 flex-1 text-ui text-muted-foreground">
          {item.legacyTitle}
          {item.legacyDetail ? <span className="block text-caption">{item.legacyDetail}</span> : null}
        </span>
      )}
    </li>
  );
}

function ToolRow({
  item,
  message,
  instant,
  expanded,
  onToggle,
  loopKey,
  seedDraft,
}: {
  item: ToolItem;
  message: PanelMessage;
  instant: boolean;
  expanded: boolean;
  onToggle(): void;
  loopKey: string | null;
  seedDraft?: (text: string) => void;
}) {
  const ports = usePanelPorts();
  const { call } = item;
  const presentation = React.useMemo(() => ports.presentTool(call), [ports, call]);
  const state = toolRowState(call);
  const line = presentation[toolLineKind(call)](call);
  const figure = state === "succeeded" ? presentation.figure(call) : null;
  const pending = pendingApprovalFor(call, message.approvals);
  const detailId = React.useId();
  const Icon = TOOL_KIND_ICONS[presentation.icon] ?? Plug;
  const pageTitle = React.useMemo(() => (call.tool === "web_fetch" ? pageTitleOf(message, call) : undefined), [message, call]);

  const meta: PhraseSpec[] = [];
  if (figure) meta.push(figure);
  if (call.durationMs != null && call.durationMs > 0 && state !== "working" && state !== "waiting") {
    meta.push({ parts: [{ kind: "duration", ms: call.durationMs, style: "narrow" }] });
  }

  const icon = <Icon className={cn("size-3.5", state === "failed" ? "text-warning-foreground" : "text-muted-foreground")} />;

  return (
    <li className="run-step py-0.5" data-instant={instant ? "" : undefined} data-call-id={call.callId}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        onClick={onToggle}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2.5 rounded-md px-1.5 py-1.5 text-start transition-colors duration-fast ease-out-soft hover:bg-accent/60 motion-reduce:transition-none"
      >
        {state === "working" ? (
          <RunningMarker loopId={`panel:${item.key}`} claim={loopKey === item.key}>
            {icon}
          </RunningMarker>
        ) : (
          <span
            className="run-marker grid size-5 shrink-0 place-items-center rounded-full"
            data-state={state === "waiting" ? "waiting" : undefined}
          >
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <PhraseWithArgs
            spec={line}
            className={cn(
              "block text-ui",
              state === "failed" ? "text-warning-foreground" : state === "succeeded" || state === "working" || state === "waiting" ? "text-foreground" : "text-muted-foreground"
            )}
          />
          {meta.length > 0 && <PhraseWithArgs spec={meta} className="block text-caption text-muted-foreground" />}
        </span>
        {state === "failed" && <TriangleAlert className="mt-1 size-3.5 shrink-0 text-warning-foreground" />}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none rtl:-scale-x-100",
            expanded && "rotate-90 rtl:-rotate-90"
          )}
        />
      </button>
      {pending ? (
        <div className="ps-[1.875rem] pt-1">
          <ApprovalControl approval={pending} item={item} presentation={presentation} fetchImpl={ports.fetch} />
        </div>
      ) : state !== "waiting" && call.approval && call.approval.status !== "pending" && !expanded ? (
        <div className="ps-[1.875rem]">
          <ApprovalReceipt item={item} />
        </div>
      ) : null}
      <Collapse open={expanded}>
        <div id={detailId} className="ps-[1.875rem]">
          <ToolCallDetail item={item} presentation={presentation} seedDraft={seedDraft} pageTitle={pageTitle} />
        </div>
      </Collapse>
    </li>
  );
}

export interface ActivityTimelineTabProps {
  view: RunView;
  message: PanelMessage;
  /** The run is still streaming. */
  live: boolean;
  /** The item that owns the loop while the panel is open (`panelLoopItemKey`). */
  loopKey: string | null;
  focusCallId?: string;
  seedDraft?(text: string): void;
  coversChat(): boolean;
}

export function ActivityTimelineTab({ view, message, live, loopKey, focusCallId, seedDraft, coversChat }: ActivityTimelineTabProps) {
  const listRef = React.useRef<HTMLOListElement | null>(null);
  // Rows already here when the tab mounted do not play their entrance.
  const [initialKeys] = React.useState(() => new Set(view.items.map((item) => item.key)));
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => {
    const focused = focusCallId ? view.tools.find((tool) => tool.call.callId === focusCallId) : undefined;
    return new Set(focused ? [focused.key] : []);
  });
  const toggle = React.useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useFollowBottom(listRef, view.items.length);

  // A call opened from the transcript: expand it and bring it to the middle.
  const focusedKey = focusCallId ? view.tools.find((tool) => tool.call.callId === focusCallId)?.key : undefined;
  React.useEffect(() => {
    if (!focusedKey || !focusCallId) return;
    setExpanded((current) => (current.has(focusedKey) ? current : new Set(current).add(focusedKey)));
    const row = listRef.current?.querySelector(`[data-call-id="${CSS.escape(focusCallId)}"]`);
    row?.scrollIntoView({ block: "center", behavior: prefersReducedMotion(row) ? "instant" : "smooth" });
  }, [focusCallId, focusedKey]);

  // In sheet mode the transcript's approval card is under the panel, so a call
  // that starts waiting is brought into view here, where it can be answered.
  // Once per call that starts waiting, not on every re-render while it waits.
  const waitingKey = view.tools.find((tool) => tool.call.status === "awaiting_approval")?.call.callId;
  const coversChatRef = React.useRef(coversChat);
  React.useEffect(() => {
    coversChatRef.current = coversChat;
  }, [coversChat]);
  React.useEffect(() => {
    if (!waitingKey || !coversChatRef.current()) return;
    const row = listRef.current?.querySelector(`[data-call-id="${CSS.escape(waitingKey)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion(row) ? "instant" : "smooth" });
  }, [waitingKey]);

  if (view.items.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-ui text-muted-foreground">
          <Phrase text={PANEL_COPY.timeline.empty} />
        </p>
        {live ? (
          <p className="mt-1 text-caption text-muted-foreground">
            <Phrase text={PANEL_COPY.timeline.emptyDetail} />
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ol ref={listRef} className="flex flex-col px-4 py-3">
      {view.items.map((item) => {
        const instant = initialKeys.has(item.key);
        switch (item.kind) {
          case "reasoning":
            return <ReasoningRow key={item.key} item={item} live={live} instant={instant} loopKey={loopKey} />;
          case "commentary":
            return <CommentaryRow key={item.key} item={item} instant={instant} />;
          case "notice":
            return <NoticeRow key={item.key} item={item} instant={instant} />;
          case "tool":
            return (
              <ToolRow
                key={item.key}
                item={item}
                message={message}
                instant={instant}
                expanded={expanded.has(item.key)}
                onToggle={() => toggle(item.key)}
                loopKey={loopKey}
                seedDraft={seedDraft}
              />
            );
        }
      })}
    </ol>
  );
}
