"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "@/components/app/app-sidebar";
import { AnimatedTitle } from "@/components/app/animated-title";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { Onboarding } from "@/components/app/onboarding";
import { CommandPalette } from "@/components/app/command-palette";
import { ChatWorkSwitcher } from "@/components/chat/chat-work-switcher";
import { PageTransition } from "@/components/app/page-transition";
import { AnnouncementPopup } from "@/components/app/announcement-popup";
import { useApp } from "@/components/app/app-provider";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "juno:sidebar-collapsed";
const WIDTH_KEY = "juno:sidebar:width";
const SIDEBAR_MIN = 224;
const SIDEBAR_MAX = 336;
const SIDEBAR_DEFAULT = 256;
// The landing route of every product mode belongs here: switching modes routes
// immediately, so a cold /work is the one navigation the user cannot absorb as
// "the page is loading".
const PREFETCH_ROUTES = ["/chat", "/work", "/design", "/library", "/artifacts", "/projects", "/memory", "/settings", "/roadmap", "/upgrade"];

function clampWidth(w: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen, activeConversationId, conversations } = useApp();
  const router = useRouter();
  const pathname = usePathname();

  const showSurfaceSwitcher =
    pathname === "/" || pathname?.startsWith("/chat") || pathname?.startsWith("/work");

  const [collapsed, setCollapsed] = React.useState(false);
  // Resizable sidebar (desktop). Width lives in state + a CSS var on the aside;
  // the ref mirrors it so pointermove handlers never read a stale closure.
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT);
  const [resizing, setResizing] = React.useState(false);
  const widthRef = React.useRef(SIDEBAR_DEFAULT);
  const activeConversation = activeConversationId ? conversations.find((c) => c.id === activeConversationId) : null;
  const activeTitle = activeConversation?.title ?? null;

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
      if (Number.isFinite(stored) && stored > 0) applyWidth(clampWidth(stored));
    } catch {
      /* ignore */
    }
  }, [applyWidth]);

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
    applyWidth(SIDEBAR_DEFAULT);
    persistWidth(SIDEBAR_DEFAULT);
  }, [applyWidth, persistWidth]);

  React.useEffect(() => {
    const collapseSidebar = () => {
      setCollapsed(true);
      try {
        localStorage.setItem(COLLAPSE_KEY, "1");
      } catch {
        /* ignore */
      }
    };

    window.addEventListener("juno:collapse-sidebar", collapseSidebar);
    return () => window.removeEventListener("juno:collapse-sidebar", collapseSidebar);
  }, []);

  React.useEffect(() => {
    for (const href of PREFETCH_ROUTES) {
      router.prefetch(href);
    }
  }, [router]);

  /**
   * Close the mobile drawer when the viewport crosses into desktop.
   *
   * Both the SheetContent and its scrim are `md:hidden`, so after opening the
   * drawer at phone width and rotating (or dragging the window wider) NOTHING
   * renders — but Radix keeps the Dialog open, and an open Dialog keeps its
   * scroll lock and focus trap live. The result was a desktop app that could
   * not be scrolled, with focus trapped inside a `display:none` panel and no
   * visible way out. Firing the handler once on mount also covers the case
   * where the breakpoint was already crossed before this listener attached.
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
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className="relative flex h-dvh overflow-hidden">
      {/* Bypass Blocks (SC 2.4.1, Level A). The sidebar puts a mode toggle, three
          nav destinations and the entire conversation list ahead of <main> in DOM
          order, so without this a keyboard user tabs the whole history again on
          every navigation. tabIndex={-1} on the target is required for Safari and
          Firefox to actually move focus there rather than only scrolling. */}
      <a
        href="#juno-main"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-toast focus-visible:rounded-field focus-visible:border focus-visible:border-border focus-visible:bg-popover focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:shadow-float"
      >
        Skip to content
      </a>
      {/* overflow-hidden + fixed-width sidebar layouts: the width sweep reveals/clips
          the content instead of reflowing it mid-animation. The expanded width is
          user-resizable (drag handle below); --juno-sidebar-width carries it to the
          sidebar's inner column, which must NOT track the aside mid-collapse. The
          width transition is dropped while dragging so resize follows the pointer
          1:1 instead of lagging through the ease.

          ease-in-out, not ease-out-soft: both endpoints of a collapse are on
          screen, so this is an A-to-B move. A decelerate curve makes the edge look
          like it arrived from somewhere off-screen. */}
      <aside
        className={cn(
          // The seam is drawn ONCE, by `.app-sidebar-frame` (globals.css), which
          // is the class written to own it: `inset -1px 0 0 hsl(--sidebar-border)`.
          // A `border-r` in the same token on top of it stacked a second hairline
          // immediately outside the first, so on the dark theme — where this seam
          // is the only thing separating panel from canvas — it rendered 2px wide
          // and also ate a pixel of the user's resized width (border-box).
          "app-sidebar-frame relative hidden shrink-0 overflow-hidden bg-sidebar md:block",
          !resizing && "transition-[width] duration-base ease-in-out"
        )}
        style={
          {
            width: collapsed ? 64 : sidebarWidth,
            "--juno-sidebar-width": `${sidebarWidth}px`,
          } as React.CSSProperties
        }
      >
        <AppSidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />
        {!collapsed && (
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
                applyWidth(next);
                persistWidth(next);
              } else if (e.key === "Enter") {
                resetWidth();
              }
            }}
            className="group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none outline-none"
          >
            {/* Invisible until engaged: a hairline highlight on hover/drag/focus.
                Neutral ink, not coral — a full-height accent bar down the window
                is the loudest thing on screen for what is only a drag affordance,
                and the canvas/thought handles are already neutral. */}
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

      {/* Mobile drawer — Radix-backed Sheet (focus trap, Escape, scroll lock).

          The sidebar's rungs are re-based for the ground it lands on here. The
          panel is IN FLOW on desktop, where --sidebar-accent (11%) and
          --sidebar-border (14%) read against a #000 page; inside the drawer the
          parent is --popover (13%), so both tokens resolved BELOW their own
          surface and every row hover, every active row and the footer rule
          turned into a 1-2 point darker patch — i.e. nothing. Lifted above the
          popover here, and only on dark: on light the sidebar ramp is already
          darker than the 99% popover, which is the correct direction there. */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          className="p-0 dark:[--sidebar-accent:48_5%_18%] dark:[--sidebar-border:48_5%_22%] md:hidden"
          title="Conversations"
        >
          <AppSidebar />
        </SheetContent>
      </Sheet>

      <main
        id="juno-main"
        tabIndex={-1}
        className="app-main-canvas relative flex min-w-0 flex-1 flex-col"
        style={{ "--juno-sidebar-width": collapsed ? "64px" : `${sidebarWidth}px` } as React.CSSProperties}
      >
        {/* Mobile navigation stays out of a full-width toolbar. Each action is a
            self-contained circular surface, so the page background can continue
            through the top of the screen without sacrificing hit-area contrast.
            They were rounded-control (9px) — three squircles the comment above
            them called circles, and the one shape the product uses everywhere
            else for a bare glyph you press (see pressableVariants' `icon`). */}
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
            title={activeTitle || "Juno"}
            animate={activeConversation?.titleSource === "ai"}
            className="min-w-0 flex-1 px-1"
            textClassName="text-base font-semibold tracking-tight text-foreground"
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
            onClick={() => { router.push("/chat"); window.dispatchEvent(new CustomEvent("juno:new-chat")); }}
            aria-label="New chat"
          >
            <Plus className="size-5" />
          </Button>
        </div>

        {/* Floating seamless Chat ⇄ Work Switcher and Top Actions (no background, no divider border) */}
        {showSurfaceSwitcher && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-center px-4">
            <div className="pointer-events-auto">
              <ChatWorkSwitcher />
            </div>
            <div
              id="juno-top-actions-slot"
              className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 md:right-4"
            />
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>

      <Onboarding />
      <AnnouncementPopup />
      <CommandPalette />
    </div>
  );
}
