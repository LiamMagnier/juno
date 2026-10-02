"use client";

import * as React from "react";

import { RunGlyph } from "@/components/chat/run/run-glyph";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight, Info, Plug, TriangleAlert } from "@/components/ui/icons";
import type { ClientActionApproval } from "@/lib/action-approval";
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
 * The one loop owner (§7.9.1, §8.4): while the panel is open on a working run,
 * ActivityPanel holds the priority-1 claim for its live item whatever tab is
 * showing, so the transcript line goes still. Here the live item — the running
 * call's marker, or the live reasoning glyph when nothing runs — is the element
 * that loops, and only while that claim owns the loop.
 */

const FOLLOW_SLACK_PX = 24;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function prefersReducedMotion(from: Element | null): boolean {
  if (from?.closest('[data-motion="reduce"]')) return true;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Keeps the panel's scroller at the newest row while the reader is already
 * there (SPEC §8.3.1, "auto-follows only when scrolled to the bottom").
 *
 * It attaches when the list itself mounts — `list` comes from a callback ref,
 * so a tab that opened on the empty state still starts listening once the
 * first row arrives — and follows the list's own size through a
 * `ResizeObserver`, so a reasoning row that grows in place is followed as well
 * as a row that is added. Where it opens: at the newest row on a live run, at
 * the top once the run is over (or when a call was asked for, which the focus
 * effect then brings into view).
 */
function useFollowBottom(list: HTMLElement | null, startPinned: boolean) {
  const pinned = React.useRef(startPinned);
  useIsomorphicLayoutEffect(() => {
    const scroller = list?.closest<HTMLElement>(".right-shell__scroller");
    if (!list || !scroller) return;
    const follow = () => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    };
    if (pinned.current) follow();
    else scroller.scrollTop = 0;
    const onScroll = () => {
      pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(list);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [list]);
}

/**
 * Each page read's `detail`, by call id: the page's title once the fetch knew
 * it (it is the host until then, SPEC §2.4). One pass per activity log, not one
 * search per row per frame.
 */
function fetchDetailsOf(activity: PanelMessage["activity"]): ReadonlyMap<string, string> {
  const details = new Map<string, string>();
  for (const event of activity ?? []) {
    const detail = event.call?.tool === "web_fetch" ? event.detail?.trim() : undefined;
    if (event.call && detail) details.set(event.call.callId, detail);
  }
  return details;
}

/** A page read's title, when its `detail` is more than the address it was read from. */
function pageTitleOf(detail: string | undefined, call: ToolItem["call"]): string | undefined {
  const address = call.web?.finalUrl ?? call.web?.requestedUrl;
  const host = address ? sourceDomain(address) : null;
  return detail && detail.replace(/^www\./, "") !== host && detail !== address ? detail : undefined;
}

/**
 * The ring around a running call's icon. It loops only while it is the
 * panel's live item AND the panel holds the loop (ActivityPanel claims it,
 * §7.9.1 priority 1); otherwise it shows the static signature.
 */
function RunningMarker({ owner, children }: { owner: boolean; children: React.ReactNode }) {
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

interface ReasoningRowProps {
  item: Extract<RunItem, { kind: "reasoning" }>;
  live: boolean;
  instant: boolean;
  /** This item is the panel's live item and the panel holds the loop. */
  owner: boolean;
  /** The panel's claim on the loop, which the glyph reads while it is the owner. */
  loopId: string;
}

/**
 * Memoised on what it draws: a reasoning frame re-renders the row that grew,
 * not every row above it.
 */
const ReasoningRow = React.memo(
  function ReasoningRow({ item, live, instant, owner, loopId }: ReasoningRowProps) {
    const { headline, body } = React.useMemo(() => splitHeadline(item.text), [item.text]);
    const paragraphs = React.useMemo(() => paragraphsOf(body), [body]);
    return (
      <li className="run-step flex gap-2.5 py-2" data-instant={instant ? "" : undefined}>
        <span className="mt-1 grid size-5 shrink-0 place-items-center">
          {live && item.live ? <RunGlyph phase="thinking" loopId={owner ? loopId : `panel-item:${item.key}`} /> : null}
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
              // `auto`: an off-screen paragraph keeps the height it last
              // rendered at, so the scroll height does not jump while reading.
              <p key={i} className="whitespace-pre-wrap break-words" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}>
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </li>
    );
  },
  (a, b) =>
    a.item.key === b.item.key &&
    a.item.text === b.item.text &&
    a.item.live === b.item.live &&
    a.live === b.live &&
    a.instant === b.instant &&
    a.owner === b.owner &&
    a.loopId === b.loopId
);

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

interface ToolRowProps {
  item: ToolItem;
  /** The live approval this waiting call is asking for (`pendingApprovalFor`), or null. */
  pending: ClientActionApproval | null;
  /** The page read's `detail` from the activity log, for its title. */
  pageDetail: string | undefined;
  instant: boolean;
  expanded: boolean;
  onToggle(key: string): void;
  /** This call is the panel's live item and the panel holds the loop. */
  owner: boolean;
  seedDraft?: (text: string) => void;
}

/**
 * Memoised on what it draws, so a reasoning frame (which rebuilds the view)
 * does not re-render every call above the growing paragraph.
 */
const ToolRow = React.memo(
  function ToolRow({ item, pending, pageDetail, instant, expanded, onToggle, owner, seedDraft }: ToolRowProps) {
    const ports = usePanelPorts();
    const { call } = item;
    const presentation = React.useMemo(() => ports.presentTool(call), [ports, call]);
    const state = toolRowState(call);
    const line = presentation[toolLineKind(call)](call);
    const figure = state === "succeeded" ? presentation.figure(call) : null;
    const detailId = React.useId();
    const Icon = TOOL_KIND_ICONS[presentation.icon] ?? Plug;
    const pageTitle = call.tool === "web_fetch" ? pageTitleOf(pageDetail, call) : undefined;

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
          onClick={() => onToggle(item.key)}
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2.5 rounded-md px-1.5 py-1.5 text-start transition-colors duration-fast ease-out-soft hover:bg-accent/60 motion-reduce:transition-none"
        >
          {state === "working" ? (
            <RunningMarker owner={owner}>{icon}</RunningMarker>
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
  },
  (a, b) =>
    a.item.key === b.item.key &&
    a.item.call === b.item.call &&
    a.item.detail === b.item.detail &&
    a.pending === b.pending &&
    a.pageDetail === b.pageDetail &&
    a.instant === b.instant &&
    a.expanded === b.expanded &&
    a.onToggle === b.onToggle &&
    a.owner === b.owner &&
    a.seedDraft === b.seedDraft
);

export interface ActivityTimelineTabProps {
  view: RunView;
  message: PanelMessage;
  /** The run is still streaming. */
  live: boolean;
  /** The panel's live item (`panelLoopItemKey`): the running call, else the live reasoning. */
  loopKey: string | null;
  /** The panel's claim on the loop (`panelLoopClaim`), held by ActivityPanel whatever the tab. */
  loopId: string;
  /** True while that claim owns the loop. */
  loopOwner: boolean;
  focusCallId?: string;
  seedDraft?(text: string): void;
  coversChat(): boolean;
}

export function ActivityTimelineTab({
  view,
  message,
  live,
  loopKey,
  loopId,
  loopOwner,
  focusCallId,
  seedDraft,
  coversChat,
}: ActivityTimelineTabProps) {
  // A callback ref, not only a ref object: the list is absent while the tab
  // shows its empty state, and following must start when it appears.
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const [list, setList] = React.useState<HTMLOListElement | null>(null);
  const attachList = React.useCallback((node: HTMLOListElement | null) => {
    listRef.current = node;
    setList(node);
  }, []);
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

  // Follow the newest row on a live run; a finished run, or one opened on a
  // particular call, starts where the reader is taken instead.
  const [startPinned] = React.useState(() => live && !focusCallId);
  useFollowBottom(list, startPinned);

  const fetchDetails = React.useMemo(() => fetchDetailsOf(message.activity), [message.activity]);

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
    <ol ref={attachList} className="flex flex-col px-4 py-3">
      {view.items.map((item) => {
        const instant = initialKeys.has(item.key);
        const owner = loopOwner && loopKey === item.key;
        switch (item.kind) {
          case "reasoning":
            return <ReasoningRow key={item.key} item={item} live={live} instant={instant} owner={owner} loopId={loopId} />;
          case "commentary":
            return <CommentaryRow key={item.key} item={item} instant={instant} />;
          case "notice":
            return <NoticeRow key={item.key} item={item} instant={instant} />;
          case "tool":
            return (
              <ToolRow
                key={item.key}
                item={item}
                pending={pendingApprovalFor(item.call, message.approvals)}
                pageDetail={fetchDetails.get(item.call.callId)}
                instant={instant}
                expanded={expanded.has(item.key)}
                onToggle={toggle}
                owner={owner}
                seedDraft={seedDraft}
              />
            );
        }
      })}
    </ol>
  );
}
