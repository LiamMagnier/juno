"use client";

import * as React from "react";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
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
 * The trigger shows the number of enabled tools; individual states live here.
 * Small screens drill into subpanels in place to keep every row reachable.
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
  "flex min-h-10 items-center gap-3 rounded-control px-3 py-2 text-ui font-medium text-foreground coarse:min-h-11";

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
        <span className="max-w-28 text-right text-caption text-muted-foreground">{note}</span>
      ) : toggle ? (
        <span aria-hidden="true" className={cn("pointer-events-none flex h-5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors duration-fast motion-reduce:transition-none", checked ? "bg-primary" : "bg-muted")}>
          <span className={cn("size-4 rounded-full bg-background transition-transform duration-fast motion-reduce:transition-none", checked && "translate-x-3")} />
        </span>
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
  const activeCount = sections.flat().filter(item => item.kind === "toggle" && item.checked).length;
  const [compact, setCompact] = React.useState(false);
  const [panelId, setPanelId] = React.useState<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const panel = sections.flat().find(item => item.kind === "sub" && item.id === panelId);
  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  React.useEffect(() => {
    if (compact && panelId) menuRef.current?.querySelector<HTMLElement>("input, [data-menu-back]")?.focus();
  }, [compact, panelId]);
  const back = () => {
    if (panel?.kind === "sub") panel.onOpenChange?.(false);
    setPanelId(null);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-panel-id="${panelId}"]`)?.focus());
  };
  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      if (!next) { setPanelId(null); if (panel?.kind === "sub") panel.onOpenChange?.(false); }
      onOpenChange(next);
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              disabled={disabled}
              className={cn(composerIconButtonClass, "group w-auto gap-1.5 px-2.5 coarse:w-auto", className)}
            >
              <Plus
                aria-hidden="true"
                className="size-4 transition-transform duration-base ease-out-strong group-data-[state=open]:rotate-45 motion-reduce:transition-none"
              />
              {activeCount > 0 && <span aria-hidden="true" className="text-caption font-medium"><span className="hidden sm:inline">Tools · </span>{activeCount}</span>}
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
        ref={menuRef}
        aria-label={compact && panel ? panel.label : "Add"}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" && panelId && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); back(); } }}
        className="w-72 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1.5"
      >
        {compact && panel?.kind === "sub" ? <>
          <DropdownMenuItem data-menu-back aria-label="Back to Add" className={plusMenuRowClass} onSelect={(event) => { event.preventDefault(); back(); }}>
            <ArrowLeft className="size-4" aria-hidden="true" />{panel.label}
          </DropdownMenuItem>
          <PlusMenuSeparator />
          {panel.render()}
        </> : sections
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
                ) : compact ? (
                  <DropdownMenuItem key={item.id} data-panel-id={item.id} className={plusMenuRowClass} onSelect={(event) => {
                    event.preventDefault(); setPanelId(item.id); item.onOpenChange?.(true);
                  }}>
                    <PlusMenuGlyph icon={item.icon} /><span className="flex-1">{item.label}</span><ChevronRight aria-hidden="true" className="size-4" />
                  </DropdownMenuItem>
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
