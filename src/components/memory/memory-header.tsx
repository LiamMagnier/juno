"use client";

import * as React from "react";
import { History, MessagesSquare, Upload } from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { AppPageHeader } from "@/components/app/app-page";
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

/*
 * The page's name, the one switch, and the things done rarely.
 *
 * ONE SWITCH, AND IT IS THE SETTING. On means `memoryEnabled`, the same field
 * the Memory section of Settings shows, so the two can never disagree. It used
 * to be a "Pause memory" switch in a strip at the bottom of the page, worded
 * the other way round from the setting it flipped, and inside the settings
 * modal both were on screen at once.
 *
 * EVERYTHING ELSE IS IN ONE MENU. Learning from past chats, import, export,
 * the settings and reset are each done a handful of times in an account's
 * life; they were a stats strip, a privacy strip and a header button, all
 * permanently on screen.
 *
 * The header renders during loading too (with the controls held as
 * placeholders), so the page's name never moves when the data lands.
 */

export function MemoryHeader({ actions }: { actions: React.ReactNode }) {
  return (
    <AppPageHeader
      heading="Memory"
      lede="What Juno carries from one chat to the next. You can change or remove any of it."
      actions={actions}
      className="mb-5"
    />
  );
}

/** The header's controls while the page loads: the same footprint, no behaviour. */
export function MemoryHeaderActionsSkeleton() {
  return (
    <div className="flex items-center gap-2.5" aria-hidden="true">
      <Skeleton className="h-5 w-16 rounded-full" />
      <Skeleton className="size-8 coarse:size-11" />
    </div>
  );
}

interface MemoryHeaderActionsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Unread chats Juno could learn from; null when unknown, 0 when all read. */
  unread: number | null;
  learning: boolean;
  /** The dreamer reads unread chats anyway, so the item reads "Read them now". */
  dreaming: boolean;
  onLearn: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  onActivity: () => void;
  onReset: () => void;
  /** Nothing is remembered anywhere: export and reset have nothing to act on. */
  empty: boolean;
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
  onReset,
  empty,
}: MemoryHeaderActionsProps) {
  const canLearn = (unread ?? 0) > 0;
  return (
    <div className="flex items-center gap-2.5">
      <label htmlFor="memory-enabled-switch" className="flex cursor-pointer items-center gap-2.5 text-ui text-muted-foreground">
        {enabled ? <span>On</span> : <span>Off</span>}
        <Switch
          id="memory-enabled-switch"
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label="Memory"
        />
      </label>

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
          <DropdownMenuItem onSelect={onActivity}>
            <History />
            Activity
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSettings}>
            <AppIcons.settings />
            Memory settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onReset} disabled={empty}>
            <ActionIcons.restore />
            Reset memory…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
