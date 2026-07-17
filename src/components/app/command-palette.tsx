"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Box,
  CalendarClock,
  Code,
  Columns2,
  Keyboard,
  Library,
  Map as MapIcon,
  MessageSquare,
  Moon,
  NotebookPen,
  Plug,
  Plus,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

/** One row in either palette. `run` fires on click / Enter; `meta` is the muted
 *  trailing text (relative time, "Project"); `hint` renders as ⌘-keys. */
type PaletteItem = {
  id: string;
  group: string;
  label: string;
  meta?: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  run: () => void;
};

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border/70 bg-muted/80 px-1 font-mono text-[10px] leading-none text-muted-foreground shadow-[0_1px_0_hsl(var(--border)/0.7)]">
      {children}
    </kbd>
  );
}

/** Compact relative time for the trailing meta ("Just now", "2d", "3mo"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * The shared palette surface — one shell, two surfaces (search + command menu).
 * It owns everything a11y/motion: the combobox input (role=combobox +
 * aria-activedescendant), the role=listbox/option rows, the single sliding
 * highlight bar (measured translateY geometry), arrow-key nav + scrollIntoView,
 * Enter-to-run, Escape (via Radix Dialog), and the pop-in/out keyframes. Each
 * surface just hands it an ordered `items` list, a `placeholder`, a `footer`,
 * and an `emptyState`.
 */
function PaletteShell({
  open,
  onOpenChange,
  ariaLabel,
  placeholder,
  query,
  onQueryChange,
  items,
  footer,
  emptyState,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ariaLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (v: string) => void;
  items: PaletteItem[];
  footer: React.ReactNode;
  emptyState: React.ReactNode;
}) {
  const [active, setActive] = React.useState(0);
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = React.useCallback((cmdId: string) => `${baseId}-opt-${cmdId}`, [baseId]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const highlightRef = React.useRef<HTMLDivElement>(null);
  // True when `active` last changed via the keyboard, so we only auto-scroll then
  // (not while the mouse is hovering rows).
  const keyboardNav = React.useRef(false);

  // Reset the cursor to the top each time the surface opens.
  React.useEffect(() => {
    if (open) setActive(0);
  }, [open]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        // svh + inset-x centering (no transform) so the pop-in/out keyframes own
        // `transform`, and the palette stays reachable above the mobile keyboard.
        className="left-0 right-0 top-[9svh] mx-auto w-[calc(100%-2rem)] max-w-[560px] origin-top translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-panel border-border/60 p-0 shadow-glass data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector("input")?.focus();
        }}
      >
        <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>

        {/* Search — the palette's one input, given real presence (52px) rather
            than the density of a list row. */}
        <div className="flex items-center gap-3 border-b border-border/60 px-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-muted-foreground/60"
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? optionId(items[active].id) : undefined}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="pressable -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-fast hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Combobox popup: focus stays on the input; aria-activedescendant
            tracks the highlighted option, so rows are role=option and out of
            the tab order. Group headers are visual-only (aria-hidden). */}
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="relative max-h-[min(56svh,calc(100dvh-10rem))] overflow-y-auto overscroll-contain scroll-fade-y p-1.5"
        >
          {/* One highlight that glides between rows. `transform` is animated
              (not top), so it stays on the compositor. */}
          <div
            ref={highlightRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-1.5 right-1.5 top-0 rounded-xl bg-accent opacity-0 transition-[transform,height,opacity] duration-base ease-spring motion-reduce:transition-none"
          />
          {items.length === 0
            ? emptyState
            : items.map((c, i) => {
                const showHeader = i === 0 || items[i - 1].group !== c.group;
                const Icon = c.icon;
                const isActive = active === i;
                return (
                  <React.Fragment key={c.id}>
                    {showHeader && (
                      // The sliding highlight is this list's real :first-child, so a
                      // `first:` variant here would never match — key the tighter top
                      // padding off the index instead.
                      <div
                        aria-hidden="true"
                        className={cn(
                          "px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/70",
                          i === 0 ? "pt-1.5" : "pt-3"
                        )}
                      >
                        {c.group}
                      </div>
                    )}
                    <button
                      type="button"
                      id={optionId(c.id)}
                      role="option"
                      tabIndex={-1}
                      data-index={i}
                      onMouseMove={() => setActive(i)}
                      onClick={() => c.run()}
                      aria-selected={isActive}
                      className={cn(
                        "group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-fast ease-out-soft coarse:py-2.5",
                        isActive ? "text-foreground" : "text-foreground/75"
                      )}
                    >
                      {/* Icon tile — gives every row a consistent optical anchor
                          and lets the active state read without moving anything.
                          rounded-md (8px): the row is rounded-xl (12px) and the tile
                          sits 8px/10px inside it, so ~8px is the concentric read.
                          NB rounded-lg is 24px here — on a 28px tile that is a circle. */}
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors duration-fast ease-out-soft",
                          isActive
                            ? "border-border/70 bg-background text-foreground shadow-soft"
                            : "border-transparent bg-muted/50 text-muted-foreground"
                        )}
                      >
                        <Icon className="h-[15px] w-[15px]" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.meta && (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">{c.meta}</span>
                      )}
                      {c.hint && (
                        <span className="flex shrink-0 items-center gap-1">
                          {c.hint.split("").map((k, ki) => (
                            <Kbd key={ki}>{k}</Kbd>
                          ))}
                        </span>
                      )}
                    </button>
                  </React.Fragment>
                );
              })}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 bg-muted/25 px-3.5 py-2.5 font-mono text-[10px] text-muted-foreground/80">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Projects aren't in app context, so the search surface fetches them on open. */
type PaletteProject = { id: string; name: string; starred: boolean; updatedAt: string };

/**
 * SURFACE A — Search. The magnifying-glass button opens this (event
 * "juno:search"); it does NOT open on ⌘K. A clean chats + projects finder:
 * chats from app context, projects fetched on open. Empty query shows recent
 * chats and recent/starred projects.
 */
function SearchPalette() {
  const router = useRouter();
  const { conversations } = useApp();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [projects, setProjects] = React.useState<PaletteProject[]>([]);

  const go = React.useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router]
  );

  React.useEffect(() => {
    const openSearch = () => setOpen(true);
    window.addEventListener("juno:search", openSearch);
    return () => window.removeEventListener("juno:search", openSearch);
  }, []);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Refresh projects each time the surface opens; keep the last list visible
  // until the fresh one lands so the default view doesn't flash empty.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        const list: Array<{ id?: unknown; name?: unknown; starred?: unknown; updatedAt?: unknown }> = Array.isArray(
          data.projects
        )
          ? data.projects
          : [];
        setProjects(
          list.map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? ""),
            starred: Boolean(p.starred),
            updatedAt: String(p.updatedAt ?? ""),
          }))
        );
      })
      .catch(() => {
        /* keep whatever we had; the empty state stays honest */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const q = query.trim().toLowerCase();

  const items = React.useMemo<PaletteItem[]>(() => {
    const chats = conversations.filter((c) => c.kind !== "code");
    const chatItems: PaletteItem[] = (
      q
        ? chats.filter((c) => c.title.toLowerCase().includes(q))
        : [...chats]
            .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
            .slice(0, 8)
    ).map((c) => ({
      id: "chat-" + c.id,
      group: "Chats",
      label: c.title || "New chat",
      meta: relativeTime(c.lastMessageAt),
      icon: MessageSquare,
      run: () => go("/chat/" + c.id),
    }));

    const projItems: PaletteItem[] = (
      q
        ? projects.filter((p) => p.name.toLowerCase().includes(q))
        : [...projects]
            .sort(
              (a, b) =>
                Number(b.starred) - Number(a.starred) ||
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            )
            .slice(0, 6)
    ).map((p) => ({
      id: "project-" + p.id,
      group: "Projects",
      label: p.name || "Untitled project",
      meta: "Project",
      icon: Box,
      run: () => go("/projects/" + p.id),
    }));

    return [...chatItems, ...projItems];
  }, [conversations, projects, q, go]);

  const footer = (
    <>
      <span className="flex items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span className="ml-0.5">navigate</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        <span className="ml-0.5">open</span>
        <span className="mx-1 text-border">·</span>
        <Kbd>esc</Kbd>
        <span className="ml-0.5">close</span>
      </span>
    </>
  );

  const emptyState = (
    <div className="px-3 py-10 text-center">
      <p className="text-sm text-muted-foreground">
        {q ? `No chats or projects match “${query}”.` : "No chats or projects yet"}
      </p>
      <p className="mt-1 text-caption text-muted-foreground/60">
        {q ? "Try a different search." : "Start a chat or create a project to see it here."}
      </p>
    </div>
  );

  return (
    <PaletteShell
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Search chats and projects"
      placeholder="Search chats and projects"
      query={query}
      onQueryChange={setQuery}
      items={items}
      footer={footer}
      emptyState={emptyState}
    />
  );
}

/**
 * SURFACE B — Command menu. Keyboard-first (⌘K, plus the "juno:command-palette"
 * event). A fuller palette: quick actions, recent chats, and every navigation
 * destination + the theme toggle and shortcuts sheet. A typed query filters
 * across all three groups.
 */
function CommandMenu() {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const { conversations, setSettings } = useApp();
  const [open, setOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const go = React.useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router]
  );

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
        window.dispatchEvent(new CustomEvent("juno:new-chat"));
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    const openMenu = () => setOpen(true);
    const openShortcuts = () => setShortcutsOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("juno:command-palette", openMenu);
    window.addEventListener("juno:shortcuts", openShortcuts);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("juno:command-palette", openMenu);
      window.removeEventListener("juno:shortcuts", openShortcuts);
    };
  }, [router]);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();

  const items = React.useMemo<PaletteItem[]>(() => {
    const matches = (label: string, keywords?: string) =>
      !q || label.toLowerCase().includes(q) || (keywords ? keywords.includes(q) : false);

    const quick: PaletteItem[] = [
      {
        id: "new-chat",
        group: "Quick actions",
        label: "New chat",
        hint: "⌘⇧O",
        icon: Plus,
        keywords: "start compose message",
        run: () => {
          go("/chat");
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        },
      },
      {
        id: "new-code",
        group: "Quick actions",
        label: "New code session",
        icon: Terminal,
        keywords: "code start workspace session mac",
        run: () => go("/code/new"),
      },
      {
        id: "new-task",
        group: "Quick actions",
        label: "New scheduled task",
        icon: CalendarClock,
        keywords: "schedule recurring automation cron reminder",
        run: () => go("/tasks"),
      },
    ].filter((c) => matches(c.label, c.keywords));

    const chats = conversations.filter((c) => c.kind !== "code");
    const recentChats: PaletteItem[] = (
      q
        ? chats.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 6)
        : [...chats]
            .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
            .slice(0, 5)
    ).map((c) => ({
      id: "recent-" + c.id,
      group: "Recents",
      label: c.title || "New chat",
      meta: relativeTime(c.lastMessageAt),
      icon: MessageSquare,
      run: () => go("/chat/" + c.id),
    }));
    const recents: PaletteItem[] = [...recentChats];
    // "See all" hands off to the dedicated search surface (Surface A).
    if (!q && chats.length > 0) {
      recents.push({
        id: "see-all-chats",
        group: "Recents",
        label: "Search all chats and projects",
        icon: Search,
        run: () => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent("juno:search"));
        },
      });
    }

    const actions: PaletteItem[] = [
      { id: "projects", group: "Actions", label: "Projects", icon: Box, keywords: "workspaces group", run: () => go("/projects") },
      { id: "code", group: "Actions", label: "Code", icon: Code, keywords: "sessions pull requests github reviews juno code", run: () => go("/code/pulls") },
      { id: "artifacts", group: "Actions", label: "Artifacts", icon: Shapes, keywords: "documents canvas generated", run: () => go("/artifacts") },
      { id: "library", group: "Actions", label: "Library", icon: Library, keywords: "saved prompts snippets", run: () => go("/library") },
      { id: "connections", group: "Actions", label: "Connections", icon: Plug, keywords: "plugins integrations github mcp connectors", run: () => go("/connections") },
      { id: "tasks", group: "Actions", label: "Tasks", icon: CalendarClock, keywords: "scheduled recurring automation", run: () => go("/tasks") },
      { id: "compare", group: "Actions", label: "Compare models", icon: Columns2, keywords: "side by side race versus models", run: () => go("/compare") },
      { id: "memory", group: "Actions", label: "Memory", icon: NotebookPen, keywords: "remember facts", run: () => go("/memory") },
      { id: "settings", group: "Actions", label: "Settings", icon: Settings, keywords: "preferences account theme", run: () => go("/settings") },
      { id: "roadmap", group: "Actions", label: "Roadmap & feature requests", icon: MapIcon, keywords: "feedback vote ideas", run: () => go("/roadmap") },
      { id: "upgrade", group: "Actions", label: "Plans & upgrade", icon: Sparkles, keywords: "billing pro max pricing", run: () => go("/upgrade") },
      {
        id: "theme",
        group: "Actions",
        label: `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`,
        icon: resolvedTheme === "dark" ? Sun : Moon,
        keywords: "theme dark light appearance",
        run: () => {
          toggleTheme();
          setOpen(false);
        },
      },
      {
        id: "shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        hint: "⌘/",
        icon: Keyboard,
        keywords: "keys help",
        run: () => {
          setOpen(false);
          setShortcutsOpen(true);
        },
      },
    ].filter((c) => matches(c.label, c.keywords));

    return [...quick, ...recents, ...actions];
  }, [conversations, q, go, resolvedTheme, toggleTheme]);

  const footer = (
    <>
      <span className="flex items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span className="ml-0.5">select</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        <span className="ml-0.5">open</span>
        <span className="mx-1 text-border">·</span>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </span>
    </>
  );

  const emptyState = (
    <div className="px-3 py-10 text-center">
      <p className="text-sm text-muted-foreground">No matches for “{query}”.</p>
      <p className="mt-1 text-caption text-muted-foreground/60">Try a chat title, or a command like “settings”.</p>
    </div>
  );

  return (
    <>
      <PaletteShell
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Command menu"
        placeholder="Search or start a chat"
        query={query}
        onQueryChange={setQuery}
        items={items}
        footer={footer}
        emptyState={emptyState}
      />
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

/** Mounts both surfaces: ⌘K → command menu, magnifying glass → search. */
export function CommandPalette() {
  return (
    <>
      <CommandMenu />
      <SearchPalette />
    </>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Open command menu" },
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
