"use client";

import * as React from "react";
import { EyeOff, History, ListChecks, MessagesSquare, Plus, Upload } from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page";
import { customizeHeaderClass } from "@/components/customize/customize-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The top of Memory: the page's name, one plain sentence, and its controls,
 * drawn by the header every other app page uses (AppPageHeader), so Memory
 * opens the way Skills and Routines beside it do.
 *
 * It used to be a hero of its own: a display title, three big figures (how
 * many memories, how many topics, when it last learned) and a dot-matrix
 * constellation. The figures repeated what the list below says in its group
 * counts, and the drawing was decoration. What a reader needs from the top is
 * what this page is, whether memory is on, and the one thing to do here.
 *
 * Three controls, in the order they are reached for:
 *
 *   On/Off       whether Alevr uses and saves memory at all;
 *   Add memory   the page's one primary action. While nothing is remembered
 *                the empty state carries it instead, so it is never on
 *                screen twice;
 *   …            everything rarer: learn from past chats, import, export,
 *                the activity and the review, what is never remembered,
 *                settings, and reset.
 */

const LEDE = `What ${PRODUCT_NAME} carries from one chat to the next. Correct anything here, or forget it.`;

export function MemoryPageHeader({ actions }: { actions: React.ReactNode }) {
  return <AppPageHeader heading="Memory" lede={LEDE} actions={actions} className={customizeHeaderClass} />;
}

/** The header's controls while the page loads: the same footprint, no behaviour. */
export function MemoryHeaderActionsSkeleton() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <Skeleton className="h-5 w-16 rounded-full" />
      <Skeleton className="h-8 w-28 coarse:h-10" />
      <Skeleton className="size-8 coarse:size-11" />
    </div>
  );
}

interface MemoryHeaderActionsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Unread chats Alevr could learn from; null when unknown, 0 when all read. */
  unread: number | null;
  learning: boolean;
  /** The dreamer reads unread chats anyway, so the item reads "Read them now". */
  dreaming: boolean;
  onLearn: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  onActivity: () => void;
  /** Facts worth a second look (memory-review.ts); the item shows only when there are some. */
  reviewCount?: number;
  onReview?: () => void;
  onTopics?: () => void;
  onReset: () => void;
  /** Set while the page shows one project: its memory can be cleared on its own. */
  project?: { id: string; name: string } | null;
  onClearProject?: () => void;
  /** Nothing is remembered anywhere: export and reset have nothing to act on, and Add lives in the empty state. */
  empty: boolean;
  /** Add memory: open the field at the top of the list. Absent while the empty state carries it. */
  onAdd?: () => void;
  adding?: boolean;
  /** The Add button, so focus can come back to it when the field closes. */
  addButtonRef?: React.Ref<HTMLButtonElement>;
}

export function MemoryHeaderActions({
  enabled,
  onEnabledChange,
  unread,
  learning,
  dreaming,
  onLearn,
  onImport,
  onExport,
  onSettings,
  onActivity,
  reviewCount = 0,
  onReview,
  onTopics,
  onReset,
  project,
  onClearProject,
  empty,
  onAdd,
  adding = false,
  addButtonRef,
}: MemoryHeaderActionsProps) {
  const canLearn = (unread ?? 0) > 0;
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor="memory-enabled-switch"
        className="flex cursor-pointer items-center gap-2 text-ui text-muted-foreground hit-44"
      >
        {enabled ? <span>On</span> : <span>Off</span>}
        <Switch id="memory-enabled-switch" checked={enabled} onCheckedChange={onEnabledChange} aria-label="Memory" />
      </label>

      {onAdd && <AddMemoryButton ref={addButtonRef} paused={!enabled} open={adding} onClick={onAdd} />}

      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <IconButton variant="ghost" size="sm" label="More memory options" title="">
                <ActionIcons.more className="size-4" />
              </IconButton>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className={MENU_W_WIDE}>
          {canLearn && (
            <DropdownMenuItem onSelect={onLearn} disabled={!enabled || learning}>
              {/* Chats, not a sparkle: this reads older conversations. */}
              <MessagesSquare />
              <span className="min-w-0 flex-1">
                {learning ? "Reading past chats…" : dreaming ? "Read past chats now" : "Learn from past chats"}
              </span>
              <span className="tabular-nums text-muted-foreground">{unread}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onImport} disabled={!enabled}>
            <Upload />
            Import from another assistant
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport} disabled={empty}>
            <ActionIcons.download />
            Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {reviewCount > 0 && onReview && (
            <DropdownMenuItem onSelect={onReview}>
              <ListChecks />
              <span className="min-w-0 flex-1">Review</span>
              <span className="tabular-nums text-muted-foreground">{reviewCount}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onActivity}>
            <History />
            Activity
          </DropdownMenuItem>
          {onTopics && (
            <DropdownMenuItem onSelect={onTopics}>
              <EyeOff />
              Topics not remembered
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onSettings}>
            <AppIcons.settings />
            Memory settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {project && onClearProject && (
            <DropdownMenuItem variant="destructive" onSelect={onClearProject} data-clear-project="">
              <ActionIcons.delete />
              <span className="min-w-0 truncate">
                <span>Clear</span> <span translate="no">{project.name}</span>
                <span>…</span>
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={onReset} disabled={empty}>
            <ActionIcons.restore />
            Reset memory…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const AddMemoryButton = React.forwardRef<HTMLButtonElement, { paused: boolean; open: boolean; onClick: () => void }>(
  function AddMemoryButton({ paused, open, onClick }, ref) {
    const button = (
      <Button ref={ref} size="sm" disabled={paused} aria-expanded={open} onClick={onClick} className="gap-1.5">
        <Plus motion="none" className="size-4" aria-hidden="true" />
        Add memory
      </Button>
    );
    if (!paused) return button;
    // A disabled button takes no pointer events, so the tooltip that says why
    // hangs on a focusable wrapper instead.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-control">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>Turn memory on to add to it</TooltipContent>
      </Tooltip>
    );
  }
);
