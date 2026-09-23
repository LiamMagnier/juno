"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Menu, Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "@/components/app/app-sidebar";
import { productOf } from "@/components/app/product-switch";
import { AnimatedTitle } from "@/components/app/animated-title";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { OnboardingLazy } from "@/components/app/onboarding-lazy";
import { CommandPaletteLazy } from "@/components/app/command-palette-lazy";
import { DocumentTitle } from "@/components/app/document-title";
import { PageTransition } from "@/components/app/page-transition";
import { AnnouncementPopupLazy } from "@/components/app/announcement-popup-lazy";
import { AmbientAuraLazy } from "@/components/ambient/ambient-aura-lazy";
import { useApp } from "@/components/app/app-provider";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { VerifyEmailBanner } from "@/components/auth/verify-email-banner";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { duration, transition } from "@/lib/motion";
import { titleForPath } from "@/lib/route-title";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "juno:sidebar-collapsed";
const WIDTH_KEY = "juno:sidebar:width";
const SIDEBAR_MIN = 224;
const SIDEBAR_MAX = 336;
/*
 * 288, the width Claude's sidebar opens at.
 *
 * At 256 this column truncated its own content ("Pricing table for the new
 * Fl…"). It went to 304 when the panel's inset grew to 12px a side; the inset
 * is back to 8px (panel `px-2` plus row `px-2`, glyphs at 16px and labels at
 * 46px) and the rows set their text at the 14px `nav` rung instead of 15px,
 * so a title gets the same words at 288 that it got at 304. The horizontal
 * budget for a conversation title is `width - 16px of text inset - 18px of
 * right inset`: the row's kebab floats over that end on hover instead of
 * holding a slot at rest, so the budget is spent on the words.
 *
 * Still resizable between SIDEBAR_MIN and SIDEBAR_MAX; this is only where it
 * starts.
 */
const SIDEBAR_DEFAULT = 288;
const RAIL_WIDTH = 64;
// The landing route of every product mode belongs here: switching modes routes
// immediately, so a cold /code is the one navigation the user cannot absorb as
// "the page is loading".
/**
 * The routes worth holding warm: the two the product switch reaches.
 *
 * It listed ten. Eight of them are destinations behind a nav row or a menu,
 * reached once in a session if at all, and every one was a full prefetch of a
 * `force-dynamic` route — uncacheable on the server, so ten RSC requests left
 * the browser on every shell mount and competed with the page the reader was
 * looking at. The switch's own two are the ones pressed constantly, and they
 * are the ones this is for.
 */
const PREFETCH_ROUTES = ["/chat", "/code"];

function clampWidth(w: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

/**
 * A 2px line along the top of the content while a reply streams AND the
 * composer's Stop button is off screen (a canvas or the thought dock covering
 * the chat column below lg) — the one case where nothing else on screen says
 * a generation is running. While Stop is visible it is the signal, and this
 * stays dark: one "working" indicator per surface. chat-view decides and
 * dispatches `juno:streaming`; `.stream-progress` (globals.css) owns the sweep.
 */
function StreamProgress({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "stream-progress pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 transition-opacity duration-base ease-out-soft",
        active ? "opacity-100" : "opacity-0"
      )}
    />
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen, activeConversationId, conversations } = useApp();
  const router = useRouter();
  const pathname = usePathname();

  const [collapsed, setCollapsed] = React.useState(false);
  // md–lg: the expanded panel FLOATS over the content instead of pushing it,
  // with a soft dismiss. A 288px column in a 900px window leaves a transcript
  // narrower than a phone; the rail stays in flow and the full panel becomes
  // an overlay you summon and dismiss.
  const [narrow, setNarrow] = React.useState(false);
  /*
   * AT md–lg THE PANEL IS SUMMONED, NEVER ARRIVED IN.
   *
   * `floating` used to be `narrow && !collapsed`, and `collapsed` defaults to
   * false — so a first visit at 768–1023 painted the full 256px panel on top
   * of the page, over a 5%-alpha scrim, with the greeting clipped behind it.
   * The reader's first frame was their content covered by a menu nobody
   * opened, and the only way out was to guess that the pale wash to its right
   * was a dismiss target.
   *
   * This band is the one place the panel is an OVERLAY rather than a column,
   * and an overlay has exactly one honest default: shut. So the narrow band
   * gets its own open flag, held in memory rather than in localStorage —
   * "expanded" is a preference about a column you can see beside your work,
   * and it does not transfer to a thing that covers it. Leaving the band drops
   * the flag, so a window dragged back past 1024 returns to the stored
   * preference rather than to whatever the overlay was last doing.
   */
  const [narrowOpen, setNarrowOpen] = React.useState(false);
  /** `narrow`, readable from handlers that were built before this render. */
  const narrowRef = React.useRef(false);
  narrowRef.current = narrow;
  const [streaming, setStreaming] = React.useState(false);
  // Resizable sidebar (desktop). Width lives in state + a CSS var on the aside;
  // the ref mirrors it so pointermove handlers never read a stale closure.
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT);
  const [resizing, setResizing] = React.useState(false);
  /*
   * KEYBOARD AND DOUBLE-CLICK RESIZES LAND IN ONE FRAME, like a drag does.
   *
   * The width sweep is for the column folding and unfolding, an A-to-B the
   * reader asked to watch. A resize is direct manipulation: a 16px arrow-key
   * step riding a 220ms curve trailed a held key, and a reset is a drag that
   * has been finished for you. `resizing` only covers the pointer, so these
   * two raise this flag for the one commit that changes the width.
   */
  const [snapWidth, setSnapWidth] = React.useState(false);
  const asideRef = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    if (!snapWidth) return;
    // Flush the new width while the transition is off. Without this read the
    // browser can see the width change and the transition's return in one
    // style pass, and animate anyway.
    void asideRef.current?.offsetWidth;
    setSnapWidth(false);
  }, [snapWidth]);
  /*
   * THE FRAME ANIMATES ONLY ONCE THE PAGE HAS SETTLED.
   *
   * The stored width and the stored collapse are both read after the first
   * render (the width in a layout effect, the collapse in an effect), so the
   * frame's first real change is a correction, not a gesture — and a width
   * transition starting from the SSR default played the sidebar folding shut on every
   * load for anyone who keeps it collapsed. One frame after mount the frame
   * starts answering the reader instead.
   */
  const [frameLive, setFrameLive] = React.useState(false);
  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setFrameLive(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const widthRef = React.useRef(SIDEBAR_DEFAULT);
  const activeConversation = activeConversationId ? conversations.find((c) => c.id === activeConversationId) : null;
  const activeTitle = activeConversation?.title ?? null;
  // The mobile bar is captioned by the ROUTE, and only borrows the conversation
  // title while you are inside a conversation. `activeConversationId` is set on
  // chat mount and never cleared, so the bar used to keep naming the last chat
  // you read while you stood on /library or /settings — a header that names a
  // page you are not on. Everywhere else it said "Juno", which named nothing.
  const inConversation = pathname.startsWith("/chat/");
  const mobileTitle = (inConversation ? activeTitle : null) ?? titleForPath(pathname);
  /*
   * Which product's sidebar this is, decided ONCE.
   *
   * A Juno Code session is served at /chat/<id> — `app/(app)/chat/[id]/page.tsx`
   * renders `<CodeSessionView>` when the conversation's kind is "code" — so the
   * path alone says "Chat" for the entire time somebody is inside a Code
   * session, which is precisely when the column must not be Chat's. The open
   * conversation's own kind is the tiebreak; `productOf` holds that rule, and
   * holds the anchor with it — the kind is consulted only on /chat/<id>, so
   * the stale `activeConversationId` described just above cannot follow you to
   * /library and swap the whole column for Code's.
   *
   * It is computed here rather than inside the sidebar because the sidebar
   * mounts twice (the desktop aside and the phone drawer) and two copies of a
   * derivation are two things that can disagree.
   */
  const product = productOf(pathname, activeConversation?.kind ?? null);

  const applyWidth = React.useCallback((w: number) => {
    widthRef.current = w;
    setSidebarWidth(w);
  }, []);

  const persistWidth = React.useCallback((w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  // Restore the stored width before paint so the sidebar doesn't visibly jump
  // from the default on load.
  React.useLayoutEffect(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      /*
       * A STORED VALUE EQUAL TO A PREVIOUS DEFAULT MEANS "I NEVER CHOSE".
       *
       * This width is persisted, so the moment it is written once, changing
       * SIDEBAR_DEFAULT does nothing for anybody who has already opened Juno:
       * the column would stay at the old default for every existing reader
       * while the code and the screenshots said otherwise. That is the worst
       * kind of change: one that is real in the repository and invisible in
       * the product.
       *
       * So a stored value that is exactly one of the widths this app has
       * DEFAULTED to is treated as unset, and the current default wins. A width
       * the reader actually dragged to is any other number, and it is kept,
       * which is why this is a list of defaults rather than a version bump on
       * the key, which would have thrown away deliberate choices too. 288 is
       * both a former and the current default; listing it is harmless.
       */
      const FORMER_DEFAULTS = [256, 288, 304];
      const chosen = Number.isFinite(stored) && stored > 0 && !FORMER_DEFAULTS.includes(stored);
      if (chosen) applyWidth(clampWidth(stored));
    } catch {
      /* ignore */
    }
  }, [applyWidth]);

  // ⌘⇧1 / ⌘⇧2 / ⌘⇧3 — the web's only keyboard route to a product.
  // `use-global-shortcuts` owns the chord and names the destination; the shell
  // owns `router`, so the hook dispatches and this pushes. (⌘1–⌘3 are browser
  // tab switching on macOS and cannot be reliably preempted, which is why the
  // Mac app's ⌘1/2/3 could not simply be copied.)
  React.useEffect(() => {
    const go = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      if (href) router.push(href);
    };
    window.addEventListener("juno:go-product", go);
    return () => window.removeEventListener("juno:go-product", go);
  }, [router]);

  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");
    const sync = () => {
      setNarrow(mq.matches);
      // Leaving the band forgets the overlay. Entering it needs nothing: the
      // flag is already false, which is the rail.
      if (!mq.matches) setNarrowOpen(false);
    };
    mq.addEventListener("change", sync);
    sync();
    return () => mq.removeEventListener("change", sync);
  }, []);

  React.useEffect(() => {
    const onStreaming = (e: Event) => setStreaming(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("juno:streaming", onStreaming);
    return () => window.removeEventListener("juno:streaming", onStreaming);
  }, []);

  const startResize = React.useCallback(
    (e: React.PointerEvent) => {
      // Left button / primary touch only.
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      setResizing(true);
      // Keep the resize cursor (and kill text selection) even when the pointer
      // outruns the 6px handle mid-drag.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => applyWidth(clampWidth(startWidth + (ev.clientX - startX)));
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        setResizing(false);
        persistWidth(widthRef.current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [applyWidth, persistWidth]
  );

  const resetWidth = React.useCallback(() => {
    setSnapWidth(true);
    applyWidth(SIDEBAR_DEFAULT);
    persistWidth(SIDEBAR_DEFAULT);
  }, [applyWidth, persistWidth]);

  const setCollapsedPersist = React.useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setCollapsed((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
      } catch {
        /* ignore */
      }
      return value;
    });
  }, []);

  React.useEffect(() => {
    const collapseSidebar = () => {
      if (narrowRef.current) setNarrowOpen(false);
      else setCollapsedPersist(true);
    };
    window.addEventListener("juno:collapse-sidebar", collapseSidebar);
    return () => window.removeEventListener("juno:collapse-sidebar", collapseSidebar);
  }, [setCollapsedPersist]);

  /*
   * WARM THE TWO ROUTES THE SWITCHER REACHES, when the browser is idle.
   *
   * This fired ten full prefetches of `force-dynamic` routes at once, on mount,
   * and never again. Three things were wrong with that. They all left at the
   * same moment as the page the reader was actually looking at, competing with
   * it for connections; they were one-shot, so a `router.refresh()` — which the
   * app provider and the settings modal both call — emptied the router cache
   * and nothing ever rebuilt it; and eight of the ten were destinations nobody
   * reaches in one click from here.
   *
   * Now: the two the product switch points at, re-armed whenever the route
   * changes, behind `requestIdleCallback` so they wait for a gap rather than
   * taking one. With `staleTimes.dynamic` back on (next.config.mjs) a warm
   * entry makes the switch instant instead of merely quick.
   */
  React.useEffect(() => {
    const warm = () => {
      for (const href of PREFETCH_ROUTES) router.prefetch(href);
    };
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(warm, { timeout: 2000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    // Safari has no requestIdleCallback; a macrotask is close enough for a
    // warm-up whose only requirement is "not during first paint".
    const timer = setTimeout(warm, 600);
    return () => clearTimeout(timer);
  }, [router, pathname]);

  /**
   * Close the mobile drawer when the viewport crosses into desktop.
   *
   * Both the SheetContent and its scrim are `md:hidden`, so after opening the
   * drawer at phone width and rotating (or dragging the window wider) NOTHING
   * renders — but Radix keeps the Dialog open, and an open Dialog keeps its
   * scroll lock and focus trap live. Firing the handler once on mount also
   * covers the case where the breakpoint was already crossed before this
   * listener attached.
   */
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", sync);
    sync();
    return () => mq.removeEventListener("change", sync);
  }, [setSidebarOpen]);

  const toggleCollapse = React.useCallback(() => {
    // In the band the control opens and closes an overlay, which is not a
    // preference and is not written down.
    if (narrowRef.current) setNarrowOpen((prev) => !prev);
    else setCollapsedPersist((prev) => !prev);
  }, [setCollapsedPersist]);

  // ⌘⇧S at any width: below md it opens the drawer, which is the sidebar there.
  const toggleAnySidebar = React.useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(!sidebarOpen);
    else toggleCollapse();
  }, [setSidebarOpen, sidebarOpen, toggleCollapse]);
  useGlobalShortcuts({ onToggleSidebar: toggleAnySidebar });
  React.useEffect(() => {
    window.addEventListener("juno:toggle-sidebar", toggleAnySidebar);
    return () => window.removeEventListener("juno:toggle-sidebar", toggleAnySidebar);
  }, [toggleAnySidebar]);

  // The floating panel dismisses on navigation, like a menu that did its job.
  const floating = narrow && narrowOpen;
  /*
   * What the COLUMN is, at this width. Inside the band it is the narrow
   * overlay's flag; outside it, the stored preference. Every consumer below
   * reads this rather than `collapsed`, so there is one answer to "is the
   * panel showing" instead of two that can disagree at the breakpoint.
   */
  const shown = narrow ? narrowOpen : !collapsed;
  /*
   * THE OVERLAY LEAVES THE WAY IT ARRIVED: OVER THE PAGE.
   *
   * `floating` drops the moment the overlay is dismissed, and what follows is
   * the frame's 220ms fold. Positioned by `floating`, the panel went back into
   * the row for the whole of that fold: a 288px column in the flow for a
   * quarter of a second, shoving the transcript right and letting it back. So
   * the frame keeps its floating position and elevation until the fold lands
   * (the width's own `transitionend`; at once where nothing transitions).
   *
   * Adjusted during render, not in an effect, so the frame the overlay closes
   * in is already a held one and never paints in the flow.
   */
  const [floatHeld, setFloatHeld] = React.useState(false);
  const [wasFloating, setWasFloating] = React.useState(floating);
  if (wasFloating !== floating) {
    setWasFloating(floating);
    setFloatHeld(!floating && narrow);
  }
  const floatingFrame = floating || (floatHeld && narrow);
  React.useEffect(() => {
    if (!floatHeld) return;
    // Nothing to wait for when the width is not transitioning (reduced
    // motion, or a frame that has not gone live): the panel is already the
    // rail, so it rejoins the row now rather than wearing the float shadow.
    const style = asideRef.current ? window.getComputedStyle(asideRef.current) : null;
    if (!style || style.transitionProperty === "none" || parseFloat(style.transitionDuration) === 0) {
      setFloatHeld(false);
      return;
    }
    // Otherwise `transitionend` releases it; this is the backstop for one that
    // never arrives, with slack past the rung so it never beats the fold.
    const timer = window.setTimeout(() => setFloatHeld(false), Math.round(duration.base * 1000) + 120);
    return () => window.clearTimeout(timer);
  }, [floatHeld]);
  const floatingRef = React.useRef(floating);
  floatingRef.current = floating;
  React.useEffect(() => {
    if (floatingRef.current) setNarrowOpen(false);
    // Only the route change should dismiss it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    /*
     * REDUCED MOTION, ONCE, FOR EVERYTHING THE SHELL HOLDS.
     *
     * A handful of framer surfaces asked `useReducedMotion()` themselves and
     * the rest did not, so a reader who had asked the OS for less motion still
     * got panels sliding and cards springing wherever someone had forgotten
     * to. `reducedMotion="user"` is framer's own reading of the tiered policy
     * in globals.css: transform and layout animations become instant, opacity
     * and colour keep their timing (ICONS_AND_MOTION.md §2.2, rule 10). It is
     * context, so it reaches the dialogs and menus the shell portals out too.
     */
    <MotionConfig reducedMotion="user">
      <div className="relative flex h-dvh overflow-hidden">
        {/* Bypass Blocks (SC 2.4.1, Level A). */}
        <a
          href="#juno-main"
          className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-toast focus-visible:rounded-field focus-visible:border focus-visible:border-border focus-visible:bg-popover focus-visible:px-4 focus-visible:py-2 focus-visible:text-ui focus-visible:shadow-float"
        >
          Skip to content
        </a>

        {/* At md–lg the rail keeps its 64px in flow and the expanded panel floats
            over the content; a click anywhere outside it folds it back.

            IN FLOW, which is what the sentence above always said and what the
            spacer was not: it was `absolute`, so while the panel floated
            `<main>` slid under it to x=0 and the page re-centred 32px to the
            left, then jumped back when the panel landed. Holding the rail's
            place in the row is what lets the panel float out and fold home
            without the content under it moving at all. */}
        {floatingFrame && (
          /* w-16 IS RAIL_WIDTH. Two more places spell the rail's width — this
             spacer and app-sidebar's collapsed column — and a mismatch leaves
             a seam of page showing through beside the rail at md–lg. */
          <div aria-hidden className="hidden h-full w-16 shrink-0 bg-sidebar md:block" />
        )}
        {/* The scrim fades out as well as in. It used to cut on close while the
            panel it belonged to was still folding away, so the page brightened
            a frame before the panel had left it. Opacity only, so the reduced
            tier keeps it unchanged. */}
        <AnimatePresence>
          {floating && (
            <motion.button
              key="sidebar-scrim"
              type="button"
              aria-label="Close sidebar"
              onClick={() => setNarrowOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              /* /10, not /5. At a twentieth the wash was imperceptible on paper
                 — the page behind the panel looked exactly as it had a frame
                 earlier, so nothing said the panel was a layer you could
                 dismiss by clicking past it. A tenth is still light enough to
                 read the transcript through, which is the point of a soft
                 dismiss rather than a modal. */
              className="absolute inset-0 z-30 hidden cursor-default bg-foreground/10 md:block"
            />
          )}
        </AnimatePresence>

        {/* overflow-hidden + fixed-width sidebar layouts: the width sweep reveals/clips
            the content instead of reflowing it mid-animation.

            A CSS width transition on the symmetric rung (220ms, `ease-in-out`:
            both endpoints of a collapse are on screen, so this is an A-to-B
            move). It is the one sanctioned width animation in the product
            (tailwind.config.ts names "sidebar width" beside the curve), and it
            stays the SHORT rung on purpose: `<main>` re-flows on every frame
            of it. The rows inside ride this same 220ms curve
            (`layoutTransition` in app-sidebar.tsx), so the glyphs land on the
            frame the edge does. Dropped while dragging so resize follows
            the pointer 1:1,
            for the commit of a keyboard or double-click resize (`snapWidth`),
            before the page has settled (see `frameLive`), and under reduced
            motion, where a panel that slides is travel. */}
        <aside
          ref={asideRef}
          data-floating={floatingFrame ? "" : undefined}
          onTransitionEnd={(e) => {
            // The fold has landed: the held overlay can rejoin the row.
            if (e.target === e.currentTarget && e.propertyName === "width") setFloatHeld(false);
          }}
          className={cn(
            "app-sidebar-frame hidden shrink-0 overflow-hidden bg-sidebar md:block",
            /* FLOATING MEANS ELEVATED. Over the content the panel had the same
               hairline it wears as a column, so it read as a layout glitch —
               a page that had failed to reflow — rather than as something
               sitting above the page. The float shadow is the one thing that
               says "this is a layer", and it is the same shadow every other
               floating surface in the product wears. */
            floatingFrame ? "absolute inset-y-0 left-0 z-40 shadow-float" : "relative",
            frameLive && !resizing && !snapWidth && "transition-[width] duration-base ease-in-out motion-reduce:transition-none"
          )}
          style={
            {
              width: shown ? sidebarWidth : RAIL_WIDTH,
              "--juno-sidebar-width": `${sidebarWidth}px`,
            } as React.CSSProperties
          }
        >
          <AppSidebar collapsed={!shown} onToggleCollapse={toggleCollapse} product={product} />
          {shown && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={startResize}
              onDoubleClick={resetWidth}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const next = clampWidth(widthRef.current + (e.key === "ArrowLeft" ? -16 : 16));
                  setSnapWidth(true);
                  applyWidth(next);
                  persistWidth(next);
                } else if (e.key === "Enter") {
                  resetWidth();
                }
              }}
              className="group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none outline-none"
            >
              {/* Invisible until engaged: a neutral hairline on hover/drag/focus. */}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 right-0 w-[2px] bg-foreground/25 opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100",
                  resizing && "opacity-100"
                )}
              />
            </div>
          )}
        </aside>

        {/* Mobile drawer — Radix-backed Sheet (focus trap, Escape, scroll lock),
            sliding in on `sheet-in`. The sidebar's rungs are re-based for the
            popover ground it lands on (see the note in sheet.tsx).

            THE ROW STATES ARE RE-BASED, not just the accent. Hover and selection
            are separate fills (globals.css), both authored against a panel at
            8.8%; on the sheet's 16.5% popover ground they would land below
            their own ground or barely above it. Each is re-stated at a
            distance from THIS ground:

              ground     16.5%   (the popover, not --sidebar)
              hover      21.0%   +4.5
              selected   24.0%   +7.5

            Selected stops at 24%: the open account row sets its plan line in
            `--muted-foreground`, which measures 4.53:1 there and fell to 4.34
            at the 25% this used to be. The row draws no edge, so
            `--sidebar-selected-border` is not re-based.

            `--sidebar-accent` keeps its own re-basing for the same reason it
            always had one: the product switch's track draws with it directly. */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            className="p-0 dark:[--sidebar-accent:48_5%_24%] dark:[--sidebar-border:48_5%_22%] dark:[--sidebar-hover:48_5%_21%] dark:[--sidebar-selected:48_6%_24%] md:hidden"
            title="Conversations"
          >
            <AppSidebar product={product} />
          </SheetContent>
        </Sheet>

        <main
          id="juno-main"
          tabIndex={-1}
          className="app-main-canvas relative flex min-w-0 flex-1 flex-col"
          style={{ "--juno-sidebar-width": !shown || floating ? `${RAIL_WIDTH}px` : `${sidebarWidth}px` } as React.CSSProperties}
        >
          <StreamProgress active={streaming} />

          {/* THE VOICE LIGHT, and it lives HERE rather than on <body>.
              `<main>` is `relative` and starts where the sidebar ends, so the
              layer it positions against is exactly the content column. The old
              version was `position: fixed` in a body portal, which meant a call
              lit the frame around the sidebar and the navigation as well as the
              conversation — a mode light claiming chrome that is not in the
              mode. Mounted once, here, and absent unless a call is up. */}
          <AmbientAuraLazy />

          {/* An account that has never confirmed its address can read everything
              it owns and export it, but cannot spend — so the refusal has to be
              explained before it is hit, not after. The banner renders null until
              it has confirmed the address is unverified, so a verified account
              pays nothing for it. */}
          <VerifyEmailBanner />

          {/* Mobile navigation stays out of a full-width toolbar: each action is
              a self-contained circular surface, so the page background continues
              through the top of the screen. */}
          <div className="relative z-40 flex shrink-0 items-center gap-2 px-3 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))] md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="group size-10 shrink-0 rounded-full border border-border bg-card hover:bg-accent coarse:size-11"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </Button>
            <AnimatedTitle
              title={mobileTitle}
              animate={inConversation && activeConversation?.titleSource === "ai"}
              className="min-w-0 flex-1 px-1"
              textClassName="text-body-lg font-semibold tracking-tight text-foreground"
            />
            <Button
              variant="ghost"
              size="icon"
              className="group ml-auto size-10 shrink-0 rounded-full border border-border bg-card hover:bg-accent coarse:size-11"
              onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
              aria-label="Search chats and projects"
            >
              <SidebarMotionIcon kind="search" className="size-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="group size-10 shrink-0 rounded-full border border-border bg-card hover:bg-accent coarse:size-11"
              onClick={() => {
                router.push("/chat");
                window.dispatchEvent(new CustomEvent("juno:new-chat"));
              }}
              aria-label="New chat"
            >
              <Plus className="size-5" />
            </Button>
          </div>

          {/* `z-[1]`, and it is the other half of the aura's `z-index: 0`.
              A positioned layer at 0 paints ABOVE in-flow content, so without a
              stacking order here the voice light would cover the conversation
              instead of sitting behind it. One class, on the one element that
              wraps everything a person reads. */}
          <div className="relative z-[1] min-h-0 flex-1">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>

        <OnboardingLazy />
        <AnnouncementPopupLazy />
        <CommandPaletteLazy />
        <DocumentTitle />
      </div>
    </MotionConfig>
  );
}
