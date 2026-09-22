"use client";

import * as React from "react";
import { Undo2 } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetClose, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EditStatusToken, OperationDiff } from "@/components/memory/operation-diff";
import type { Memory, MemoryEditRecord } from "@/components/memory/memory-model";
import { relativeTime } from "@/components/memory/memory-time";
import { RecapView, type RecapExtras } from "@/components/memory/recap-view";
import type { RecapPeriod } from "@/lib/memory-recap";

/*
 * Activity: the history behind the page, one step aside from it.
 *
 * Two things live here that used to be peers of the list: the edit ledger
 * (every instruction, what it changed, its Undo) was an always-visible "Manage
 * edits" card, and the recap was a third view beside Topics and All facts.
 * Both answer "what happened", which is a question a reader asks now and then,
 * not every visit, so they are a side sheet reached from a quiet link. The
 * page keeps what is happening NOW: a change waiting for a decision stays
 * under the prompt bar, where it was asked for.
 */

export type ActivityTab = "edits" | "recap";

interface ActivitySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: ActivityTab;
  onTabChange: (tab: ActivityTab) => void;
  edits: MemoryEditRecord[];
  busyEditIds: ReadonlySet<string>;
  /** Every row in scope, suppressions included (see RecapView). */
  memories: Memory[];
  onAccept: (edit: MemoryEditRecord) => Promise<void>;
  onUndo: (edit: MemoryEditRecord) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** For the dev gallery only. */
  loadRecapExtras?: (days: RecapPeriod) => Promise<RecapExtras>;
}

export function ActivitySheet({
  open,
  onOpenChange,
  tab,
  onTabChange,
  edits,
  busyEditIds,
  memories,
  onAccept,
  onUndo,
  onDelete,
  loadRecapExtras,
}: ActivitySheetProps) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title="Memory activity"
        // Modal at every width (focus trapped, the page scroll-locked), so the
        // page behind is dimmed at every width too, not only on a phone.
        scrim="always"
        className="flex w-[28rem] max-w-[92vw] flex-col"
        // Radix focuses the first control on open, which here is Close, and
        // its tooltip would open with it. The heading takes focus instead: a
        // screen reader lands on the sheet's name, and nothing pops.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          headingRef.current?.focus();
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
          <h2 ref={headingRef} tabIndex={-1} className="text-heading outline-none">
            Activity
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetClose asChild>
                <IconButton variant="ghost" size="sm" label="Close activity" title="" className="-mr-1.5">
                  <ActionIcons.dismiss className="size-4" />
                </IconButton>
              </SheetClose>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
        <div className="px-5 pb-4">
          <SegmentedControl<ActivityTab>
            value={tab}
            onChange={onTabChange}
            ariaLabel="Activity"
            className="w-full"
            options={[
              { value: "edits", label: "Your edits", count: edits.length },
              { value: "recap", label: "Recap" },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8">
          <div key={tab} className="motion-safe:animate-fade-in">
            {tab === "edits" ? (
              <EditHistory
                edits={edits}
                busyEditIds={busyEditIds}
                onAccept={onAccept}
                onUndo={onUndo}
                onDelete={onDelete}
              />
            ) : (
              <RecapView memories={memories} loadExtras={loadRecapExtras} />
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EditHistory({
  edits,
  busyEditIds,
  onAccept,
  onUndo,
  onDelete,
}: {
  edits: MemoryEditRecord[];
  busyEditIds: ReadonlySet<string>;
  onAccept: (edit: MemoryEditRecord) => Promise<void>;
  onUndo: (edit: MemoryEditRecord) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (edits.length === 0) {
    return (
      <p className="py-8 text-center text-ui text-muted-foreground">
        Changes you ask for under the summary are kept here, with an Undo for the ones you applied.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {edits.map((edit) => {
        const busy = busyEditIds.has(edit.id);
        return (
          <li key={edit.id} className="py-4 first:pt-1">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-ui text-foreground">
                <q>{edit.instruction}</q>
              </p>
              <EditStatusToken status={edit.status} />
            </div>
            {(edit.note ?? edit.summary) && (
              <p className="mt-1 text-caption text-muted-foreground">{edit.note ?? edit.summary}</p>
            )}
            <OperationDiff operations={edit.operations} className="mt-2.5" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-caption text-muted-foreground">{relativeTime(edit.createdAt)}</span>
              <div className="flex items-center gap-1">
                {edit.status === "applied" && (
                  <Button variant="ghost" size="sm" loading={busy} onClick={() => void onUndo(edit)} className="gap-1.5">
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Undo
                  </Button>
                )}
                {edit.status !== "applied" && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onDelete(edit.id)}>
                    {edit.status === "pending" ? "Discard" : "Remove"}
                  </Button>
                )}
                {edit.status === "pending" && (
                  <Button size="sm" loading={busy} onClick={() => void onAccept(edit)}>
                    Apply change
                  </Button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
