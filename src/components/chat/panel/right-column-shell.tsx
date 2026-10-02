"use client";

import * as React from "react";

import type { SplitPane } from "@/hooks/use-split-pane";

/*
 * The one right-column shell the Activity and Research panels share (SPEC
 * §8.2, DECISIONS U4): the chat header's height, fill and gutter; close, and
 * back in sheet mode; enter and exit that keep the content painted; no ad-hoc
 * `z-40`. Below the split it is a sheet that keeps the composer reachable.
 *
 * WS0 STUB: final props, placeholder body. WS6 builds it on the `.right-shell`
 * rules already in globals.css.
 */

export interface RightColumnShellProps {
  /** Drives data-open; content stays mounted through the exit. */
  open: boolean;
  /** The stable panel name ("Activity", "Research"): the aside's accessible name AND the h2 text.
   *  It never changes with the phase. */
  label: string;
  /** Status row content beside the h2 (static phase word + clock, "Thought for 12s", run title).
   *  Rendered aria-hidden when it only repeats live state the announcer already speaks. */
  header: React.ReactNode;
  /** e.g. Research controls */
  headerActions?: React.ReactNode;
  /** Rendered with the Radix Tabs of src/components/ui/tabs.tsx. Never a row of plain buttons. */
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTabChange?(id: string): void;
  onClose(): void;
  children: React.ReactNode;
  /** Width, resize handle and bounds: the existing thought pane's `useSplitPane` (THOUGHT_WIDTH_KEY). */
  pane: SplitPane;
  /** chat-view measures `splitEngaged(layoutRef.current)`; below the split the shell is a sheet. */
  mode: "column" | "sheet";
  /** Fires once when the exit finishes: on `transitionend` filtered to `propertyName === "opacity"`,
   *  or after `--dur-exit` + 50 ms when no transition runs. chat-view drops content then. */
  onExited?(): void;
}

export function RightColumnShell({ open, label, children }: RightColumnShellProps) {
  return (
    <aside data-stub="right-column-shell" aria-label={label} hidden={!open}>
      {children}
    </aside>
  );
}
