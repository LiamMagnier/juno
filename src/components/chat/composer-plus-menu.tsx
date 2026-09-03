"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { composerIconButtonClass } from "@/components/ui/composer-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * The composer's `+` menu (docs/design/SOFT_UI.md §3).
 *
 * One `.surface-float` menu at `rounded-popover` with p-1.5, so its 36px rows
 * sit concentric at `rounded-control`. Sections are separated by a hairline
 * and nothing else — no eyebrows naming them, because "Attach files" and a
 * row with a switch on it already say what kind of row they are. Tool
 * toggles are rows with a trailing Switch that keep the menu open when
 * pressed; Project and Connectors are real Radix submenus that fly out to
 * the right on the same recipe, with Radix's own pointer grace area so a
 * diagonal move from the trigger into the flyout never closes it.
 *
 * The bar shows nothing about tool state: what is on is visible only in here
 * (and in the trigger's accessible name, for a screen reader).
 *
 * Keyboard (all native to the menu): ↑/↓ move, Enter/Space activate or
 * toggle, → opens a submenu, ← closes it, Esc closes everything.
 */

export type PlusMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      icon: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      /** Trailing note in the muted mono, e.g. why a row can't be used. */
      note?: string;
    }
  | {
      kind: "toggle";
      id: string;
      label: string;
      icon: LucideIcon;
      checked: boolean;
      onToggle: () => void;
      disabled?: boolean;
      note?: string;
    }
  | {
      kind: "sub";
      id: string;
      label: string;
      icon: LucideIcon;
      /** What is currently chosen inside, shown before the chevron. */
      detail?: string;
      /** The flyout's body: rows, and whatever sits between them. */
      render: () => React.ReactNode;
      /** Called when the flyout closes — e.g. to clear its search field. */
      onOpenChange?: (open: boolean) => void;
    };

export type PlusMenuSection = PlusMenuItem[];

/** Shared row recipe: 36px, `rounded-control`, accent fill under the cursor. */
export const plusMenuRowClass =
  "flex h-9 items-center gap-2.5 rounded-control px-2.5 text-ui font-medium text-foreground coarse:h-11";

/** The 16px glyph slot at the head of a row. */
export function PlusMenuGlyph({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One hairline between sections. */
export function PlusMenuSeparator({ className }: { className?: string }) {
  return <DropdownMenuSeparator className={cn("bg-border/70", className)} />;
}

/**
 * A row. A `DropdownMenuItem`, so arrow keys, typeahead and Enter/Space are
 * the menu's own. `checked` makes it a toggle (a `menuitemcheckbox` with a
 * decorative Switch) that keeps the menu open; `selected` makes it a radio
 * row that shows a check and closes on pick.
 */
export const PlusMenuRow = React.forwardRef<
  React.ElementRef<typeof DropdownMenuItem>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuItem>, "onSelect"> & {
    icon?: LucideIcon;
    checked?: boolean;
    selected?: boolean;
    note?: string;
    detail?: string;
    /** A brand mark or any element in place of the Lucide glyph. */
    leading?: React.ReactNode;
    onSelect?: () => void;
  }
>(function PlusMenuRow(
  { icon, checked, selected, note, detail, leading, className, children, onSelect, ...props },
  ref,
) {
  const toggle = checked !== undefined;
  const radio = selected !== undefined;
  return (
    <DropdownMenuItem
      ref={ref}
      role={toggle ? "menuitemcheckbox" : radio ? "menuitemradio" : "menuitem"}
      aria-checked={toggle ? checked : radio ? selected : undefined}
      onSelect={(event) => {
        // A toggle answers in place: the menu stays open so the next switch
        // is one press away, and the row itself is what changed.
        if (toggle) event.preventDefault();
        onSelect?.();
      }}
      className={cn(plusMenuRowClass, className)}
      {...props}
    >
      {leading ?? (icon ? <PlusMenuGlyph icon={icon} /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {detail && (
        <span className="max-w-[7rem] shrink-0 truncate font-mono text-caption text-muted-foreground">
          {detail}
        </span>
      )}
      {note ? (
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{note}</span>
      ) : toggle ? (
        <Switch checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
      ) : radio && selected ? (
        <StatusIcons.success aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      ) : null}
    </DropdownMenuItem>
  );
});

export function PlusMenu({
  open,
  onOpenChange,
  disabled,
  label,
  tooltip,
  sections,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** The trigger's accessible name — names what is on, for a screen reader. */
  label: string;
  tooltip: string;
  sections: PlusMenuSection[];
  className?: string;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              disabled={disabled}
              className={cn(composerIconButtonClass, "group", className)}
            >
              <Plus
                aria-hidden="true"
                className="size-4 transition-transform duration-base ease-out-strong group-data-[state=open]:rotate-45 motion-reduce:transition-none"
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        aria-label="Add"
        className="w-64 p-1.5"
      >
        {sections
          .filter((section) => section.length > 0)
          .map((section, i) => (
            <React.Fragment key={i}>
              {i > 0 && <PlusMenuSeparator />}
              {section.map((item) =>
                item.kind === "action" ? (
                  <PlusMenuRow
                    key={item.id}
                    icon={item.icon}
                    disabled={item.disabled}
                    note={item.note}
                    onSelect={item.onSelect}
                  >
                    {item.label}
                  </PlusMenuRow>
                ) : item.kind === "toggle" ? (
                  <PlusMenuRow
                    key={item.id}
                    icon={item.icon}
                    checked={item.checked}
                    disabled={item.disabled}
                    note={item.note}
                    onSelect={item.onToggle}
                  >
                    {item.label}
                  </PlusMenuRow>
                ) : (
                  <DropdownMenuSub key={item.id} onOpenChange={item.onOpenChange}>
                    <DropdownMenuSubTrigger className={plusMenuRowClass}>
                      <PlusMenuGlyph icon={item.icon} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.detail && (
                        <span className="mr-1 max-w-[6rem] shrink-0 truncate font-mono text-caption text-muted-foreground">
                          {item.detail}
                        </span>
                      )}
                    </DropdownMenuSubTrigger>
                    {/* Concentric with the root: the same 16px shell and p-1.5,
                        so the flyout's rows sit on the same 10px rung. */}
                    <DropdownMenuSubContent
                      sideOffset={6}
                      collisionPadding={16}
                      className="flex w-64 flex-col p-1.5"
                    >
                      {item.render()}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ),
              )}
            </React.Fragment>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
