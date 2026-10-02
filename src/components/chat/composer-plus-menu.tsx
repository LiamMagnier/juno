"use client";

import * as React from "react";
import { ArrowLeft, ChevronRight, Plus } from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";

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
import { MENU_W_WIDE, menuRowClass } from "@/components/ui/menu-recipe";
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
 * One `.surface-float` menu on the shared recipe (`menu-recipe.ts`): a 14px
 * shell with p-1, so its 32px rows sit concentric at `rounded-control`. The
 * same shell and the same row as every kebab in the product — this menu used
 * to be a near-copy of that one, differing only in the numbers nobody chooses.
 * Three groups separated by a hairline
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
      icon: IconComponent;
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
      icon: IconComponent;
      checked: boolean;
      onToggle: () => void;
      disabled?: boolean;
      note?: string;
      /** A short mono figure before the check — what turning it on will do. */
      detail?: string;
      /** A plain second line under a branded name: its descriptor (D-038). */
      description?: string;
      /** The name a screen reader hears when it differs from the label. */
      ariaLabel?: string;
    }
  | {
      kind: "sub";
      id: string;
      label: string;
      icon: IconComponent;
      /** What is currently chosen inside, shown before the chevron. */
      detail?: string;
      /** The flyout's body: rows, and whatever sits between them. */
      render: () => React.ReactNode;
      /** Called when the flyout closes — e.g. to clear its search field. */
      onOpenChange?: (open: boolean) => void;
    };

export type PlusMenuSection = PlusMenuItem[];

/**
 * The row. `menu-recipe.ts` now, not a recipe of this menu's own.
 *
 * It used to be a near-copy — same radius, same gap, same 13px type — that
 * differed from DropdownMenu's row in exactly the ways nobody chooses: 36px
 * against 32, and a 16px glyph against 18. Which meant the two menus a person
 * opens most in this product, often within seconds of each other, were
 * visibly two different objects. They are one object now; anything this menu
 * needs on top is stated here, beside the rows that need it.
 */
export const plusMenuRowClass = menuRowClass;

/** The 16px glyph slot at the head of a row. */
export function PlusMenuGlyph({ icon: Icon, className }: { icon: IconComponent; className?: string }) {
  // No size and no ink stated: the row's recipe supplies both (16px, muted) and
  // does it for every menu in the product, so a glyph here and a glyph in a row
  // kebab cannot drift apart again. `className` still wins where a call site
  // means it to — that is what the recipe's :not() guards are for.
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />;
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
    icon?: IconComponent;
    checked?: boolean;
    selected?: boolean;
    note?: string;
    detail?: string;
    /** A second, muted line under the label. */
    description?: string;
    /** Keep the menu open after this row is picked (a radio that sets a mode, say). */
    keepOpen?: boolean;
    /** A brand mark or any element in place of the set's glyph. */
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
      ) : toggle || radio ? (
        // A tick, not a Switch. This slot used to render the real `Switch`
        // component (aria-hidden, pointer-events-none) so that the menu and
        // the "@" palette would stop drawing two different toggles for one
        // idea. They agree again — on the mark Claude and ChatGPT both use —
        // because a 32×20 track inside a 36px menu row reads as a settings
        // panel that wandered into the composer, and it was the heaviest
        // object in a menu whose every other row carries a 16px glyph. The
        // "@" palette (composer.tsx) moved to this same tick in the same
        // change; if one of them ever grows a switch again, the drift is back.
        //
        // The slot is kept on an OFF row and the tick CROSS-FADES in and out
        // of it, on the same recipe DropdownMenu's own indicator uses (fade +
        // scale on --dur-fast, leaving on the accelerate; the resting scale
        // reads --motion-scale-from, so the reduced tier keeps the fade). It
        // used to be mounted on and unmounted off, so switching a tool off
        // made the mark vanish in one frame and the label reflow into its
        // space, and every ON row replayed a spring on every menu open.
        // `aria-checked` on the row is the state; the tick is `aria-hidden`
        // decoration of it.
        <span
          aria-hidden="true"
          className={cn(
            // The curve is chosen, not stacked: tailwind-merge cannot tell
            // `ease-out-soft` and `ease-in` apart as one group, so both
            // survived and the later rule in the sheet always won.
            "grid size-3.5 shrink-0 place-items-center transition-[opacity,transform] duration-fast",
            ticked ? "ease-out-soft" : "opacity-0 ease-in [transform:scale(var(--motion-scale-from,0.6))]",
          )}
        >
          <StatusIcons.success className="size-3.5 text-primary" />
        </span>
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
        // No padding restated: the shell's own p-1 is what makes its 14px edge
        // concentric with the 10px rows inside it, and a p-1.5 here was quietly
        // breaking that for the one menu people open most.
        className={cn(MENU_W_WIDE, "max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto")}
      >
        {compact && panel?.kind === "sub" ? (
          // The panel arrives from the right and the root list comes back from
          // the left. `animate-stage-in` multiplies its travel by
          // --motion-shift, so reduced motion gets the fade without the slide.
          <div className="animate-stage-in" style={{ "--stage-dx": "12px" } as React.CSSProperties}>
            <DropdownMenuItem data-menu-back aria-label="Back to Add" className={plusMenuRowClass} onSelect={(event) => { event.preventDefault(); back(); }}>
              {/* 16px and no ink stated — the row recipe's glyph, like every
                  other row in this menu (it was a 14px outlier). */}
              <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />{panel.label}
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
                        description={item.description}
                        aria-label={item.ariaLabel}
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
                        {/* Concentric with the root because it IS the root's
                            shell — SubContent and Content are one recipe — so
                            only the width is stated here. */}
                        <DropdownMenuSubContent
                          sideOffset={6}
                          collisionPadding={16}
                          className={cn("flex flex-col", MENU_W_WIDE)}
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
