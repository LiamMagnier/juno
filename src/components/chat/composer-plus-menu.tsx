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
 * The composer's `+` menu (docs/design/FLAT_UI.md §3).
 *
 * One `.surface-float` menu at `rounded-popover` with p-1.5, so its 36px rows
 * sit concentric at `rounded-control`. Three groups separated by a hairline
 * and nothing else — what you bring in, where this chat sits, what is armed
 * for the message — with no eyebrows naming them, because "Add files or
 * photos" already says what kind of row it is. Tool rows are checkmark rows
 * that keep the menu open when pressed; Project and Connectors are real Radix
 * submenus that fly out to the right on the same recipe, with Radix's own
 * pointer grace area so a diagonal move from the trigger into the flyout
 * never closes it.
 *
 * The trigger is a bare `+`. It used to carry a coral count badge, but the
 * count included sticky preferences (web search, memory) that are on for
 * everyone by default, so every fresh user saw a "2" or "3" pinned to the
 * button on every message forever — a badge that is never zero is a
 * decoration, and it spent the accent on something that was not state. What
 * is armed for THIS message (deep research) shows as its own pill beside
 * the trigger; the accessible name still lists everything that is on.
 * Small screens drill into subpanels in place to keep every row reachable.
 *
 * Keyboard (mostly native to the menu): ↑/↓ move, Enter/Space activate or
 * toggle, → opens a submenu, ← closes it, Esc closes everything — and at
 * compact width → drills in and ← / Esc step back out of a panel first.
 */

export type PlusMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      icon: LucideIcon;
      onSelect: () => void;
      disabled?: boolean;
      /** A short mono figure after the label — e.g. the row's shortcut. */
      detail?: string;
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
      /** A short mono figure before the check — what turning it on will do. */
      detail?: string;
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
  "flex min-h-9 items-center gap-2.5 rounded-control px-2.5 py-1.5 text-ui text-foreground coarse:min-h-11";

/** The 16px glyph slot at the head of a row. */
export function PlusMenuGlyph({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One hairline between sections. */
export function PlusMenuSeparator({ className }: { className?: string }) {
  return <DropdownMenuSeparator className={className} />;
}

/**
 * A row. A `DropdownMenuItem`, so arrow keys, typeahead and Enter/Space are
 * the menu's own. `checked` makes it a toggle (a `menuitemcheckbox` that shows
 * a tick) and keeps the menu open; `selected` makes it a radio row that shows
 * the same tick and closes on pick.
 */
export const PlusMenuRow = React.forwardRef<
  React.ElementRef<typeof DropdownMenuItem>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuItem>, "onSelect"> & {
    icon?: LucideIcon;
    checked?: boolean;
    selected?: boolean;
    note?: string;
    detail?: string;
    /** A second, muted line under the label. */
    description?: string;
    /** Keep the menu open after this row is picked (a radio that sets a mode, say). */
    keepOpen?: boolean;
    /** A brand mark or any element in place of the Lucide glyph. */
    leading?: React.ReactNode;
    onSelect?: () => void;
  }
>(function PlusMenuRow(
  { icon, checked, selected, note, detail, description, keepOpen, leading, className, children, onSelect, ...props },
  ref,
) {
  const toggle = checked !== undefined;
  const radio = selected !== undefined;
  const ticked = toggle ? checked : radio ? selected : false;
  return (
    <DropdownMenuItem
      ref={ref}
      role={toggle ? "menuitemcheckbox" : radio ? "menuitemradio" : "menuitem"}
      aria-checked={toggle ? checked : radio ? selected : undefined}
      onSelect={(event) => {
        // A toggle answers in place: the menu stays open so the next switch
        // is one press away, and the row itself is what changed.
        if (toggle || keepOpen) event.preventDefault();
        onSelect?.();
      }}
      className={cn(plusMenuRowClass, description && "items-start py-2", className)}
      {...props}
    >
      {leading ?? (icon ? <PlusMenuGlyph icon={icon} className={description ? "mt-0.5" : undefined} /> : null)}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description && (
          <span className="mt-0.5 block truncate text-caption font-normal text-muted-foreground">{description}</span>
        )}
      </span>
      {detail && (
        <span className="max-w-[7rem] shrink-0 truncate font-mono text-caption text-muted-foreground">
          {detail}
        </span>
      )}
      {note ? (
        <span className="max-w-28 text-right text-caption text-muted-foreground">{note}</span>
      ) : ticked ? (
        // A tick, not a Switch. This slot used to render the real `Switch`
        // component (aria-hidden, pointer-events-none) so that the menu and
        // the "@" palette would stop drawing two different toggles for one
        // idea. They agree again — on the mark Claude and ChatGPT both use —
        // because a 32×20 track inside a 36px menu row reads as a settings
        // panel that wandered into the composer, and it was the heaviest
        // object in a menu whose every other row carries a 16px glyph. The
        // "@" palette (composer.tsx) moved to this same tick in the same
        // change; if one of them ever grows a switch again, the drift is back.
        // An OFF row renders nothing here: `aria-checked` on the row is the
        // state, and the tick is `aria-hidden` decoration of it.
        <StatusIcons.success
          aria-hidden="true"
          className="size-3.5 shrink-0 text-primary motion-safe:animate-check-morph"
        />
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
  const drillIn = (item: Extract<PlusMenuItem, { kind: "sub" }>) => {
    setPanelId(item.id);
    item.onOpenChange?.(true);
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
              className={cn(composerIconButtonClass, "group relative", className)}
            >
              <Plus aria-hidden="true" className="size-4" />
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
        // Escape can't ride the onKeyDown above: Radix listens for it with a
        // `capture: true` listener on the DOCUMENT (react-use-escape-keydown),
        // which runs before any React handler on this content, so the menu
        // would already be closing. This is the hook that runs first, and
        // preventing it here stops Radix's own dismiss (composeEventHandlers
        // checks defaultPrevented). Drilled in at phone width, Escape is a
        // step back out of the panel; at the root it closes the menu as always.
        onEscapeKeyDown={(event) => {
          if (!compact || !panelId) return;
          if (event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          back();
        }}
        className="w-72 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1.5"
      >
        {compact && panel?.kind === "sub" ? (
          // The panel arrives from the right and the root list comes back from
          // the left. `animate-stage-in` multiplies its travel by
          // --motion-shift, so reduced motion gets the fade without the slide.
          <div className="animate-stage-in" style={{ "--stage-dx": "12px" } as React.CSSProperties}>
            <DropdownMenuItem data-menu-back aria-label="Back to Add" className={plusMenuRowClass} onSelect={(event) => { event.preventDefault(); back(); }}>
              <ArrowLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{panel.label}
            </DropdownMenuItem>
            <PlusMenuSeparator />
            {panel.render()}
          </div>
        ) : (
          <div
            key={compact ? "root" : undefined}
            className={compact ? "animate-stage-in" : undefined}
            style={compact ? ({ "--stage-dx": "-12px" } as React.CSSProperties) : undefined}
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
                        detail={item.detail}
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
                        detail={item.detail}
                        onSelect={item.onToggle}
                      >
                        {item.label}
                      </PlusMenuRow>
                    ) : compact ? (
                      <DropdownMenuItem
                        key={item.id}
                        data-panel-id={item.id}
                        aria-haspopup="menu"
                        className={plusMenuRowClass}
                        // → drills in, matching the desktop submenu it stands
                        // in for; without it the panel was mouse-only in one
                        // direction while ← already stepped back out.
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowRight") return;
                          event.preventDefault();
                          drillIn(item);
                        }}
                        onSelect={(event) => { event.preventDefault(); drillIn(item); }}
                      >
                        <PlusMenuGlyph icon={item.icon} />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.detail && (
                          <span className="max-w-[6rem] shrink-0 truncate font-mono text-caption text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/60" />
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
                          className="flex w-72 flex-col p-1.5"
                        >
                          {item.render()}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ),
                  )}
                </React.Fragment>
              ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
