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
 *
 * FULL INK BELONGS TO THE SELECTED ROW ALONE. Hover used to raise a row's ink
 * to `--foreground` as well as filling it, and the two fills are one rung
 * apart, so with the pointer in the column the row under it and the row you
 * are on looked the same — two "you are here"s. Hover is the fill now and
 * nothing else; selection is the deeper fill AND the full ink (31.8% → 10.8%
 * L in light), which is the step a glance can find.
 */
export function listRowClass(active: boolean) {
  return active
    ? "sidebar-row-selected text-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-hover";
}

/**
 * What a list row animates: its fill and its ink. The fill lands in 0ms and
 * leaves over the `fast` rung (spec §4.5 rule 6): the row under the pointer
 * is lit in the frame the pointer arrives, and the row it left fades back over
 * 120ms. A transition runs on the timing of the state it is going TO, so
 * `hover:duration-0` is the instant arrival and the rest state's 120 is the
 * departure. Both directions used to take 120, which on a quick pass down the
 * list left two or three rows lit at once, trailing the pointer.
 *
 * Colour and fill are Tier A (§4.7): they keep their timing under reduced
 * motion, so there is no `motion-reduce:` override here.
 */
export const LIST_ROW_TRANSITION =
  "transition-[background-color,color] duration-fast ease-out-soft hover:duration-0";

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
    // `mt-4` ABOVE the heading that owns the break, so the first section sits
    // on the scroller's own `pt-4` and every later one is separated from the
    // list it follows by the same 16px. `data-sidebar-section` is where the
    // well lands when it brings a row of this section into view: on the
    // heading, not on the row (app-sidebar.tsx, `revealOffset`).
    <div data-sidebar-section="" className="group/section mt-4 first:mt-0">
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
          className="group/heading flex h-7 min-w-0 flex-1 select-none items-center gap-1 rounded-control px-2 text-left text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground coarse:h-11"
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
              "size-3 shrink-0 transition-[opacity,transform] duration-base ease-in-out motion-reduce:transition-opacity",
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
          "min-h-0 overflow-hidden transition-opacity duration-base ease-out-soft",
          !open && "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}
