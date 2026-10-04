"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Lock } from "@/components/ui/icons";

import { SidebarMotionIcon, type SidebarMotionIconKind } from "@/components/app/sidebar-motion-icon";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { PLANS, planRank } from "@/lib/plans";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientQuota } from "@/types/chat";
import { BRAND, PRODUCT_NAME } from "@/lib/brand/names";
import { DotRings } from "@/components/home/dot-construction";
import type { ArcSpec, RingSpec } from "@/components/home/dot-scenes";

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
   * Code is "PRO": it is the first product gated by plan (PLANS[plan].code),
   * so below Pro its segment draws greyed with a lock and points at
   * `/upgrade`, on every width. The /code layout enforces the same policy on
   * the server for anyone who arrives by URL.
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
  { id: "code", label: BRAND.code.label, href: "/code", kind: "code", chord: "⌘⇧2", minPlan: "PRO" },
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

  if (collapsed) {
    return (
      // No outer hairline box at rail width: 64px minus `px-2.5` leaves 44px,
      // and a `p-0.5` box inside it would eat the tap target for a border that
      // only has to say "these two are a different kind of thing". A
      // separator hairline says it for free, and it is what the footer uses.
      <nav aria-label={`${PRODUCT_NAME} products`} className="flex flex-col items-center px-2 pb-2 pt-2">
        {/* The expanded switch, turned on its side: the same recessed track
            and the same raised thumb, so the rail and the panel draw one
            control rather than two. */}
        <div className="flex flex-col gap-0.5 rounded-field bg-sidebar-accent/80 p-0.5">
          {PRODUCTS.map((product) => (
            <RailItem
              key={product.id}
              product={product}
              active={product.id === active}
              locked={isLocked(product, plan)}
              thumbId={thumbId}
              thumbTransition={thumbTransition}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div className="mt-2.5 h-px w-5 bg-sidebar-border" aria-hidden="true" />
      </nav>
    );
  }

  return (
    /*
     * CHAT AND CODE AT THE TWO ENDS OF AN ORBIT (2026-10-04, owner).
     *
     * The two products are named in the greeting's serif at either end of
     * one flattened orbit, drawn by the homepage's own dot engine
     * (`DotRings`). The presence trajectory runs round the orbit to the
     * product you are in and blooms there: round the FRONT going to Code,
     * round the BACK coming home, the way the hero's trajectory travels.
     * At rest the arc stays, so the row always says where you are.
     *
     * Still LINKS (see the note at the top of the file), still the plan gate
     * and the chord in the tooltip; the rail keeps its own track below.
     */
    <nav
      aria-label={`${PRODUCT_NAME} products`}
      className="flex h-8 w-full shrink-0 items-center gap-0.5 pl-[5px] coarse:h-12"
    >
      <OrbitEnd product={PRODUCTS[0]} active={active === PRODUCTS[0].id} locked={isLocked(PRODUCTS[0], plan)} onNavigate={onNavigate} />
      <OrbitTrack active={active} />
      <OrbitEnd product={PRODUCTS[1]} active={active === PRODUCTS[1].id} locked={isLocked(PRODUCTS[1], plan)} onNavigate={onNavigate} />
    </nav>
  );
}

/** One flattened orbit; the box is larger than the ring so the bloom is never cut square. */
const ORBIT_RING: RingSpec[] = [{ cx: 0.5, cy: 0.5, rx: 0.34, ry: 0.17 }];
/* Short trails, like the hero's trajectory: the last stretch of the way in. */
const TRAIL_TO_CODE: ArcSpec[] = [{ ring: 0, from: 125, to: 0 }];
const TRAIL_TO_CHAT: ArcSpec[] = [{ ring: 0, from: -55, to: -180 }];
const REST_CHAT: ArcSpec[] = [{ ring: 0, from: 110, to: 180 }];
const REST_CODE: ArcSpec[] = [{ ring: 0, from: 70, to: 0 }];

/**
 * The orbit between the two names. The ring holds still; over it the
 * trajectory layer is remounted on each change of product (its clock restarts)
 * with its own ring drawn at zero ink, so only the blue arc and its bloom show.
 */
function OrbitTrack({ active }: { active: ProductSurface }) {
  const reduceMotion = useReducedMotion() ?? false;
  const [turn, setTurn] = React.useState(0);
  const seen = React.useRef(active);
  React.useEffect(() => {
    if (seen.current === active) return;
    seen.current = active;
    setTurn((n) => n + 1);
  }, [active]);
  const arcs = turn === 0 ? (active === "code" ? REST_CODE : REST_CHAT) : active === "code" ? TRAIL_TO_CODE : TRAIL_TO_CHAT;
  return (
    <span aria-hidden="true" className="product-orbit relative -mx-1.5 -my-2 h-12 w-[84px] shrink-0">
      <DotRings rings={ORBIT_RING} animate={false} />
      <span className="product-orbit-trail absolute inset-0">
        <DotRings key={turn} rings={ORBIT_RING} arcs={arcs} animate={!reduceMotion && turn > 0} delay={0} stagger={0} draw={0.62} />
      </span>
    </span>
  );
}

function OrbitEnd({
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
          aria-label={accessibleName(product, locked)}
          className={cn(
            "pressable product-orbit-name relative flex h-7 shrink-0 items-center gap-1 rounded-control px-1.5",
            "focus-visible:outline-offset-0 motion-reduce:active:scale-100",
            locked
              ? "text-muted-foreground/70 hover:text-muted-foreground"
              : active
                ? "text-foreground"
                : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {locked && <Lock className="size-3.5 shrink-0" aria-hidden="true" />}
          {product.label}
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
            // The expanded switch's recipe at rail size: a raised thumb that
            // travels inside a recessed track (see the nav above).
            "pressable group relative flex size-8 items-center justify-center rounded-control transition-colors duration-fast ease-out-soft motion-reduce:transition-none motion-reduce:active:scale-100 coarse:size-11",
            locked
              ? "text-muted-foreground/80 hover:text-muted-foreground"
              : active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {active && (
            <motion.span
              layoutId={thumbId}
              aria-hidden="true"
              transition={thumbTransition}
              className="product-switch-thumb absolute inset-0"
              style={{ borderRadius: 8 }}
            />
          )}
          {/* Byte-identical to NavRow's glyph box, so the rail is one optical
              rhythm from the products down to the footer — which the comment
              claimed while the box passed no size, letting SidebarMotionIcon
              fall back to its own `size-4` (16px) directly above nav glyphs at
              18. `[&_svg]:size-4` is what makes the sentence true. */}
          <span className="relative flex size-5 items-center justify-center [&_svg]:size-4">
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
