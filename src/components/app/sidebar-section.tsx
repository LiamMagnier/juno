"use client";

/**
 * The sidebar's list recipes, shared by the Chat lists in `AppSidebar` and the
 * Code work list (`code-work-list.tsx`), so the two products draw one column:
 * the same section heading, the same fold, the same row fills.
 */
import * as React from "react";
import { ChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Selection for the rows that are NOT the travelling fill: conversations,
 * projects, a project's own chats.
 *
 * They keep a CSS fill that cuts rather than travels, and that is deliberate.
 * The four navigation rows are a fixed, always-mounted ladder eight pixels
 * apart, so a fill sliding between them reads as one object moving. This list
 * is a scroller: the row you leave can be four hundred pixels up the column or
 * unmounted entirely, and a fill flying that far — or vanishing mid-flight
 * because its origin scrolled out of the well — is a projectile, not a
 * correction. Same recipe, same fill, no travel.
 */
export function listRowClass(active: boolean) {
  return active
    ? "sidebar-row-selected text-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground";
}

/**
 * What a list row animates: its fill and its ink, on the `fast` rung (120ms).
 * This is a property changing on a row the pointer has just left or landed
 * on, and the two rows do it at once: the one you left gives its fill up over
 * exactly the window the one you chose takes it on, so the state crosses
 * rather than blinking.
 */
export const LIST_ROW_TRANSITION =
  "transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none";

export function Section({
  label,
  children,
  isCollapsed,
  onToggleCollapse,
  action,
}: {
  label: string;
  children: React.ReactNode;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  action?: React.ReactNode;
}) {
  return (
    // `mt-5` ABOVE the heading that owns the break, so the first section sits
    // on the scroller's own `pt-5` and every later one is separated from the
    // list it follows by the same 20px.
    <div className="group/section mt-5 first:mt-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          /* `px-2`: 16px from the panel edge, measured at 15.2 in the
             reference, and NOT the 46px the nav labels sit at.
             THE COLUMN HAS TWO TEXT EDGES ON PURPOSE. 46px is where a label
             lands when a glyph precedes it, and every destination has one.
             A section heading has no glyph and neither do the conversation
             rows under it, so both sit at 16: the heading on the same edge as
             the list it heads, which is the alignment that actually matters.

             A plain button, not `Pressable kind="row"`: a heading is a label
             on the list, and the row press tone (`active:bg-selected`, a page
             fill) and hover fill made it flash like one more row. Only its
             ink answers the pointer. */
          className="group/heading flex h-7 min-w-0 flex-1 select-none items-center gap-1 rounded-control px-2 text-left text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none coarse:h-11"
        >
          {/* ONE SECTION VOICE: sentence-case sans at the `label` rung (12px,
              weight 500), muted, two steps under the 14px rows. Quiet enough
              to be a label ON the list rather than an object beside it, which
              is how the reference sets them. */}
          <span className="shell-annot min-w-0 truncate">{label}</span>
          {/* The chevron appears with the pointer or focus, and stays while
              the section is folded, because folded is a state the reader has
              to be able to see. `ease-in-out` on the `base` rung: both ends of
              the turn are on screen, and the rows under it unfold over the
              same 220ms. */}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-[opacity,transform] duration-base ease-in-out motion-reduce:transition-none",
              isCollapsed
                ? "-rotate-90"
                : "opacity-0 group-hover/section:opacity-100 group-focus-visible/heading:opacity-100 coarse:opacity-100"
            )}
          />
        </button>
        {action != null && <span className="flex shrink-0 items-center">{action}</span>}
      </div>
      <Disclosure open={!isCollapsed}>
        <div className="pt-1">{children}</div>
      </Disclosure>
    </div>
  );
}

/** The panel's one fold: a grid-rows sweep so rows never pop. */
export function Disclosure({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,visibility] duration-base ease-out-soft motion-reduce:transition-none",
        open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          !open && "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}
