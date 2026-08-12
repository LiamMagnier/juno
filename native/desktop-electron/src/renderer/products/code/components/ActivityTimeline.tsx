/**
 * The activity timeline — the centre of the Code surface.
 *
 * Rendering strategy, in one place so it can be argued with:
 *
 *  • The list subscribes to the store's `timeline` version counter only. Tokens
 *    arrive on the `stream` channel and never reach this component, so a
 *    streaming response does not re-render the transcript. See the header
 *    comment in `state/timeline-store.ts` for the full argument.
 *
 *  • Only the rows intersecting the scrollport (plus overscan) are mounted.
 *    Everything else is height, not DOM. A 12,000-entry session mounts the same
 *    ~30 rows as a 12-entry one.
 *
 *  • Rows are `memo`ised on entry identity, and the store replaces only the
 *    entry that changed, so a re-render of this component costs a shallow prop
 *    compare per visible row and nothing else.
 *
 *  • Grouping happens in the reducer, not here: consecutive same-category tool
 *    calls from the same agent land in one entry, so "read 40 files" is one row
 *    that can be opened, not 40 rows to scroll past.
 *
 * Scroll anchoring follows the tail only while the user is already at the tail.
 * Scrolling up detaches and surfaces a "Jump to latest" control; auto-scroll
 * that yanks a user out of the output they were reading is worse than none.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import type { CodeSessionStore, RunStatus, TimelineEntry } from '../state/timeline-store.js';
import { startsCollapsed } from '../state/timeline-store.js';
import { useStoreVersion } from '../state/useCodeSession.js';
import { useVirtualRows } from '../state/useVirtualRows.js';
import { TimelineRow } from './TimelineRow.js';
import { Button, EmptyState } from './primitives.js';
import { AgentsIcon, ArrowDownIcon } from './icons.js';

export interface ActivityTimelineProps {
  store: CodeSessionStore;
  cwd: string;
  status: RunStatus;
  onReviewApproval: (callId: string) => void;
  onReviewChanges: () => void;
  onInspectSubagent: (id: string) => void;
  className?: string;
}

/** Height guesses, used only until a row has been measured once. */
function estimateHeight(entry: TimelineEntry | undefined): number {
  if (!entry) return 32;
  switch (entry.kind) {
    case 'message':
      return Math.min(400, 40 + Math.ceil(entry.text.length / 90) * 21);
    case 'prompt':
      return 56 + Math.ceil(entry.text.length / 90) * 21;
    case 'tools':
      return 30;
    case 'approval':
      return 62;
    case 'changes':
      return 44;
    case 'subagent':
      return 30;
    case 'turn':
      return 32;
    case 'notice':
      return entry.tone === 'error' ? 70 : 26;
  }
}

export function ActivityTimeline({
  store,
  cwd,
  status,
  onReviewApproval,
  onReviewChanges,
  onInspectSubagent,
  className,
}: ActivityTimelineProps): JSX.Element {
  const version = useStoreVersion(store, 'timeline');
  const entries = store.entries;
  const count = entries.length;

  /* Explicit user overrides only. The default open/closed state is derived from
     the entry itself, so a group that gains a failure opens without the user
     having to have "not collapsed" it first. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [invalidateFrom, setInvalidateFrom] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const indexById = useRef(new Map<string, number>());

  indexById.current.clear();
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index];
    if (entry) indexById.current.set(entry.id, index);
  }

  const isExpanded = useCallback(
    (entry: TimelineEntry): boolean => {
      const override = overrides.get(entry.id);
      if (override !== undefined) return override;
      if (entry.kind === 'tools') return !startsCollapsed(entry);
      return false;
    },
    [overrides],
  );

  const onToggle = useCallback(
    (id: string): void => {
      setOverrides((previous) => {
        const next = new Map(previous);
        const index = indexById.current.get(id);
        const entry = index === undefined ? undefined : entries[index];
        const current =
          previous.get(id) ??
          (entry !== undefined && entry.kind === 'tools' ? !startsCollapsed(entry) : false);
        next.set(id, !current);
        return next;
      });
      const index = indexById.current.get(id);
      if (index !== undefined) setInvalidateFrom(index);
    },
    [entries],
  );

  const virtual = useVirtualRows({
    count,
    estimate: (index) => estimateHeight(entries[index]),
    overscan: 6,
    invalidateFrom,
    /* Streaming growth is pinned inside the hook, in the DOM. The list cannot
       do it in an effect without subscribing to the token channel. */
    stickToBottom: follow,
  });

  const { atBottom, scrollToBottom } = virtual;

  /* Follow the tail while the user is at the tail. `version` is the append
     signal; `atBottom` is the user's intent. */
  useEffect(() => {
    if (!follow) return;
    scrollToBottom();
  }, [version, follow, scrollToBottom]);

  useEffect(() => {
    setFollow(atBottom);
  }, [atBottom]);

  const visible = useMemo(() => {
    const rows: Array<{ entry: TimelineEntry; index: number }> = [];
    for (let index = virtual.range.start; index < virtual.range.end; index += 1) {
      const entry = entries[index];
      if (entry) rows.push({ entry, index });
    }
    return rows;
    /* `entries` is mutated in place by design (see timeline-store.ts); `version`
       is the signal that it changed, which is why it is a dependency even though
       the rule cannot tell it is read. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual.range.start, virtual.range.end, version, entries]);

  const busy = status === 'thinking' || status === 'working' || status === 'starting';

  if (count === 0) {
    return (
      <div className={cn('relative flex-1 overflow-hidden bg-background', className)}>
        <EmptyState
          icon={<AgentsIcon className="h-6 w-6" />}
          title="No activity yet"
          detail="Describe a task below. Every file read, edit, command and subagent this session runs will be recorded here, grouped so you can see what actually happened."
        />
      </div>
    );
  }

  return (
    <div className={cn('relative min-h-0 flex-1 bg-background', className)}>
      <div
        ref={virtual.scrollRef}
        role="feed"
        aria-label="Agent activity"
        aria-busy={busy}
        tabIndex={0}
        className={cn(
          'h-full overflow-y-auto overflow-x-hidden outline-none',
          'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        <div style={{ height: virtual.totalHeight }} className="relative w-full">
          {visible.map(({ entry, index }) => (
            <div
              key={entry.id}
              ref={virtual.measureRef(index)}
              aria-posinset={index + 1}
              aria-setsize={count}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtual.offsetOf(index)}px)`,
              }}
            >
              <TimelineRow
                entry={entry}
                expanded={isExpanded(entry)}
                onToggle={onToggle}
                store={store}
                cwd={cwd}
                onReviewApproval={onReviewApproval}
                onReviewChanges={onReviewChanges}
                onInspectSubagent={onInspectSubagent}
              />
            </div>
          ))}
        </div>
      </div>

      {!atBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button
            className="pointer-events-auto shadow-none"
            icon={<ArrowDownIcon className="h-3 w-3" />}
            onClick={() => {
              setFollow(true);
              scrollToBottom('smooth');
            }}
          >
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
