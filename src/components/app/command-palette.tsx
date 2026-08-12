"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BookOpen,
  Columns2,
  FileText,
  Keyboard,
  Map as MapIcon,
  MessageSquare,
  MessageSquareText,
  Moon,
  NotebookPen,
  Search,
  Settings,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app/app-provider";
import { AppIcons } from "@/lib/app-icons";
import {
  SEARCH_TYPE_LABELS,
  SEARCH_WINDOWS,
  SEARCH_WINDOW_LABELS,
  type SearchHit,
  type SearchMark,
  type SearchSnippet,
  type SearchType,
  type SearchWindow,
  type UnifiedSearchResult,
} from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { Pressable } from "@/components/ui/pressable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { staggerDelay } from "@/lib/motion";

/** One row in either palette. `run` fires on click / Enter; `meta` is the muted
 *  trailing text (relative time, "Project"); `hint` renders as ⌘-keys. A
 *  `snippet` turns the row into two lines — the matched line of content under
 *  the title, with the matched terms marked. */
type PaletteItem = {
  id: string;
  group: string;
  label: string;
  meta?: string;
  hint?: string;
  snippet?: SearchSnippet | null;
  /** Matched spans inside `label`, so a title-only match is highlighted too. */
  labelMarks?: SearchMark[];
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  run: () => void;
};

/**
 * Text with its matched spans marked.
 *
 * The server sends offsets rather than markup (see src/lib/search/types.ts), so
 * this walks them and emits real `<mark>` elements — which is also what makes
 * the highlight legible to a screen reader, since `mark` carries meaning that a
 * coloured `span` does not.
 *
 * `bg-primary/15` deliberately, not `bg-accent`: `accent` is the sliding
 * selection bar's own colour, so a mark painted with it would vanish on exactly
 * the row the user is looking at.
 */
function Marked({ text, marks }: { text: string; marks: readonly SearchMark[] }) {
  if (marks.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  marks.forEach((mark, i) => {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(
      <mark key={i} className="rounded-micro bg-primary/15 px-0.5 text-primary-ink">
        {text.slice(mark.start, mark.end)}
      </mark>
    );
    cursor = mark.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-border/70 bg-muted/80 px-1 font-mono text-[10px] leading-none text-muted-foreground shadow-[0_1px_0_hsl(var(--border)/0.7)]">
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
  filters,
  notices,
  status,
  resetKey,
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
  /** Optional controls between the input and the listbox (search filters). */
  filters?: React.ReactNode;
  /** Optional "here is what could not be searched" strip above the results. */
  notices?: React.ReactNode;
  /** Text announced politely whenever the result set changes. */
  status?: string;
  /**
   * Moves the cursor back to the first row when it changes. The command menu
   * leaves it undefined and keeps its old behaviour; search passes the query
   * and its filters, because a cursor left on row 7 while the results underneath
   * it are replaced is how Enter opens something nobody chose.
   */
  resetKey?: string;
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

  // Reset the cursor to the top each time the surface opens, and whenever the
  // caller says the list underneath it has been replaced.
  React.useEffect(() => {
    if (open) setActive(0);
  }, [open, resetKey]);

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
        // Surface/radius/border come from DialogContent; only the position,
        // size and the pop-in keyframes are the palette's own.
        //
        // `[translate:none]` is load-bearing: DialogContent centres itself on the
        // independent `translate` property now, and a translate-x/y utility writes
        // `transform`, so it can no longer cancel it. The palette is not centred
        // vertically, so it has to switch that property off outright.
        //
        // The 180/120 tier stays: Cmd+K is keyboard-initiated and opened dozens of
        // times a day, so it is rightly the fastest overlay in the product. Only the
        // `!` goes, now that DialogContent no longer ships a competing
        // tailwindcss-animate chain for it to beat.
        className="left-0 right-0 top-[9svh] mx-auto w-[calc(100%-2rem)] max-w-[560px] origin-top [translate:none] translate-x-0 translate-y-0 gap-0 overflow-hidden p-0 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector("input")?.focus();
        }}
      >
        <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>

        {/* Search — the palette's one input, given real presence (52px) rather
            than the density of a list row. */}
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-muted-foreground"
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? optionId(items[active].id) : undefined}
          />
          {query && (
            <Pressable
              kind="icon"
              size="sm"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="-mr-1 size-6 shrink-0 text-muted-foreground coarse:size-6"
            >
              <X className="h-3.5 w-3.5" />
            </Pressable>
          )}
        </div>

        {filters}
        {notices}

        {/* The listbox is a visual change, not an announced one — a screen
            reader following aria-activedescendant hears the focused row but
            never hears that eleven others arrived, or that a whole source could
            not be searched. This says both, once per settled result set. */}
        <div role="status" aria-live="polite" className="sr-only">
          {status}
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
            // `bg-foreground/10`, not `bg-accent`. On the dark theme --accent and
            // --popover are the SAME value (48 5% 13%), and this bar floats on a
            // popover — so the one thing telling you which row Enter will open
            // was painted in the exact colour of the panel behind it and could
            // not be seen at all. An ink tint lifts off whatever is under it in
            // both themes, which is the same reasoning the row's icon tile below
            // already runs on.
            //
            // rounded-menu, not rounded-field: the shell is rounded-panel (18px)
            // and the list insets it by p-1.5 (6px), so 12px is the concentric
            // radius. The comment on the tile below assumed rounded-field WAS
            // 12px; it is 10 (tailwind.config.ts), so the bar and every row under
            // it were drawn 2px too tight for the panel they sit in.
            className="pointer-events-none absolute left-1.5 right-1.5 top-0 rounded-menu bg-foreground/10 opacity-0 transition-[transform,height,opacity] duration-base ease-out-strong motion-reduce:transition-none"
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
                        // The shell's eyebrow, not a fourth treatment for it.
                        // Floating surfaces (onboarding, the announcement, this)
                        // all set a group header as a mono uppercase label; this
                        // one was 11px sans at /70, which is both off the scale and
                        // under 4.5:1 on the black ground.
                        className={cn(
                          "px-2.5 pb-1 font-mono text-label uppercase text-muted-foreground",
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
                        "menu-item group group/menu-item relative flex w-full gap-3 rounded-menu px-2.5 py-2 text-left text-sm transition-colors duration-fast ease-out-soft coarse:py-2.5",
                        // A two-line result row hangs its icon and trailing meta
                        // off the title, not off the centre of the pair.
                        c.snippet ? "items-start" : "items-center",
                        isActive ? "text-foreground" : "text-foreground/75"
                      )}
                    >
                      {/* Icon tile — gives every row a consistent optical anchor
                          and lets the active state read without moving anything.
                          rounded-xs (6px): the row is rounded-menu (12px) and the
                          tile sits 8px/10px inside it, so the concentric answer is
                          12 MINUS the inset, not 12 minus 4 — the old sum ran the
                          subtraction the wrong way and landed on an 8px value that
                          is not on the ladder either. 6px is the nearest rung. */}
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-xs border transition-colors duration-fast ease-out-soft",
                          // `bg-foreground/10`, not a surface token: the tile has
                          // to LIFT above the sliding highlight bar it sits on, and
                          // no surface does that in both themes (--card is 99% on
                          // light and 6.5% on dark, --background is now pure black,
                          // i.e. 13 points BELOW the bar). An ink tint lifts off
                          // whatever is underneath it either way. shadow-soft is
                          // gone with it — black ink on black renders nothing, so
                          // the border is what draws the edge here.
                          //
                          // At rest the tile takes the popover's recessed rung
                          // whole. `bg-muted/50` composited to ~11.3% against a 13%
                          // panel — under two points, which is the threshold below
                          // which a fill is simply not there; the plate that gives
                          // every row its optical anchor was missing on dark.
                          isActive
                            ? "border-border/70 bg-foreground/10 text-foreground"
                            : "border-transparent bg-secondary text-muted-foreground"
                        )}
                      >
                        <Icon className="h-[15px] w-[15px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          <Marked text={c.label} marks={c.labelMarks ?? []} />
                        </span>
                        {c.snippet && (
                          <span className="block truncate text-[12px] leading-[1.45] text-muted-foreground">
                            <Marked text={c.snippet.text} marks={c.snippet.marks} />
                          </span>
                        )}
                      </span>
                      {c.meta && (
                        // Full --muted-foreground at the caption rung. At /55 this
                        // composited to ~2.9:1 on black — on the timestamp that is
                        // the only thing telling two same-titled chats apart.
                        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{c.meta}</span>
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

        {/* `bg-secondary`, the popover's recessed rung, not `bg-muted/25`: that
            resolved to ~12.1% against a 13% panel, so the footer strip that is
            supposed to sit BEHIND the list was the same colour as it. */}
        <div className="flex items-center justify-between border-t border-border bg-secondary px-3.5 py-2.5 font-mono text-caption text-muted-foreground">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Projects aren't in app context, so the search surface fetches them for its filter. */
type PaletteProject = { id: string; name: string; starred: boolean; updatedAt: string };

/** One row of /api/recents — the merged Chat / Work / Code / Projects timeline. */
type RecentRow = { id: string; kind: string; title: string; updatedAt: string; href: string };

const SEARCH_TYPE_ICONS: Record<SearchType, React.ComponentType<{ className?: string }>> = {
  conversation: MessageSquare,
  message: MessageSquareText,
  project: AppIcons.projects,
  file: FileText,
  knowledge: BookOpen,
  artifact: AppIcons.artifacts,
  memory: NotebookPen,
  work: AppIcons.work,
};

const RECENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  chat: MessageSquare,
  work: AppIcons.work,
  code: AppIcons.code,
  project: AppIcons.projects,
};

/**
 * How long the input rests before a search is issued.
 *
 * 180ms rather than the usual 300: the request is cancelled on the next
 * keystroke anyway, and this surface is judged on whether results appear to
 * follow the typing. Long enough to skip most intermediate words, short enough
 * that a three-word query does not feel like it is buffering.
 */
const SEARCH_DEBOUNCE_MS = 180;

/** Radix Select reserves "" for "nothing selected", so the "no project filter"
 *  option needs a real value of its own. */
const ALL_PROJECTS = "__all__";

/** A filter chip. A real button with a pressed state, not a styled div. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // No `transition-colors`: `.pressable` already declares one covering both
      // colour and transform, and a transition-* utility replaces that shorthand
      // outright — which is what dropped `transform` and left the press dip
      // snapping to scale(.97) in one frame on every chip in this strip.
      //
      // The fills are re-based on the popover this strip floats in. Both were
      // dead on dark: --accent IS --popover (48 5% 13%), so the pressed chip was
      // the panel colour, and `bg-muted/50` composited to ~11.3% against 13%,
      // i.e. under the two points where a fill starts existing. The unpressed
      // chip now takes the popover's recessed rung whole and the pressed one an
      // ink tint, which is the only thing that lifts off a floating layer.
      className={cn(
        "pressable shrink-0 rounded-full border px-2.5 py-1 text-caption coarse:min-h-11 coarse:px-3",
        active
          ? "border-border bg-foreground/10 text-foreground"
          : "border-transparent bg-secondary text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/**
 * SURFACE A — Search. The magnifying-glass button opens this (event
 * "juno:search"); it does NOT open on ⌘K.
 *
 * This used to filter the conversation titles the app context happened to be
 * holding, in the browser. That was never search: it could not see message
 * text, files, knowledge, artifacts, memories or Work, it silently excluded
 * archived chats, and it stopped at whatever the 200-row context contained.
 * There was a server-side title search behind `GET /api/conversations?q=` and
 * nothing in the repository ever passed the `q`.
 *
 * It now calls /api/search, which searches all eight sources and reports what
 * it could not cover (see src/lib/search/index.ts for why the message branch is
 * bounded). The command menu below is deliberately untouched: content search
 * and command execution share this shell, and nothing else. A palette that
 * mixes "open the thing I wrote" with "run this action" makes Enter ambiguous
 * at the exact moment it must not be.
 */
function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [type, setType] = React.useState<SearchType | "all">("all");
  const [dateWindow, setDateWindow] = React.useState<SearchWindow>("any");
  const [projectId, setProjectId] = React.useState("");
  const [projects, setProjects] = React.useState<PaletteProject[]>([]);
  const [recents, setRecents] = React.useState<RecentRow[]>([]);
  const [result, setResult] = React.useState<UnifiedSearchResult | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

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

  // A fresh surface every time: the previous query's results behind a cleared
  // input would be read as results for the empty one.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setType("all");
    setDateWindow("any");
    setProjectId("");
    setResult(null);
    setFailed(false);
  }, [open]);

  // Recents and the project list, refreshed each time the surface opens. The
  // last list stays visible until the fresh one lands so the default view does
  // not flash empty; a failure keeps whatever was there, which is why neither
  // catch clears state.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch("/api/recents?limit=8")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { items?: unknown }) => {
        if (cancelled || !Array.isArray(data.items)) return;
        setRecents(
          (data.items as Array<Record<string, unknown>>).map((row) => ({
            id: String(row.id ?? ""),
            kind: String(row.kind ?? "chat"),
            title: String(row.title ?? ""),
            updatedAt: String(row.updatedAt ?? ""),
            href: String(row.href ?? "/"),
          }))
        );
      })
      .catch(() => {});

    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { projects?: unknown }) => {
        if (cancelled || !Array.isArray(data.projects)) return;
        setProjects(
          (data.projects as Array<Record<string, unknown>>).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? ""),
            starred: Boolean(p.starred),
            updatedAt: String(p.updatedAt ?? ""),
          }))
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open]);

  const trimmed = query.trim();

  /**
   * The search itself: debounce, then one request that the next keystroke
   * aborts. Aborting matters more than the debounce — without it the answer to
   * "guar" can arrive after the answer to "guard" and overwrite it, and the
   * user watches their own results get worse as they finish the word.
   */
  React.useEffect(() => {
    if (!open || !trimmed) {
      setResult(null);
      setSearching(false);
      setFailed(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (type !== "all") params.set("types", type);
      if (projectId) params.set("projectId", projectId);
      if (dateWindow !== "any") params.set("window", dateWindow);
      fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: UnifiedSearchResult) => {
          setResult(data);
          setFailed(false);
          setSearching(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // A failed search must not look like an empty account.
          setResult(null);
          setFailed(true);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, type, projectId, dateWindow]);

  const items = React.useMemo<PaletteItem[]>(() => {
    if (!trimmed) {
      return recents.map((row) => ({
        id: "recent-" + row.kind + "-" + row.id,
        group: "Recent",
        label: row.title || "Untitled",
        meta: relativeTime(row.updatedAt),
        icon: RECENT_ICONS[row.kind] ?? MessageSquare,
        run: () => go(row.href),
      }));
    }
    if (!result) return [];
    return result.groups.flatMap((group) =>
      group.hits.map((hit: SearchHit) => ({
        id: hit.id,
        group: group.label,
        label: hit.title,
        meta: hit.locator ?? relativeTime(hit.updatedAt),
        snippet: hit.snippet,
        labelMarks: hit.titleMarks,
        icon: SEARCH_TYPE_ICONS[hit.type],
        run: () => go(hit.href),
      }))
    );
  }, [trimmed, recents, result, go]);

  // Only the sources that came back short say anything, and each says what it
  // was: "still being indexed" and "could not be read" are different problems
  // with different answers, and collapsing them into "partial results" leaves
  // the user with nothing to do about either.
  const notices = React.useMemo(() => {
    const list = (result?.coverage ?? []).filter((c) => c.state !== "complete" && c.detail);
    if (!trimmed || list.length === 0) return null;
    const shown = list.slice(0, 2);
    // Same recessed rung as the footer strip. `bg-muted/20` landed ~0.7 of a
    // point off the popover behind it, so the one band saying "part of your
    // account could not be searched" had no band.
    return (
      <div className="border-b border-border/60 bg-secondary px-4 py-2">
        {shown.map((c) => (
          <p key={c.type} className="text-caption leading-snug text-muted-foreground">
            <span className="text-foreground/80">{SEARCH_TYPE_LABELS[c.type]}:</span> {c.detail}
          </p>
        ))}
        {list.length > shown.length && (
          <p className="text-caption leading-snug text-muted-foreground">
            {list.length - shown.length} more part of your account was searched only in part.
          </p>
        )}
      </div>
    );
  }, [result, trimmed]);

  const filters = trimmed ? (
    <div className="border-b border-border/60 px-3 py-2">
      <div role="group" aria-label="Filter by type" className="flex gap-1 overflow-x-auto pb-0.5">
        <FilterChip active={type === "all"} onClick={() => setType("all")}>
          Everything
        </FilterChip>
        {(Object.keys(SEARCH_TYPE_LABELS) as SearchType[]).map((t) => (
          <FilterChip key={t} active={type === t} onClick={() => setType(t)}>
            {SEARCH_TYPE_LABELS[t]}
          </FilterChip>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <div role="group" aria-label="Filter by date" className="flex gap-1 overflow-x-auto">
          {SEARCH_WINDOWS.map((w) => (
            <FilterChip key={w} active={dateWindow === w} onClick={() => setDateWindow(w)}>
              {SEARCH_WINDOW_LABELS[w]}
            </FilterChip>
          ))}
        </div>
        {projects.length > 0 && (
          // The Radix Select, not a native <select>. This was the only OS popup
          // list in the app shell: its menu ignored --popover, the border tokens
          // and the pop-in/out pair, so the last control in a strip of five
          // FilterChips opened in a completely different material — and it had no
          // chevron, so it did not even look like it opened anything. `ALL` stands
          // in for the empty value because Radix reserves "" for "no selection".
          <Select
            value={projectId || ALL_PROJECTS}
            onValueChange={(v) => setProjectId(v === ALL_PROJECTS ? "" : v)}
          >
            <SelectTrigger
              aria-label="Filter by project"
              // Deliberately overrides `.field-well` (select.tsx), which paints a
              // fill and an inset shadow: this trigger is the sixth chip in a row
              // of FilterChips, not a form field, so it takes their pill shape and
              // their recessed-on-popover fill instead. `shadow-none` is what
              // cancels the well's inset — a groove under a 24px pill reads as
              // damage — and it has to be a utility, because utilities are emitted
              // after the components layer and nothing else can beat that class
              // from a call site. The fill was `bg-muted/50`, which resolved to
              // ~11.3% on a 13% panel and so left the chip with no fill at all.
              className="ml-auto h-auto w-auto max-w-[10rem] shrink-0 gap-1.5 rounded-full border-transparent bg-secondary px-2.5 py-1 text-caption text-muted-foreground shadow-none hover:text-foreground coarse:min-h-11"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[16rem]">
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="truncate">{p.name || "Untitled project"}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  ) : null;

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

  // Five states, each with its own words. "Searching" is not "nothing found",
  // and a request that failed is not an empty account — telling someone their
  // account is empty when the network dropped is the one mistake this surface
  // must never make, because they will believe it.
  //
  // In flight, the surface holds its SHAPE rather than its words. A single
  // centred "Searching…" inside a 10rem block collapsed the palette to nearly
  // empty on every keystroke past the debounce, which reads as "no results" for
  // 200ms at a time; placeholder rows at the result row's own geometry keep the
  // list's height and say loading instead. The sidebar already answers the
  // identical situation this way.
  // rounded-menu on the placeholders, tracking the result row they stand in for
  // — a skeleton drawn at a different radius from the thing that replaces it is
  // a visible re-shape at the moment the results land.
  const emptyState = searching ? (
    <div className="space-y-1 p-1.5" aria-hidden="true">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="skeleton h-11 rounded-menu" style={staggerDelay(i, "tight")} />
      ))}
    </div>
  ) : (
    <div className="px-3 py-10 text-center">
      {failed ? (
        <>
          <p className="text-sm text-muted-foreground">Search is unavailable right now.</p>
          <p className="mt-1 text-caption text-muted-foreground">
            Check your connection and try the search again.
          </p>
        </>
      ) : trimmed ? (
        <>
          <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
          <p className="mt-1 text-caption text-muted-foreground">
            Try fewer words, or widen the filters above.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Search everything in Juno</p>
          <p className="mt-1 text-caption text-muted-foreground">
            Chats and their messages, projects, files, artifacts, memories and Work.
          </p>
        </>
      )}
    </div>
  );

  const status = !trimmed
    ? ""
    : failed
      ? "Search is unavailable right now."
      : searching
        ? "Searching"
        : `${items.length} ${items.length === 1 ? "result" : "results"}${
            result?.partial ? ", some sources searched only in part" : ""
          }`;

  return (
    <PaletteShell
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Search everything"
      placeholder="Search chats, files, artifacts, memory and Work"
      query={query}
      onQueryChange={setQuery}
      items={items}
      filters={filters}
      notices={notices}
      status={status}
      resetKey={`${trimmed}|${type}|${dateWindow}|${projectId}`}
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
        icon: AppIcons.new,
        keywords: "start compose message",
        run: () => {
          go("/chat");
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        },
      },
      {
        id: "new-work",
        group: "Quick actions",
        label: "New Work task",
        icon: AppIcons.work,
        keywords: "work task do errand agent mac cloud automation",
        run: () => go("/work"),
      },
      {
        id: "new-code",
        group: "Quick actions",
        label: "New code session",
        icon: AppIcons.code,
        keywords: "code start workspace session mac",
        run: () => go("/code/new"),
      },
      {
        id: "new-task",
        group: "Quick actions",
        label: "New scheduled task",
        icon: AppIcons.tasks,
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
    // "See all" hands off to the dedicated search surface (Surface A), which
    // searches content rather than filtering the titles this menu holds.
    if (!q && chats.length > 0) {
      recents.push({
        id: "see-all-chats",
        group: "Recents",
        label: "Search everything",
        icon: Search,
        run: () => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent("juno:search"));
        },
      });
    }

    const actions: PaletteItem[] = [
      { id: "projects", group: "Actions", label: "Projects", icon: AppIcons.projects, keywords: "workspaces group", run: () => go("/projects") },
      // Work lands on its own index, unlike Code, whose "/code" route has no
      // page and so has to send people to the pull request list instead.
      { id: "work", group: "Actions", label: "Work", icon: AppIcons.work, keywords: "tasks agent errands hosts macs approvals juno work", run: () => go("/work") },
      { id: "code", group: "Actions", label: "Code", icon: AppIcons.code, keywords: "sessions pull requests github reviews juno code", run: () => go("/code/pulls") },
      { id: "design", group: "Actions", label: "Design", icon: AppIcons.design, keywords: "canvas frames mockup screen figma juno design", run: () => go("/design") },
      { id: "artifacts", group: "Actions", label: "Artifacts", icon: AppIcons.artifacts, keywords: "documents canvas generated", run: () => go("/artifacts") },
      { id: "library", group: "Actions", label: "Library", icon: AppIcons.library, keywords: "saved prompts snippets", run: () => go("/library") },
      { id: "connections", group: "Actions", label: "Connections", icon: AppIcons.connections, keywords: "plugins integrations github mcp connectors", run: () => go("/connections") },
      { id: "tasks", group: "Actions", label: "Tasks", icon: AppIcons.tasks, keywords: "scheduled recurring automation", run: () => go("/tasks") },
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
      <p className="mt-1 text-caption text-muted-foreground">Try a chat title, or a command like “settings”.</p>
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
        <DialogTitle>Keyboard shortcuts</DialogTitle>
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
