"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Menu, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "@/components/app/app-sidebar";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Onboarding } from "@/components/app/onboarding";
import { CommandPalette } from "@/components/app/command-palette";
import { PageTransition } from "@/components/app/page-transition";
import { AnnouncementPopup } from "@/components/app/announcement-popup";
import { useApp } from "@/components/app/app-provider";
import { DotField } from "@/components/signature/dot-field";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "juno:sidebar-collapsed";
const WIDTH_KEY = "juno:sidebar:width";
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 280;
const PREFETCH_ROUTES = ["/chat", "/library", "/artifacts", "/projects", "/memory", "/settings", "/roadmap", "/upgrade"];

function clampWidth(w: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen, activeConversationId, conversations } = useApp();
  const router = useRouter();
  const [collapsed, setCollapsed] = React.useState(false);
  // Resizable sidebar (desktop). Width lives in state + a CSS var on the aside;
  // the ref mirrors it so pointermove handlers never read a stale closure.
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT);
  const [resizing, setResizing] = React.useState(false);
  const widthRef = React.useRef(SIDEBAR_DEFAULT);
  const activeTitle = activeConversationId ? conversations.find((c) => c.id === activeConversationId)?.title : null;

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
      <div className="pointer-events-none fixed inset-0 -z-10">
        <DotField />
      </div>

      {/* overflow-hidden + fixed-width sidebar layouts: the width sweep reveals/clips
          the content instead of reflowing it mid-animation. The expanded width is
          user-resizable (drag handle below); --juno-sidebar-width carries it to the
          sidebar's inner column, which must NOT track the aside mid-collapse. The
          width transition is dropped while dragging so resize follows the pointer
          1:1 instead of lagging through the ease. */}
      <aside
        className={cn(
          "relative hidden shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar md:block",
          !resizing && "transition-[width] duration-base ease-out-soft"
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
            {/* Invisible until engaged: a hairline highlight on hover/drag/focus. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 right-0 w-[2px] bg-primary/60 opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100",
                resizing && "opacity-100"
              )}
            />
          </div>
        )}
      </aside>

      {/* Mobile drawer — Radix-backed Sheet (focus trap, Escape, scroll lock). */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent className="p-0 md:hidden" title="Conversations">
          <AppSidebar />
        </SheetContent>
      </Sheet>

      <main
        className="flex min-w-0 flex-1 flex-col"
        style={{ "--juno-sidebar-width": collapsed ? "64px" : `${sidebarWidth}px` } as React.CSSProperties}
      >
        <div className="flex shrink-0 items-center gap-2 border-b bg-background/90 px-2 py-2 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <AnimatedTitle
            title={activeTitle || "Juno"}
            className="min-w-0 flex-1"
            textClassName="font-serif text-xl font-semibold tracking-tight text-foreground"
          />
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
            aria-label="Search chats and projects"
          >
            <Search className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => { router.push("/chat"); window.dispatchEvent(new CustomEvent("juno:new-chat")); }} aria-label="New chat">
            <Plus className="h-5 w-5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>

      <Onboarding />
      <AnnouncementPopup />
      <CommandPalette />
    </div>
  );
}
