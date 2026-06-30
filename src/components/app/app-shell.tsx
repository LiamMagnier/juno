"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Menu, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Onboarding } from "@/components/app/onboarding";
import { CommandPalette } from "@/components/app/command-palette";
import { AnnouncementPopup } from "@/components/app/announcement-popup";
import { useApp } from "@/components/app/app-provider";
import { DotField } from "@/components/signature/dot-field";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "juno:sidebar-collapsed";
const PREFETCH_ROUTES = ["/chat", "/library", "/artifacts", "/projects", "/memory", "/settings", "/roadmap", "/upgrade"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen } = useApp();
  const router = useRouter();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
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

      <aside
        className={cn(
          "hidden shrink-0 border-r border-sidebar-border transition-[width] duration-base ease-out-soft md:block",
          collapsed ? "w-[64px]" : "w-[280px]"
        )}
      >
        <AppSidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      </aside>

      {/* Mobile drawer — Radix-backed Sheet (focus trap, Escape, scroll lock). */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent className="p-0 md:hidden" title="Conversations">
          <AppSidebar />
        </SheetContent>
      </Sheet>

      <main
        className="flex min-w-0 flex-1 flex-col"
        style={{ "--juno-sidebar-width": collapsed ? "64px" : "280px" } as React.CSSProperties}
      >
        <div className="flex shrink-0 items-center gap-2 border-b bg-background/90 px-2 py-2 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <span className="font-serif text-xl font-semibold tracking-tight text-foreground">Juno</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
            aria-label="Search (command palette)"
          >
            <Search className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => { router.push("/chat"); window.dispatchEvent(new CustomEvent("juno:new-chat")); }} aria-label="New chat">
            <Plus className="h-5 w-5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </main>

      <Onboarding />
      <AnnouncementPopup />
      <CommandPalette />
    </div>
  );
}
