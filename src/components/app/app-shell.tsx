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
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "juno:sidebar-collapsed";
const WIDTH_KEY = "juno:sidebar:width";
const SIDEBAR_MIN = 224;
const SIDEBAR_MAX = 336;
const SIDEBAR_DEFAULT = 256;
const RAIL_WIDTH = 64;
// The landing route of every product mode belongs here: switching modes routes
// immediately, so a cold /work is the one navigation the user cannot absorb as
// "the page is loading".
const PREFETCH_ROUTES = ["/chat", "/work", "/design", "/library", "/artifacts", "/projects", "/memory", "/settings", "/roadmap", "/upgrade"];

function clampWidth(w: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

/**
 * A 2px line along the top of the content while a reply streams — the
 * quietest "working" signal there is, and the one thing about a generation
 * that is visible from any scroll position, including with the transcript
 * scrolled away from the composer's stop button. Driven by `juno:streaming`
 * from chat-view; `.stream-progress` (globals.css) owns the sweep.
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

  // Work's header row. Chat draws the same switcher itself, inside its own
  // column, so it stays centred over the transcript when a canvas opens
  // beside it — a full-width row here would leave it centred over both.
  const showSurfaceSwitcher = !!pathname?.startsWith("/work");

  const [collapsed, setCollapsed] = React.useState(false);
  // md–lg: the expanded panel FLOATS over the content instead of pushing it,
  // with a soft dismiss. A 256px column in a 900px window leaves a transcript
  // narrower than a phone; the rail stays in flow and the full panel becomes
  // an overlay you summon and dismiss.
  const [narrow, setNarrow] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
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

  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");
    const sync = () => setNarrow(mq.matches);
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
    const collapseSidebar = () => setCollapsedPersist(true);
    window.addEventListener("juno:collapse-sidebar", collapseSidebar);
    return () => window.removeEventListener("juno:collapse-sidebar", collapseSidebar);
  }, [setCollapsedPersist]);

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

  const toggleCollapse = React.useCallback(() => setCollapsedPersist((prev) => !prev), [setCollapsedPersist]);

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
  const floating = narrow && !collapsed;
  const floatingRef = React.useRef(floating);
  floatingRef.current = floating;
  React.useEffect(() => {
    if (floatingRef.current) setCollapsedPersist(true);
    // Only the route change should dismiss it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div className="relative flex h-dvh overflow-hidden">
      {/* Bypass Blocks (SC 2.4.1, Level A). */}
      <a
        href="#juno-main"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-toast focus-visible:rounded-field focus-visible:border focus-visible:border-border focus-visible:bg-popover focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:shadow-float"
      >
        Skip to content
      </a>

      {/* At md–lg the rail keeps its 64px in flow and the expanded panel floats
          over the content; a click anywhere outside it folds it back. */}
      {floating && (
        <>
          <div aria-hidden className="absolute left-0 top-0 hidden h-full w-[64px] shrink-0 bg-sidebar md:block" />
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setCollapsedPersist(true)}
            className="absolute inset-0 z-30 hidden cursor-default bg-foreground/5 motion-safe:animate-fade-in md:block"
          />
        </>
      )}

      {/* overflow-hidden + fixed-width sidebar layouts: the width sweep reveals/clips
          the content instead of reflowing it mid-animation. The width transition is
          dropped while dragging so resize follows the pointer 1:1. `ease-in-out`:
          both endpoints of a collapse are on screen, so this is an A-to-B move. */}
      <aside
        data-floating={floating ? "" : undefined}
        className={cn(
          "app-sidebar-frame hidden shrink-0 overflow-hidden bg-sidebar md:block",
          floating ? "absolute inset-y-0 left-0 z-40" : "relative",
          !resizing && "transition-[width] duration-base ease-in-out"
        )}
        style={
          {
            width: collapsed ? RAIL_WIDTH : sidebarWidth,
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
          popover ground it lands on (see the note in sheet.tsx). */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent className="p-0 dark:[--sidebar-accent:48_5%_18%] dark:[--sidebar-border:48_5%_22%] md:hidden" title="Conversations">
          <AppSidebar />
        </SheetContent>
      </Sheet>

      <main
        id="juno-main"
        tabIndex={-1}
        className="app-main-canvas relative flex min-w-0 flex-1 flex-col"
        style={{ "--juno-sidebar-width": collapsed || floating ? `${RAIL_WIDTH}px` : `${sidebarWidth}px` } as React.CSSProperties}
      >
        <StreamProgress active={streaming} />

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
            onClick={() => {
              router.push("/chat");
              window.dispatchEvent(new CustomEvent("juno:new-chat"));
            }}
            aria-label="New chat"
          >
            <Plus className="size-5" />
          </Button>
        </div>

        {/* The Chat ⇄ Work switcher and the page's top actions, IN FLOW.

            This row used to be absolutely positioned over the transcript with
            no background, on the reasoning that the page should continue
            through it. It did — and so did the first user bubble, which sat
            underneath the toggle on every conversation that opened scrolled to
            its top. A 56px row the content lays out below costs the transcript
            nothing it was using, and there is no collision to manage. */}
        {showSurfaceSwitcher && (
          <div className="relative z-20 hidden h-14 shrink-0 items-center justify-center px-4 md:flex">
            <ChatWorkSwitcher />
            <div id="juno-top-actions-slot" className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 md:right-4" />
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
