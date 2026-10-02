"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion, type MotionValue } from "framer-motion";
import { Lock } from "@/components/ui/icons";

import { SidebarMotionIcon, type SidebarMotionIconKind } from "@/components/app/sidebar-motion-icon";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { PLANS, planRank } from "@/lib/plans";
import { spring } from "@/lib/motion";
import { useTravelSquash } from "@/components/ui/micro";
import { cn } from "@/lib/utils";
import type { ClientQuota } from "@/types/chat";
import { BRAND, PRODUCT_NAME } from "@/lib/brand/names";

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
 * Where the third one went: into the conversation. Whether an ask is a reply
 * or a task with a finish line is the model's call, made per message, and the
 * run it starts is drawn inside the conversation that started it. Neither a
 * switcher segment nor a composer toggle asks the reader to choose up front;
 * both were navigation wearing a control's clothes.
 */
export const PRODUCTS = [
  { id: "chat", label: BRAND.chat.label, href: "/chat", kind: "home", chord: "⌘⇧1", minPlan: "FREE" },
  { id: "code", label: BRAND.code.label, href: "/code", kind: "code", chord: "⌘⇧2", minPlan: "FREE" },
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

/**
 * The chord as this reader's keyboard spells it. `PRODUCTS` writes the Mac
 * form, and the hook it is bound in (`use-global-shortcuts`) answers to ⌘ or
 * Ctrl alike, so a Windows or Linux reader was shown a key they do not have
 * for a chord that works for them as Ctrl⇧1.
 */
function useChordLabel(chord: string): string {
  const mod = useModifierKeyLabel();
  return chord.replace("⌘", mod);
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
  // `hidden md:block` aside plus the drawer Sheet), and a global-string
  // `layoutId` would make one thumb try to fly across to the other tree — out
  // of a `display: none` subtree, which framer measures as 0×0 at the origin.
  // The panel's `LayoutGroup` is now namespaced per mount for the same reason
  // (see `layoutScope` in app-sidebar.tsx), so this is belt and braces; it
  // stays because a `layoutId` that only works while something else remembers
  // to scope it is not scoped.
  const thumbId = `${React.useId()}-product-thumb`;
  const thumbTransition = reduceMotion ? { duration: 0 } : spring.standard;
  /*
   * THE THUMB IS RUBBER, NOT A TILE (lib/micro.ts, `STRETCH`).
   *
   * `layoutId` already moves it, and a rigid box sliding 32px reads as a
   * sprite being repositioned. Stretched 10% along the travel and squashed
   * 6% across it, the same 32px reads as one object being pulled — the
   * reference calls this dilation and runs it at 19%, which is right for a
   * showcase and twice what a control pressed in the corner of a work tool
   * should be doing.
   *
   * The counter lives HERE rather than on the segment, because the segment
   * that receives the thumb has just mounted: its own first effect is the
   * mount, which `useTravelSquash` deliberately swallows. The control
   * persists across the change and is the only thing that can see it as a
   * change.
   */
  const thumbSquash = useTravelSquash(PRODUCTS.findIndex((p) => p.id === active));

  if (collapsed) {
    return (
      // No outer hairline box at rail width: 64px minus `px-2.5` leaves 44px,
      // and a `p-0.5` box inside it would eat the tap target for a border that
      // only has to say "these two are a different kind of thing". A
      // separator hairline says it for free, and it is what the footer uses.
      <nav aria-label={`${PRODUCT_NAME} products`} className="pt-2">
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
     * A LABELLED TWO-POSITION SWITCH, on its own row under the wordmark
     * (premium pass, 2026-09-26).
     *
     * It was a 64x28 pair of bare glyphs tucked into the header. Owners and
     * new readers alike read it as two decorative icons: nothing said "this
     * changes which product the column lists". Two equal cells with the word
     * beside the mark cost one 36px row and remove the guesswork, which is the
     * trade Claude's own Chat/Code switch makes.
     *
     * Still LINKS (see the note at the top of the file), still one travelling
     * raised thumb on a tonal track, still the plan gate and the chord in the
     * tooltip. The track is full width so the two halves read as one object,
     * and each cell is a 32px row, the same height as every row under it.
     */
    <nav
      aria-label={`${PRODUCT_NAME} products`}
      className="grid h-9 w-full shrink-0 grid-cols-2 gap-0.5 rounded-control bg-sidebar-accent/80 p-0.5 coarse:h-12"
    >
      {PRODUCTS.map((product) => (
        <Segment
          key={product.id}
          product={product}
          active={product.id === active}
          locked={isLocked(product, plan)}
          thumbId={thumbId}
          thumbTransition={thumbTransition}
          thumbSquash={thumbSquash}
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
  thumbSquash,
  onNavigate,
}: {
  product: Product;
  active: boolean;
  locked: boolean;
  thumbId: string;
  thumbTransition: object;
  thumbSquash: { scaleX: MotionValue<number>; scaleY: MotionValue<number> };
  onNavigate?: () => void;
}) {
  const chord = useChordLabel(product.chord);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={locked ? "/upgrade" : product.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          aria-label={accessibleName(product, locked)}
          className={cn(
            // `.pressable` carries the press dip AND the colour transitions
            // (globals.css); a `transition-colors` after it would override the
            // shorthand and un-animate the press.
            "pressable group relative flex h-full min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-ui font-medium",
            "focus-visible:outline-offset-0 motion-reduce:active:scale-100",
            locked
              ? "text-muted-foreground/80 hover:text-muted-foreground"
              : active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-sidebar-hover/70 hover:text-foreground",
          )}
        >
          {active && (
            // The raised cell: lifted out of its own track, which is the
            // segmented-control idiom and deliberately not the sidebar row's
            // deeper fill. The carriage travels (`layoutId`); the body inside
            // it deforms (`useTravelSquash`). One node cannot do both.
            <motion.span
              layoutId={thumbId}
              aria-hidden="true"
              transition={thumbTransition}
              className="absolute inset-0"
              style={{ borderRadius: 8 }}
            >
              <motion.span
                aria-hidden="true"
                style={{ ...thumbSquash, borderRadius: 8 }}
                className="product-switch-thumb block size-full"
              />
            </motion.span>
          )}
          {/* A locked surface is SHOWN with a lock in place of its mark, so a
              gated cell is exactly as wide as an open one. */}
          {locked ? (
            <Lock className="relative size-4 shrink-0" aria-hidden="true" />
          ) : (
            <SidebarMotionIcon kind={product.kind} className="relative size-4 shrink-0" />
          )}
          <span className="relative truncate">{product.label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {locked ? `Upgrade to ${PLANS[product.minPlan].name}` : `Switch to ${product.label}`}
        {!locked && <Kbd className="ml-1.5">{chord}</Kbd>}
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
  const chord = useChordLabel(product.chord);
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
            // A plain fill, no travelling thumb. The rows below this (New chat,
            // Search, Library) mark themselves with exactly this fill; a
            // fill that glides between stacked rows above a stack of fills that
            // do not reads as a lift, not as a switch.
            "group relative flex size-11 items-center justify-center rounded-control transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
            locked
              ? "text-muted-foreground/80 hover:bg-sidebar-hover hover:text-muted-foreground"
              : active
                // The panel's one selected recipe, not a fill that resembles
                // it. This was `bg-sidebar-accent` — the colour the rows under
                // it used for HOVER — so at the rail the open product and a
                // hovered destination were the same paint, which is the exact
                // confusion the two-colour retune exists to end.
                ? "sidebar-row-selected text-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground",
          )}
        >
          {/* Byte-identical to NavRow's glyph box, so the rail is one optical
              rhythm from the products down to the footer — which the comment
              claimed while the box passed no size, letting SidebarMotionIcon
              fall back to its own `size-4` (16px) directly above nav glyphs at
              18. `[&_svg]:size-4.5` is what makes the sentence true. */}
          <span className="flex size-5 items-center justify-center [&_svg]:size-4.5">
            {locked ? (
              <Lock aria-hidden="true" />
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
          <Kbd className="ml-1.5">{chord}</Kbd>
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
