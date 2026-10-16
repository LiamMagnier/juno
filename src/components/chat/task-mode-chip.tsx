"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Hand } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { COMPOSER_MENU_COLLISION_PADDING, composerMenuClass, MenuGlide, MenuLabel } from "@/components/chat/composer-menu";
import { StatusIcons } from "@/lib/app-icons";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
} from "@/lib/work/domain";
import { CHAT_TASK_MODES, CHAT_TASK_MODE_NOTE, type ChatTaskMode } from "@/lib/chat/task-approval-mode";
import { cn } from "@/lib/utils";

/*
 * HOW OFTEN A TASK FROM THIS CHAT ASKS — the chat composer's mode chip.
 *
 * It sits beside the model chip because it answers the same kind of question
 * about the next message: not what it says, but what happens to it. The three
 * modes are Work's own, in Work's own words (`WORK_APPROVAL_MODE_LABEL`), so
 * a reader who has met them on a task meets the same promise here.
 *
 * At rest it is a raised hand and nothing else while the chat is on the
 * default: the default is not a decision and the composer row is already a
 * `+`, a model, a mic and Send. Move off it and the mode's name appears beside
 * the hand, so a chat set to "Just do it" says so every time someone types in
 * it. Under 640px the name stays in the menu and the tooltip.
 *
 * A raised hand rather than a shield, for the reason the Work chip gives: the
 * shields are spoken for by approvals themselves, and a shield in the
 * composer would read as an approval already waiting.
 */

export function TaskModeChip({
  chosen,
  effective,
  narrowedBy,
  onChange,
  disabled,
}: {
  /** The reader's choice for this chat, or null for the default. */
  chosen: ChatTaskMode | null;
  /** What a task started now runs as. */
  effective: ChatTaskMode;
  /** Which layer made `effective` stricter than the choice, when one did. */
  narrowedBy: "project" | "agent" | null;
  onChange: (mode: ChatTaskMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  // The tick marks the choice. With none, it marks what runs, unless a project
  // or agent narrowed that: an agent's thread with nobody choosing runs as the
  // agent's own mode, and ticking the default beside a chip that says "Just do
  // it" would contradict it.
  const selected = chosen ?? (narrowedBy === null ? effective : DEFAULT_WORK_PERMISSION_POLICY);
  const offDefault = effective !== DEFAULT_WORK_PERMISSION_POLICY;
  const label = WORK_APPROVAL_MODE_LABEL[effective];

  return (
    <DropdownMenu open={open && !disabled} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              type="button"
              disabled={disabled}
              data-task-mode={effective}
              className={cn(composerChipClass, "max-w-[12rem]", !offDefault && "px-2")}
            >
              {/* The name, said whole: a static phrase and the mode's own
                  label, each a text node the catalog can translate. */}
              <span className="sr-only">Tasks from this chat</span>
              <span className="sr-only">{label}</span>
              <Hand
                aria-hidden="true"
                className={cn("size-3.5 shrink-0", offDefault ? "text-primary" : "text-muted-foreground")}
              />
              {offDefault && (
                <span
                  key={effective}
                  aria-hidden="true"
                  className="hidden min-w-0 truncate motion-safe:animate-fade-in sm:inline"
                >
                  {label}
                </span>
              )}
              <ChevronDown aria-hidden="true" className={cn(composerChevronClass, !offDefault && "hidden sm:block")} motion="none" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span>Tasks from this chat</span>: <span>{label}</span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={COMPOSER_MENU_COLLISION_PADDING}
        // Wider than the 18rem two-line recipe: each row carries a whole
        // sentence, and Skip's names five exceptions.
        className={cn("flex w-[min(21rem,calc(100vw-1.5rem))] flex-col", composerMenuClass)}
      >
        <MenuGlide />
        <MenuLabel>How often tasks from this chat ask</MenuLabel>
        <DropdownMenuPrimitive.RadioGroup
          value={selected}
          onValueChange={(value) => {
            const next = CHAT_TASK_MODES.find((mode) => mode === value);
            if (next && next !== selected) onChange(next);
          }}
        >
          {CHAT_TASK_MODES.map((mode) => {
            const active = mode === selected;
            const note = CHAT_TASK_MODE_NOTE[mode];
            return (
              <DropdownMenuPrimitive.RadioItem
                key={mode}
                value={mode}
                // Two lines, so the check sits at the top of the row, beside the
                // name it marks, not centred against a wrapped sentence.
                className="relative flex cursor-default select-none items-start outline-none"
              >
                {/* The row recipe zeroes vertical padding (36px single-line
                    rows); a two-line row takes its breathing room inside. */}
                <span className="min-w-0 flex-1 py-2">
                  <span className="flex items-center gap-2">
                    <span className={cn("font-medium", active && "text-primary")}>{WORK_APPROVAL_MODE_LABEL[mode]}</span>
                    {mode === DEFAULT_WORK_PERMISSION_POLICY && (
                      <span className="font-mono text-micro text-muted-foreground">Default</span>
                    )}
                  </span>
                  <span className="mt-0.5 block whitespace-normal text-caption leading-relaxed text-muted-foreground">
                    {WORK_APPROVAL_MODE_SUMMARY[mode]}
                    {note ? ` ${note}` : ""}
                  </span>
                </span>
                <DropdownMenuPrimitive.ItemIndicator className="mt-2.5 shrink-0">
                  <StatusIcons.success aria-hidden="true" className="size-3.5 text-primary" />
                </DropdownMenuPrimitive.ItemIndicator>
              </DropdownMenuPrimitive.RadioItem>
            );
          })}
        </DropdownMenuPrimitive.RadioGroup>
        <div className="relative z-[1] space-y-1 px-2.5 pb-1.5 pt-2 text-caption leading-relaxed text-muted-foreground">
          {/* Why the mode in the chip is not the one ticked above. Each reason
              is one whole sentence, so it is translated as one. */}
          {narrowedBy === "project" && (
            <p className="text-foreground/80">This project’s settings hold its tasks to a stricter mode than the one you picked.</p>
          )}
          {narrowedBy === "agent" && (
            <p className="text-foreground/80">This agent is set to ask more often, so its tasks follow its setting.</p>
          )}
          <p>Sending, publishing, paying and deleting always ask, whichever mode you pick.</p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
