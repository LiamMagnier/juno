"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ShieldAlert, ShieldCheck, Zap } from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { COMPOSER_MENU_COLLISION_PADDING, composerMenuClass, MenuGlide } from "@/components/chat/composer-menu";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_HINT,
  WORK_APPROVAL_MODE_LABEL,
} from "@/lib/work/domain";
import { CHAT_TASK_MODES, type ChatTaskMode } from "@/lib/chat/task-approval-mode";
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

/**
 * The menu's rows say the mode in two or three words (owner, 6 Nov 2026:
 * "reduce text if it's not useful"). The whole sentence stays in the row's
 * tooltip and its accessible name, and the Work surfaces keep the long labels.
 */
const MODE_ROW: Record<ChatTaskMode, { Icon: IconComponent; label: string }> = {
  conservative: { Icon: ShieldCheck, label: "Ask every time" },
  balanced: { Icon: ShieldAlert, label: "Ask when risky" },
  permissive: { Icon: Zap, label: "Don’t ask" },
};

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
        {/* The menu's trigger outside the tooltip's, as on the + button: the
            outer Radix trigger's data-state wins, so an open menu reads
            data-state="open" and the chip takes its open tone and turns its
            chevron. The other way round it said "closed" while open. */}
        <DropdownMenuTrigger asChild disabled={disabled}>
          <TooltipTrigger asChild>
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
              <ShieldCheck
                aria-hidden="true"
                className={cn("size-4 shrink-0", offDefault ? "text-primary" : "text-muted-foreground")}
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
          </TooltipTrigger>
        </DropdownMenuTrigger>
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
        // Capped to the room above the composer; the rows scroll and the
        // footer stays pinned, so the always-ask line is never cut off.
        className={cn("w-[min(15.75rem,calc(100vw-1.5rem))]", composerMenuClass)}
      >
        <MenuGlide />
        <DropdownMenuPrimitive.RadioGroup
          value={selected}
          onValueChange={(value) => {
            const next = CHAT_TASK_MODES.find((mode) => mode === value);
            if (next && next !== selected) onChange(next);
          }}
        >
          {CHAT_TASK_MODES.map((mode) => {
            const { Icon, label: rowLabel } = MODE_ROW[mode];
            return (
              <DropdownMenuPrimitive.RadioItem
                key={mode}
                value={mode}
                title={WORK_APPROVAL_MODE_HINT[mode]}
                className="group/mode relative flex cursor-default select-none items-center outline-none"
              >
                <Icon aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
                <span className="sr-only">{WORK_APPROVAL_MODE_LABEL[mode]}</span>
                <DropdownMenuPrimitive.ItemIndicator forceMount className="grid size-[18px] place-items-center data-[state=unchecked]:invisible" aria-hidden="true">
                  <Check className="size-[18px] text-foreground" />
                </DropdownMenuPrimitive.ItemIndicator>
              </DropdownMenuPrimitive.RadioItem>
            );
          })}
        </DropdownMenuPrimitive.RadioGroup>
        <p className="cmenu-foot">
          {narrowedBy === "project"
            ? "This project holds its tasks to a stricter mode."
            : narrowedBy === "agent"
              ? "This agent asks more often, so its tasks follow it."
              : "Sending, publishing, paying and deleting always ask."}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
