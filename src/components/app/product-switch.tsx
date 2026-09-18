"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";

import { SidebarMotionIcon, type SidebarMotionIconKind } from "@/components/app/sidebar-motion-icon";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PLANS, planRank } from "@/lib/plans";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientQuota } from "@/types/chat";

/* ────────────────────────────────────────────────────────────────────────────
 * THE ONE PRODUCT SWITCH.
 *
 * The rule, in one sentence: there is exactly one product switch, it lives in
 * the sidebar, and it is the only bounded track in the shell — page tabs are
 * underlines (`components/ui/surface-tabs.tsx`) and never wells.
 *
 * Juno used to ship three idioms for this one choice: a full-width
 * `SegmentedControl` in the expanded sidebar, two loose icon rows in the 64px
 * rail with no Chat row at all, and a dead centred `ChatWorkSwitcher`. Under
 * them Work and Code drew their view tabs in the SAME inset-well material, so
 * nothing said which control leaves the product and which changes the view.
 *
 * WHERE, and why not a centred header pill: switching products in Juno
 * *replaces the sidebar* — Chat's is Projects + Pinned + Recents, Code's is its
 * sessions and its own destinations in the same folds. ChatGPT can float a pill
 * in the content column because its modes do not change the left column; a Juno
 * pill there would be a control whose entire visible effect happens 250px to
 * its left, and it would have nowhere to live in the 64px rail or the 360px
 * phone bar. So the PLACEMENT and the tone are Claude's (sidebar, top,
 * 13px, tonal `--sidebar-accent` state, ~32px rows) and the SHAPE and the
 * gating are ChatGPT's (a compact hairline pill, icon + label, segments
 * abutting, a greyed segment with a sparkle for what your plan does not
 * include). What the content column gets from this is the opposite of a pill:
 * no band at the top of a page for a control that changes the column beside it.
 *
 * NOT `SegmentedControl`, for three reasons:
 *  (a) these are LINKS, so ⌘-click opens Code in a new tab and hover-preview
 *      and Back work — the one behaviour a product switch owes and that a
 *      `<button>` + `router.push` cannot give;
 *  (b) the sidebar recipe is deliberately not the page-track recipe
 *      `SegmentedControl` draws, and threading six overrides through a
 *      primitive with ~20 filter call sites would fork it by prop;
 *  (c) the plan gate and the ⌘⇧n hints belong at this call site.
 * `SegmentedControl` is untouched and keeps every one of its existing sites.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ProductSurface = "chat" | "code";

type PlanId = ClientQuota["plan"];

type Product = {
  id: ProductSurface;
  label: string;
  href: string;
  kind: SidebarMotionIconKind;
  chord: string;
  /**
   * The plan a surface needs. Read through `planRank` — the same seam every
   * other lock badge, picker and API gate in the product reads the policy
   * through — against the signed-in user's real plan, so the greyed segment
   * can never be a decoration: it appears if and only if the account cannot
   * open that route.
   *
   * Both surfaces are "FREE" today because Juno does not gate a product by
   * plan. The capability is built, not faked: the day Code (say) becomes a
   * paid surface, this one literal turns the segment greyed-with-a-sparkle and
   * points it at `/upgrade`, on every width, with nothing else to change.
   */
  minPlan: PlanId;
};

/**
 * THE TWO SURFACES. Order is Chat · Code — talk, then build — which is the
 * order the chords ⌘⇧1/2 are bound in and the order the rail stacks.
 *
 * There used to be a third, and a second list (`SIDEBAR_PRODUCTS`) that
 * filtered it straight back out of this control while the palette, the chords
 * and `productOf` went on reasoning about it as a place. Work is not a place
 * (docs/design/TWO_PRODUCTS.md §2): it is what a conversation does when the ask
 * is big, so it is something a chat CARRIES, and a row in this switcher was
 * the product telling people to go somewhere to delegate. One list now, and
 * the filter that hid a member of it went with the member.
 *
 * Exported so `use-global-shortcuts` and the shell read one list rather than
 * three copies of it. (The macOS app binds its own order to ⌘1/2/3 — see
 * native/macOS/.../DesktopProductMode.swift; that split is recorded in the
 * spec's risks, and the web cannot take ⌘1–⌘3, which are browser tab
 * switching.)
 *
 * Where the third one went: the "+" menu of the chat composer, as "Do this as
 * a task" beside Deep research. You hand Juno an errand with a finish line
 * instead of opening a conversation, and that choice belongs where you write
 * the ask — not in the column you navigate with. The run it starts is drawn
 * inside the conversation that started it. The pill that briefly stood between
 * those two arrangements was navigation wearing a toggle's clothes, and it is
 * gone with the rest.
 */
export const PRODUCTS = [
  { id: "chat", label: "Chat", href: "/chat", kind: "home", chord: "⌘⇧1", minPlan: "FREE" },
  { id: "code", label: "Code", href: "/code", kind: "code", chord: "⌘⇧2", minPlan: "FREE" },
] as const satisfies readonly Product[];

/**
 * Which product the reader is inside.
 *
 * A Juno Code session is SERVED at `/chat/<id>` — see
 * `app/(app)/chat/[id]/page.tsx`, which renders `<CodeSessionView>` when
 * `conversation.kind === "code"`. Path alone therefore said "Chat" for the
 * entire time somebody was inside a Code session: the switcher was wrong
 * precisely when the reader was doing the thing it names. The conversation's
 * own kind is the tiebreak.
 *
 * THE TIEBREAK IS ANCHORED TO `/chat/<id>`, and that anchor carries as much
 * weight as the tiebreak itself. `activeConversationId` is set when a
 * conversation view mounts and is never cleared when it unmounts, so its kind
 * outlives the route that produced it. Unanchored, opening one Code session
 * would make every later /library, /projects, /design or /settings draw Code's
 * column — no Library, no Projects, not one chat row — and the switch would
 * claim Code while the reader stood on a Chat page. The kind answers "which
 * product is THIS CONVERSATION", so it may only speak while a conversation is
 * what the reader is looking at. (The mobile title six lines up in `AppShell`
 * learned the same lesson from the same stale id.)
 */
export function productOf(
  pathname: string | null,
  activeConversationKind?: "chat" | "code" | null,
): ProductSurface {
  if (pathname?.startsWith("/code")) return "code";
  if (pathname?.startsWith("/chat/") && activeConversationKind === "code") return "code";
  return "chat";
}

/** A surface the plan does not include is SHOWN, never hidden — a missing
 *  segment reads as a missing feature. It renders at reduced ink with a
 *  sparkle in place of its product mark and routes to `/upgrade`. */
function isLocked(product: Product, plan: PlanId | undefined): boolean {
  if (!plan) return false;
  return planRank(plan) < planRank(product.minPlan);
}

export function ProductSwitch({
  collapsed = false,
  active,
  plan,
  onNavigate,
}: {
  collapsed?: boolean;
  active: ProductSurface;
  /** The signed-in account's plan, from `useApp().quota`. */
  plan?: PlanId;
  onNavigate?: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  // MANDATORY scoping: the sidebar mounts twice at phone width (the
  // `hidden md:block` aside plus the drawer Sheet) inside one fixed
  // `<LayoutGroup id="juno-sidebar">`. A global-string `layoutId` would make
  // one thumb try to fly across to the other tree.
  const thumbId = `${React.useId()}-product-thumb`;
  const thumbTransition = reduceMotion ? { duration: 0 } : spring.standard;

  if (collapsed) {
    return (
      // No outer hairline box at rail width: 64px minus `px-2.5` leaves 44px,
      // and a `p-0.5` box inside it would eat the tap target for a border that
      // only has to say "these two are a different kind of thing". A
      // separator hairline says it for free, and it is what the footer uses.
      <nav aria-label="Juno products" className="pt-2">
        <div className="flex flex-col items-center gap-1 px-2.5 pb-2">
          {PRODUCTS.map((product) => (
            <RailItem
              key={product.id}
              product={product}
              active={product.id === active}
              locked={isLocked(product, plan)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div className="mx-2.5 border-b border-sidebar-border/70" aria-hidden="true" />
      </nav>
    );
  }

  return (
    /*
     * A 28px ICON PAIR IN THE BRAND ROW, not a full-width labelled pill.
     *
     * The pill was two 36px rows' worth of column — a `pb-6 pt-3` block with
     * two labelled segments — spent on a control you press perhaps twice a
     * session, directly above the field and the list you use constantly. It
     * was also, at 100% of the panel's width, the widest object in it. The
     * reference puts the same choice in the header beside the wordmark at
     * ~64×28: the two glyphs ARE the labels, because there are exactly two
     * and one of them is a speech bubble.
     *
     * That buys back ~72px at the top of the column — more than the search
     * field costs — which is the room the field was argued out of the panel
     * to save in the first place.
     *
     * The thumb still travels (same `layoutId`, same spring), so the control
     * that was the panel's one moving selection keeps moving. What it loses
     * is the words, and only because at two segments they are redundant with
     * the marks; the accessible name still carries them, and so does the
     * tooltip, which is the one place a label is worth its pixels.
     */
    <nav aria-label="Juno products" className="flex shrink-0 items-center rounded-control bg-sidebar-accent/70 p-0.5">
      {PRODUCTS.map((product) => (
        <Segment
          key={product.id}
          product={product}
          active={product.id === active}
          locked={isLocked(product, plan)}
          thumbId={thumbId}
          thumbTransition={thumbTransition}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function Segment({
  product,
  active,
  locked,
  thumbId,
  thumbTransition,
  onNavigate,
}: {
  product: Product;
  active: boolean;
  locked: boolean;
  thumbId: string;
  thumbTransition: object;
  onNavigate?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
    <Link
      href={locked ? "/upgrade" : product.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // ALWAYS named, because the box no longer carries the word. It was
      // `accessibleName()`, which returns undefined for an open segment on the
      // reasoning that the visible label already named it — true then, and it
      // would have left both segments unnamed now.
      aria-label={accessibleName(product, locked) ?? product.label}
      className={cn(
        // `.pressable` carries the press dip AND the colour transitions (see
        // globals.css) — a `transition-colors` utility after it would override
        // the shorthand and un-animate the press.
        // 32×24, NOT a square — measured off the reference, whose control is
        // 68.2 × 28.1 overall: 2px of padding around two 32.1 × 24.1 cells.
        // A square reads as a button; a wide cell reads as one half of a
        // track, which is what a two-position switch is. The label is gone
        // from the box and lives in the accessible name and the tooltip.
        "pressable group relative flex h-6 w-8 shrink-0 items-center justify-center rounded-md",
        "focus-visible:outline-offset-0 motion-reduce:active:scale-100",
        // 44px targets in the drawer, which is the only place this is touched.
        "coarse:h-11 coarse:w-12",
        locked
          ? "text-muted-foreground/55 hover:text-muted-foreground"
          : active
            ? "text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {active && (
        // Tonal, no border, no shadow (FLAT_UI §4): the sidebar's own active-row
        // recipe, which is the whole reason this control belongs in the sidebar.
        // `spring.standard` — the documented cross-platform settle `JunoMotion`
        // mirrors — rather than a hand-tuned stiffness/damping triple, so travel
        // means the same thing here as it does under the page header.
        <motion.span
          layoutId={thumbId}
          aria-hidden="true"
          transition={thumbTransition}
          className="absolute inset-0 rounded-md bg-sidebar shadow-soft"
          // framer has to keep the corners true while it scales the box.
          style={{ borderRadius: 8 }}
        />
      )}
      {/* Reduced ink plus a sparkle is ChatGPT's own "not on your plan" mark,
          and it replaces the product glyph rather than joining it, so a gated
          segment is exactly as wide as an open one — a width change here would
          move the thumb for a reason that has nothing to do with the reader. */}
      {/* `size-3.5` (14px), not `size-4`. Measured in the reference, the glyphs
          inside this control draw ~12.8px of ink; a 16px lucide box draws ~14.4,
          which is the size of a NAV row's mark — and a switch cell is 24px tall
          against a nav row's 32, so the same mark inside it reads as crowding
          the cell rather than sitting in it. The optical stroke ladder in
          globals.css thins the stroke to match, so this gets lighter as well as
          smaller, which is what keeps it from looking like a shrunken nav icon. */}
      {locked ? (
        <Sparkles className="relative size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <SidebarMotionIcon kind={product.kind} className="relative size-3.5 shrink-0" />
      )}
      {/* THE ONLY TRAILING MARK THIS SEGMENT EVER HAD IS GONE. It was a dot
          counting the Work items blocked on the reader, and it was the one
          thing in the shell that made a product switch a notification surface.
          The signal did not disappear with Work — it moved to the sidebar's
          "Needs you" fold, which is where the rows it counts actually are, so
          pressing it triages them instead of moving you to a page that then
          has to tell you the same number again. */}
    </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {product.label}
        <Kbd className="ml-1.5">{product.chord}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function RailItem({
  product,
  active,
  locked,
  onNavigate,
}: {
  product: Product;
  active: boolean;
  locked: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={locked ? "/upgrade" : product.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          // Always named at rail width: there is no visible label to read.
          aria-label={accessibleName(product, locked) ?? product.label}
          className={cn(
            // A plain fill, no travelling thumb. The rows below this — Search,
            // New chat, Library — mark themselves with exactly this fill; a
            // fill that glides between stacked rows above a stack of fills that
            // do not reads as a lift, not as a switch.
            "group relative flex size-11 items-center justify-center rounded-control transition-colors duration-fast ease-out-soft",
            locked
              ? "text-muted-foreground/55 hover:bg-sidebar-accent hover:text-muted-foreground"
              : active
                ? "bg-sidebar-accent text-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          {/* Byte-identical to NavRow's glyph box, so the rail is one optical
              rhythm from the products down to the footer — which the comment
              claimed while the box passed no size, letting SidebarMotionIcon
              fall back to its own `size-4` (16px) directly above nav glyphs at
              18. `[&_svg]:size-4.5` is what makes the sentence true. */}
          <span className="flex size-5 items-center justify-center [&_svg]:size-4.5">
            {locked ? (
              <Sparkles aria-hidden="true" />
            ) : (
              <SidebarMotionIcon kind={product.kind} />
            )}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        {product.label}
        {locked ? (
          <span className="ml-1.5 text-muted-foreground">{PLANS[product.minPlan].name}</span>
        ) : (
          <Kbd className="ml-1.5">{product.chord}</Kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The label a screen reader hears: the product, plus whatever the drawing says
 *  silently — today only the plan behind the sparkle. `undefined` when the
 *  visible label already says everything. */
function accessibleName(product: Product, locked: boolean): string | undefined {
  if (locked) return `${product.label}, upgrade to ${PLANS[product.minPlan].name}`;
  return undefined;
}
