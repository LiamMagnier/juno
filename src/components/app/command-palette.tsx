"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Brain,
  Columns2,
  Keyboard,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DotField } from "@/components/signature/dot-field";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

type Cmd = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  run: () => void;
};

const GROUP_ORDER: Record<string, number> = { Actions: 0, Conversations: 1, Navigate: 2, Appearance: 3 };

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded border border-border/80 bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const { conversations, setSettings } = useApp();
  const [open, setOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const highlightRef = React.useRef<HTMLDivElement>(null);
  // True when `active` last changed via the keyboard, so we only auto-scroll then
  // (not while the mouse is hovering rows).
  const keyboardNav = React.useRef(false);

  const go = React.useCallback((href: string) => {
    router.push(href);
    setOpen(false);
  }, [router]);

  const toggleTheme = React.useCallback(() => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(next);
    setSettings({ theme: next });
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next }),
    }).catch(() => {});
  }, [resolvedTheme, setSettings, setTheme]);

  // Global hotkeys + event bus (so the user menu can open these too).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOpen(false);
        router.push("/chat");
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    const openPalette = () => setOpen(true);
    const openShortcuts = () => setShortcutsOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("juno:command-palette", openPalette);
    window.addEventListener("juno:shortcuts", openShortcuts);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("juno:command-palette", openPalette);
      window.removeEventListener("juno:shortcuts", openShortcuts);
    };
  }, [router]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const q = query.trim().toLowerCase();

  const items = React.useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { id: "new", group: "Actions", label: "New chat", hint: "⌘⇧O", icon: Plus, keywords: "start compose", run: () => go("/chat") },
      { id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", hint: "⌘/", icon: Keyboard, keywords: "keys help", run: () => { setOpen(false); setShortcutsOpen(true); } },
      { id: "compare", group: "Navigate", label: "Compare models", icon: Columns2, keywords: "side by side race versus models", run: () => go("/compare") },
      { id: "settings", group: "Navigate", label: "Settings", icon: Settings, keywords: "preferences account theme", run: () => go("/settings") },
      { id: "memory", group: "Navigate", label: "Memory", icon: Brain, keywords: "remember facts", run: () => go("/memory") },
      { id: "roadmap", group: "Navigate", label: "Roadmap & feature requests", icon: MapIcon, keywords: "feedback vote ideas", run: () => go("/roadmap") },
      { id: "upgrade", group: "Navigate", label: "Plans & upgrade", icon: Sparkles, keywords: "billing pro max pricing", run: () => go("/upgrade") },
      { id: "theme", group: "Appearance", label: `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`, icon: resolvedTheme === "dark" ? Sun : Moon, keywords: "theme dark light appearance", run: () => { toggleTheme(); setOpen(false); } },
    ];
    const filteredBase = base.filter((c) => !q || c.label.toLowerCase().includes(q) || c.keywords?.includes(q));
    const convoCmds: Cmd[] = conversations
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .slice(0, q ? 6 : 4)
      .map((c) => ({ id: "c-" + c.id, group: "Conversations", label: c.title, icon: MessageSquare, run: () => go("/chat/" + c.id) }));
    return [...filteredBase, ...convoCmds].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  }, [conversations, go, q, resolvedTheme, toggleTheme]);

  React.useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Sliding selection highlight — one bar that glides between rows instead of
  // each row toggling its own background.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const hl = highlightRef.current;
    if (!list || !hl) return;
    const el = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!el) {
      hl.style.opacity = "0";
      return;
    }
    hl.style.opacity = "1";
    hl.style.transform = `translateY(${el.offsetTop}px)`;
    hl.style.height = `${el.offsetHeight}px`;
  }, [active, items]);

  // Keep the highlighted row in view when navigating with the arrow keys.
  React.useEffect(() => {
    if (!keyboardNav.current) return;
    keyboardNav.current = false;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    // For the first row, scroll to the very top so its group header shows too.
    if (active === 0) listRef.current?.scrollTo({ top: 0 });
    else el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNav.current = true;
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNav.current = true;
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          hideClose
          // svh + inset-x centering (no transform) so the pop-in/out keyframes own
          // `transform`, and the palette stays reachable above the mobile keyboard.
          className="left-0 right-0 top-[10svh] mx-auto w-[calc(100%-2rem)] max-w-xl origin-top translate-x-0 translate-y-0 gap-0 overflow-hidden p-0 shadow-glass data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <div className="pointer-events-none absolute inset-0 -z-10 opacity-40">
            <DotField spacing={26} interactive={false} />
          </div>

          <div className="flex items-center gap-2.5 border-b border-border/70 px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search commands, chats…"
              className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Command palette search"
            />
          </div>

          <div
            ref={listRef}
            className="relative max-h-[min(52svh,calc(100dvh-9rem))] overflow-y-auto overscroll-contain p-2"
          >
            <div
              ref={highlightRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-2 right-2 top-0 rounded-md bg-accent opacity-0 transition-[transform,height,opacity] duration-fast ease-out-soft"
            />
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                No matches for “{query}”.
              </p>
            ) : (
              items.map((c, i) => {
                const showHeader = i === 0 || items[i - 1].group !== c.group;
                const Icon = c.icon;
                return (
                  <React.Fragment key={c.id}>
                    {showHeader && (
                      <div className="px-3 pb-1 pt-3 font-mono text-label uppercase text-muted-foreground/60">
                        {c.group}
                      </div>
                    )}
                    <button
                      type="button"
                      data-index={i}
                      onMouseMove={() => setActive(i)}
                      onClick={() => c.run()}
                      aria-selected={active === i}
                      className={cn(
                        "relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-fast ease-out-soft coarse:py-2.5",
                        active === i ? "text-foreground" : "text-foreground/80"
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors duration-fast ease-out-soft",
                          active === i ? "text-foreground" : "text-muted-foreground"
                        )}
                      />
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="font-mono text-[10px] text-muted-foreground">{c.hint}</span>}
                    </button>
                  </React.Fragment>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border/70 px-4 py-2 font-mono text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              select
              <span className="mx-1">·</span>
              <Kbd>esc</Kbd>
              close
            </span>
          </div>
        </DialogContent>
      </Dialog>

      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Open command palette" },
  { keys: ["⌘", "⇧", "O"], label: "New chat" },
  { keys: ["⌘", "/"], label: "Keyboard shortcuts" },
  { keys: ["↵"], label: "Send message" },
  { keys: ["⇧", "↵"], label: "New line in composer" },
  { keys: ["Esc"], label: "Close dialog / stop streaming" },
];

function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="font-serif text-heading">Keyboard shortcuts</DialogTitle>
        <ul className="mt-2 divide-y divide-border/60">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between py-2.5 text-sm">
              <span className="text-foreground/90">{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <Kbd key={i}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
