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
 * *replaces the sidebar* — Chat's is Projects + Pinned + Recents, Work's and
 * Code's are different lists on different route families. ChatGPT can float a
 * pill in the content column because its modes do not change the left column;
 * a Juno pill there would be a control whose entire visible effect happens
 * 250px to its left, and it would have nowhere to live in the 64px rail or the
 * 360px phone bar. So the PLACEMENT and the tone are Claude's (sidebar, top,
 * 13px, tonal `--sidebar-accent` state, ~32px rows) and the SHAPE and the
 * gating are ChatGPT's (a compact hairline pill, icon + label, segments
 * abutting, a greyed segment with a sparkle for what your plan does not
 * include). What the content column gets from this is the opposite of a pill:
 * the empty 56px band on `/work` is deleted.
 *
 * NOT `SegmentedControl`, for three reasons:
 *  (a) these are LINKS, so ⌘-click opens Code in a new tab and hover-preview
 *      and Back work — the one behaviour a product switch owes and that a
 *      `<button>` + `router.push` cannot give;
 *  (b) the sidebar recipe is deliberately not the page-track recipe
 *      `SegmentedControl` draws, and threading six overrides through a
 *      primitive with ~20 filter call sites would fork it by prop;
 *  (c) the "needs you" dot, the plan gate and the ⌘⇧n hints belong at this
 *      call site.
 * `SegmentedControl` is untouched and keeps every one of its existing sites.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ProductSurface = "chat" | "work" | "code";

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
   * All three surfaces are "FREE" today because Juno does not gate a product
   * by plan. The capability is built, not faked: the day Code (say) becomes a
   * paid surface, this one literal turns the segment greyed-with-a-sparkle and
   * points it at `/upgrade`, on every width, with nothing else to change.
   */
  minPlan: PlanId;
};

/**
 * Order is Chat · Work · Code — talk, then delegate, then build. It is the
 * order the chords ⌘⇧1/2/3 are bound in and the order the rail stacks.
 *
 * Exported so `use-global-shortcuts` and the shell read one list rather than
 * three copies of it. (The macOS app declares Chat · Code · Work on ⌘1/2/3 —
 * see native/macOS/.../DesktopProductMode.swift. That split is recorded in the
 * spec's risks; the web cannot take ⌘1–⌘3, which are browser tab switching.)
 */
export const PRODUCTS = [
  { id: "chat", label: "Chat", href: "/chat", kind: "home", chord: "⌘⇧1", minPlan: "FREE" },
  { id: "work", label: "Work", href: "/work", kind: "work", chord: "⌘⇧2", minPlan: "FREE" },
  { id: "code", label: "Code", href: "/code", kind: "code", chord: "⌘⇧3", minPlan: "FREE" },
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
 */
export function productOf(
  pathname: string | null,
  activeConversationKind?: "chat" | "code" | null,
): ProductSurface {
  if (pathname?.startsWith("/code")) return "code";
  if (pathname?.startsWith("/work")) return "work";
  if (activeConversationKind === "code") return "code";
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
  needsYou,
  plan,
  onNavigate,
}: {
  collapsed?: boolean;
  active: ProductSurface;
  /** Work items blocked on the reader. Drawn as a dot, announced as a number. */
  needsYou?: number | null;
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
      // only has to say "these three are a different kind of thing". A
      // separator hairline says it for free, and it is what the footer uses.
      <nav aria-label="Juno products" className="pt-2">
        <div className="flex flex-col items-center gap-1 px-2.5 pb-2">
          {PRODUCTS.map((product) => (
            <RailItem
              key={product.id}
              product={product}
              active={product.id === active}
              locked={isLocked(product, plan)}
              needsYou={product.id === "work" ? needsYou ?? 0 : 0}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div className="mx-2.5 border-b border-sidebar-border/70" aria-hidden="true" />
      </nav>
    );
  }

  return (
    // 8px is the one vertical edge every interactive box in this column already
    // shares (Search, New chat, the Primary nav, More, the footer are all
    // `px-2`); the brand row keeps `px-3` because it is type, not a box.
    <nav aria-label="Juno products" className="px-2 pb-2 pt-2">
      {/*
       * A hairline and a transparent fill, NOT `.surface-inset`. Two reasons,
       * both load-bearing:
       *  · `.surface-inset` paints `--background`, which is LIGHTER than
       *    `--sidebar` in both themes (97.2 vs 95.5 light, 11.5 vs 9.5 dark),
       *    so the "recessed well" sat up off the panel as a pale plate — a
       *    control drawn as the opposite of what it meant.
       *  · a surface class must never be paired with `bg-*`/`border-*`
       *    utilities (globals.css: components-layer classes silently lose), so
       *    a track that needs its own border carries no surface class at all.
       * `gap-0`: the segments abut, ChatGPT-style, so the thumb travels edge to
       * edge with no dead 4px between cells. Concentric: outer `rounded-field`
       * 12 = inner `rounded-control` 10 + `p-0.5` 2.
       */}
      <div className="relative grid grid-cols-3 gap-0 rounded-field border border-sidebar-border bg-transparent p-0.5">
        {PRODUCTS.map((product) => (
          <Segment
            key={product.id}
            product={product}
            active={product.id === active}
            locked={isLocked(product, plan)}
            needsYou={product.id === "work" ? needsYou ?? 0 : 0}
            thumbId={thumbId}
            thumbTransition={thumbTransition}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}

function Segment({
  product,
  active,
  locked,
  needsYou,
  thumbId,
  thumbTransition,
  onNavigate,
}: {
  product: Product;
  active: boolean;
  locked: boolean;
  needsYou: number;
  thumbId: string;
  thumbTransition: object;
  onNavigate?: () => void;
}) {
  const showDot = product.id === "work" && needsYou > 0 && !active;
  return (
    <Link
      href={locked ? "/upgrade" : product.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={accessibleName(product, locked, needsYou)}
      className={cn(
        // `.pressable` carries the press dip AND the colour transitions (see
        // globals.css) — a `transition-colors` utility after it would override
        // the shorthand and un-animate the press.
        "pressable group relative flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-control px-1.5",
        "text-ui font-medium focus-visible:outline-offset-0 motion-reduce:active:scale-100",
        // 44px targets in the drawer, which is the only place this is touched.
        "coarse:h-11",
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
          className="absolute inset-0 rounded-control bg-sidebar-accent"
          // framer has to keep the corners true while it scales the box.
          style={{ borderRadius: 10 }}
        />
      )}
      {/* Reduced ink plus a sparkle is ChatGPT's own "not on your plan" mark,
          and it replaces the product glyph rather than joining it, so a gated
          segment is exactly as wide as an open one — a width change here would
          move the thumb for a reason that has nothing to do with the reader. */}
      {locked ? (
        <Sparkles className="relative size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <SidebarMotionIcon kind={product.kind} className="relative size-3.5 shrink-0" />
      )}
      <span className="relative truncate">{product.label}</span>
      {showDot && (
        // A dot, not a number: a count inside the segment changes its width,
        // and a width change in a control whose thumb animates between boxes
        // moves the thumb for a reason the reader did not cause. The number
        // still rides the accessible name, and Work's own triage bar prints it.
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 size-1.5 rounded-full bg-primary motion-safe:animate-pop-in"
        />
      )}
    </Link>
  );
}

function RailItem({
  product,
  active,
  locked,
  needsYou,
  onNavigate,
}: {
  product: Product;
  active: boolean;
  locked: boolean;
  needsYou: number;
  onNavigate?: () => void;
}) {
  const showDot = product.id === "work" && needsYou > 0 && !active;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={locked ? "/upgrade" : product.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          // Always named at rail width: there is no visible label to read.
          aria-label={accessibleName(product, locked, needsYou) ?? product.label}
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
              rhythm from the products down to the footer. */}
          <span className="flex size-[22px] items-center justify-center">
            {locked ? (
              <Sparkles className="size-4" aria-hidden="true" />
            ) : (
              <SidebarMotionIcon kind={product.kind} />
            )}
          </span>
          {showDot && (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 size-1.5 rounded-full bg-primary motion-safe:animate-pop-in"
            />
          )}
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
 *  silently — the waiting count behind Work's dot, or the plan behind the
 *  sparkle. `undefined` when the visible label already says everything. */
function accessibleName(product: Product, locked: boolean, needsYou: number): string | undefined {
  if (locked) return `${product.label}, upgrade to ${PLANS[product.minPlan].name}`;
  if (product.id === "work" && needsYou > 0) return `Work, ${needsYou} waiting on you`;
  return undefined;
}
