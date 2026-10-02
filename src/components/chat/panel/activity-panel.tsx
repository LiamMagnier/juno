"use client";

import * as React from "react";

import { RunClock } from "@/components/chat/run/run-clock";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import { splitSources, type SourcesSplit } from "@/lib/panel/sources-split";
import type { RunView } from "@/lib/run/types";
import { cn } from "@/lib/utils";

import { ActivityDetailsTab } from "./activity-details-tab";
import { ActivitySourcesTab, sourcesCount } from "./activity-sources-tab";
import { ActivityTimelineTab } from "./activity-timeline-tab";
import { PANEL_COPY } from "./copy";
import {
  ACTIVITY_TAB_STORAGE_KEY,
  activityTabs,
  detailsModel,
  hasDetails,
  isActivityTabId,
  panelHeaderModel,
  panelLoopClaim,
  panelLoopId,
  panelLoopItemKey,
  researchFactOf,
  resolveActivityTab,
  type ActivityTab,
  type PanelHeaderModel,
} from "./panel-model";
import { usePanelPorts } from "./panel-ports";
import { useRightColumnChrome } from "./right-column-shell";
import { usePanelMessage } from "./use-panel-message";

/*
 * The Activity panel (SPEC §8.3, DECISIONS U3): the detail surface for one
 * message's run — Timeline, Sources (Cited / Also read) and Details — keyed by
 * the message's stable `renderKey`, so it stays open across completion.
 * Reading the thinking never requires it; it is where the full record is.
 *
 * It renders inside the one `RightColumnShell` chat-view keeps, and hands the
 * shell its header (the static phase word and clock while working, the summary
 * lead at rest) and its tabs through `useRightColumnChrome`. It reads its
 * message from `PanelMessagesProvider`, which re-renders it only when
 * something it draws changed — never per answer token (U5).
 *
 * Loaded as its own chunk (`activity-panel-lazy.tsx`), prefetched when a run
 * first starts working, so the first open never shows a blank.
 */

/**
 * The panel is memoised on its props, so chat-view's per-token re-renders stop
 * here: pass stable callbacks (`useCallback`, or functions that read refs).
 */
export interface ActivityPanelProps {
  /** Identity; never the message id (B1). */
  renderKey: string;
  /** Scroll to and expand this call. */
  focusCallId?: string;
  onClose(): void;
  /** "Ask to run again" on a failed third-party call. */
  seedDraft?(text: string): void;
  coversChat(): boolean;
}

const EMPTY_SPLIT: SourcesSplit = { cited: [], alsoRead: [], found: [] };

function readStoredTab(): string | null {
  try {
    return window.localStorage.getItem(ACTIVITY_TAB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeTab(tab: string) {
  try {
    window.localStorage.setItem(ACTIVITY_TAB_STORAGE_KEY, tab);
  } catch {
    /* A panel that cannot remember its tab still switches it. */
  }
}

/**
 * The tab being shown. The reader's last choice persists per viewer
 * (`juno:activity-tab`), read after mount so the server's markup and the first
 * client paint agree. A focused call opens on Timeline, where that call is,
 * until the reader picks another tab.
 */
function useActivityTab(available: readonly ActivityTab[], focusCallId: string | undefined) {
  const [preferred, setPreferred] = React.useState<string | null>(null);
  React.useEffect(() => {
    setPreferred(readStoredTab());
  }, []);
  const [picked, setPicked] = React.useState<{ tab: string; focus: string | undefined } | null>(null);
  // A pick made before the latest focus request does not outrank it.
  const pickedTab = picked && picked.focus === focusCallId ? picked.tab : null;
  const tab = resolveActivityTab(pickedTab ?? preferred, available, {
    focusCall: Boolean(focusCallId) && pickedTab == null,
  });
  const choose = React.useCallback(
    (id: string) => {
      if (!isActivityTabId(id)) return;
      setPicked({ tab: id, focus: focusCallId });
      setPreferred(id);
      storeTab(id);
    },
    [focusCallId]
  );
  return [tab, choose] as const;
}

/** The header's status row: the static phase word and clock while working; the summary lead at rest. */
function ActivityHeader({ model }: { model: PanelHeaderModel }) {
  if (model.kind === "none") return null;
  if (model.kind === "live") {
    // Repeats what the announcer already says, so it is hidden from assistive
    // tech. The word never shimmers and nothing here loops: the panel's loop
    // owner is its running row (§7.9.1).
    return (
      <span aria-hidden="true" className="flex min-w-0 items-center gap-1.5">
        <Phrase text={model.word} className="truncate" />
        <RunClock elapsedMs={0} since={model.since} showAfterMs={0} className="text-caption" />
      </span>
    );
  }
  return (
    <PhraseWithArgs
      spec={model.line}
      className={cn("truncate", model.failed ? "text-warning-foreground" : "text-muted-foreground")}
    />
  );
}

export const ActivityPanel = React.memo(function ActivityPanel({
  renderKey,
  focusCallId,
  seedDraft,
  coversChat,
}: ActivityPanelProps) {
  const ports = usePanelPorts();
  const { message } = usePanelMessage(renderKey);
  const live = message?.streaming === true;

  const view: RunView | null = React.useMemo(() => (message ? ports.buildRunView(message) : null), [ports, message]);
  const split = React.useMemo(() => (message ? splitSources(message) : EMPTY_SPLIT), [message]);
  const details = React.useMemo(
    () => (view && message ? detailsModel(view, message, ports.modelInfo) : null),
    [view, message, ports]
  );
  const sources = sourcesCount(split);
  const showDetails = hasDetails(details);
  const tabs = React.useMemo(() => activityTabs({ sources, details: showDetails }), [sources, showDetails]);
  const [tab, chooseTab] = useActivityTab(tabs, focusCallId);

  // The phase follows the message, not the clock: the header word does not
  // tick, and the clock beside it is its own leaf.
  const phase = React.useMemo(
    () => (message && view ? ports.phaseOf(message, view, ports.now()) : null),
    [ports, message, view]
  );
  const header = React.useMemo(
    () => <ActivityHeader model={panelHeaderModel(view, phase, researchFactOf(message))} />,
    [view, phase, message]
  );
  const loopKey = React.useMemo(() => panelLoopItemKey(view, live), [view, live]);
  const loopId = React.useMemo(() => panelLoopId(renderKey), [renderKey]);
  const claim = React.useMemo(() => panelLoopClaim(renderKey, loopKey), [renderKey, loopKey]);
  React.useEffect(() => {
    if (!claim) return;
    return ports.claimLoop(claim.id, claim.priority);
  }, [ports, claim]);
  const panelLoopOwner = ports.useLoopOwner(loopId);
  const itemLoopOwner = ports.useLoopOwner(loopKey ? `panel:${loopKey}` : "");
  const loopOwner = panelLoopOwner || itemLoopOwner;

  useRightColumnChrome({
    label: PANEL_COPY.activity,
    header,
    tabs,
    activeTab: tab,
    onTabChange: chooseTab,
  });

  if (!message || !view) return null;

  return (
    // Favicons sit on the card fill here, so their separation ring does too (§7.9).
    <div data-activity-panel="" style={{ "--fav-ring": "var(--card)" } as React.CSSProperties}>
      {tab === "timeline" && (
        <ActivityTimelineTab
          key={renderKey}
          view={view}
          message={message}
          live={live}
          loopKey={loopKey}
          loopId={loopId}
          loopOwner={loopOwner}
          focusCallId={focusCallId}
          seedDraft={seedDraft}
          coversChat={coversChat}
        />
      )}
      {tab === "sources" && <ActivitySourcesTab key={renderKey} split={split} />}
      {tab === "details" && details && <ActivityDetailsTab key={renderKey} details={details} />}
    </div>
  );
});

export default ActivityPanel;
