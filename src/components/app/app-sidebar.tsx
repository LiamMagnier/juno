"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, ChevronUp, Pin, Plus } from "lucide-react";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { DownloadMenu } from "@/components/app/download-menu";
import { UserAvatar, UserMenu } from "@/components/app/user-menu";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { JunoMark } from "@/components/brand/logo";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApp } from "@/components/app/app-provider";
import { ProductSwitch, productOf } from "@/components/app/product-switch";
import { ShareDialog } from "@/components/share/share-dialog";
import { PLANS } from "@/lib/plans";
import { spring, staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";
import { useWorkNeedsYouCount } from "@/components/work/inbox/use-needs-you-count";

/* ────────────────────────────────────────────────────────────────────────────
 * The sidebar (docs/design/FLAT_UI.md §3).
 *
 * A flat panel (the frame is painted by `.app-sidebar-frame` in the shell)
 * holding, top to bottom: brand + collapse, the Chat · Work · Code product
 * switch, Search (the eight-source search palette — ⌘K is the command menu,
 * a different thing), New chat, the nav destinations, Projects, Pinned,
 * Recents folded by date, and a footer of exactly two blocks: Design, then
 * one 36px account band.
 *
 * THE DENSITY LADDER, and nothing off it. Rows are `h-8` (32px) carrying
 * `text-ui` (13px) and a `size-4` (16px) glyph at `gap-2`, so every label in
 * the panel starts 32px from its edge. Section eyebrows are `h-6` mono caps;
 * date folds are `h-6` sans captions one rung below them. Glyphs may only be
 * `size-3`, `size-3.5` or `size-4` — every one of which has a rung on the
 * optical stroke ladder in globals.css. The rows were 36px with 14px labels
 * and UNSIZED glyphs that fell back to Lucide's intrinsic 24px; that, plus
 * 332px of fixed chrome above the list and 121px of footer below it, is what
 * "the elements are too big" was pointing at.
 *
 * HOVER IS WEAKER THAN ACTIVE. `bg-sidebar-accent/60` on hover, the full fill
 * when selected. They used to be the same fill, so pointing anywhere in the
 * column made two rows claim to be selected at once and the real one vanished
 * under the pointer. Selection is fill + ink + (in a list) a filled bullet —
 * never weight: swapping a title from medium to semibold on click re-measured
 * it and visibly re-truncated the row you had just chosen.
 *
 * ONE TREE FOR BOTH WIDTHS. The rail is not a second component: every row is
 * a `motion.div layout`, so collapsing to 64px slides the glyphs into a
 * column and expanding slides them back, while the labels and the lists fade.
 * Two trees cross-fading read as a swap; one tree moving reads as the panel
 * folding, which is what a collapse is.
 * ──────────────────────────────────────────────────────────────────────────── */

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
} | null;

type SidebarProject = {
  id: string;
  name: string;
  nameSource?: "default" | "ai" | "manual";
  starred: boolean;
  updatedAt: string;
  conversationCount: number;
};

const LEGACY_STARRED_KEY = "starredProjects";
const RECENTS_PAGE = 40;

/* Recents is NOT here any more: its date folds are its headings now, so there
   is no "Recents" row left to collapse. The orphaned
   `juno:sidebar:recents:collapsed` key is harmless — a reader who had the
   section folded simply finds their chats back. */
const SECTION_KEYS = {
  projects: "juno:sidebar:projects:collapsed",
  pinned: "juno:sidebar:starred:collapsed",
} as const;

type SectionKey = keyof typeof SECTION_KEYS;

/** Recents fall into ChatGPT's four buckets, in this order. */
const RECENTS_GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;
type RecentsGroup = (typeof RECENTS_GROUPS)[number];

/** Which bucket a chat's last activity falls in, by the LOCAL calendar day —
 *  "yesterday" is the reader's yesterday, not a rolling 24 hours. */
function recentsGroupOf(iso: string, now: Date): RecentsGroup {
  const stamp = new Date(iso).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  // An unparsable date (or a clock skewed into the future) lands in Today
  // rather than vanishing into Older.
  if (Number.isNaN(stamp) || stamp >= startOfToday) return "Today";
  if (stamp >= startOfToday - day) return "Yesterday";
  if (stamp >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}

/**
 * The row kebab, once. `coarse:opacity-100` is not polish: reveal-on-hover is
 * the only way this control appears, and a touch device never hovers — on a
 * phone the drawer is the only route to rename, move or delete a chat.
 *
 * `rounded-control`, not `Pressable kind="icon"`'s circle: it sits inside a
 * `rounded-control` row and beside the composer's `rounded-control` icon
 * buttons, and it was the only disc in either. `coarse:size-10` rather than
 * `size-11` so it does not fill a 44px touch row edge to edge.
 */
const KEBAB_CLASS =
  "group/kebab size-7 shrink-0 rounded-control opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-sidebar-accent data-[state=open]:opacity-100 coarse:size-10 coarse:opacity-100";

export function AppSidebar({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const workNeedsYou = useWorkNeedsYouCount();
  const reduceMotion = useReducedMotion();
  const {
    conversations,
    updateConversation,
    removeConversation,
    upsertConversation,
    activeConversationId,
    setSidebarOpen,
    user,
    quota,
  } = useApp();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);
  // Date grouping depends on the local clock, so the list waits for mount to
  // keep SSR and the first client render in agreement.
  const [mounted, setMounted] = React.useState(false);
  const [projects, setProjects] = React.useState<SidebarProject[]>([]);
  const [projectsError, setProjectsError] = React.useState(false);
  const [sectionCollapsed, setSectionCollapsed] = React.useState<Record<SectionKey, boolean>>({
    projects: false,
    pinned: false,
  });
  const [renameTarget, setRenameTarget] = React.useState<SidebarProject | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renamingProject, setRenamingProject] = React.useState(false);
  const [shareId, setShareId] = React.useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = React.useState(false);
  const [recentsLimit, setRecentsLimit] = React.useState(RECENTS_PAGE);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  const migratedLegacyStars = React.useRef(false);

  const loadProjects = React.useCallback(async () => {
    setProjectsError(false);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error();
      const data = await res.json();
      const nextProjects: SidebarProject[] = Array.isArray(data.projects) ? data.projects : [];
      if (!migratedLegacyStars.current) {
        migratedLegacyStars.current = true;
        try {
          const raw = JSON.parse(localStorage.getItem(LEGACY_STARRED_KEY) || "[]");
          const legacy: string[] = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
          if (legacy.length > 0) {
            const toStar = nextProjects.filter((p) => legacy.includes(p.id) && !p.starred);
            const results = await Promise.all(
              toStar.map((p) =>
                fetch(`/api/projects/${p.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ starred: true }),
                })
                  .then((r) => r.ok)
                  .catch(() => false)
              )
            );
            toStar.forEach((p, i) => {
              if (results[i]) p.starred = true;
            });
            if (results.every(Boolean)) localStorage.removeItem(LEGACY_STARRED_KEY);
          } else {
            localStorage.removeItem(LEGACY_STARRED_KEY);
          }
        } catch {
          /* storage unavailable — server state stands */
        }
      }
      React.startTransition(() => setProjects(nextProjects));
    } catch {
      setProjectsError(true);
    }
  }, []);

  React.useEffect(() => {
    setMounted(true);
    loadProjects();
    try {
      const next: Record<SectionKey, boolean> = { projects: false, pinned: false };
      for (const key of Object.keys(SECTION_KEYS) as SectionKey[]) {
        const raw = localStorage.getItem(SECTION_KEYS[key]);
        if (raw) next[key] = JSON.parse(raw) === true;
      }
      setSectionCollapsed(next);
    } catch {}
    const handleSync = () => loadProjects();
    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [loadProjects]);

  const toggleSection = (key: SectionKey) => {
    setSectionCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(SECTION_KEYS[key], JSON.stringify(next[key]));
      } catch {}
      return next;
    });
  };

  // Infinite scroll for Recents: a sentinel at the foot of the list asks for
  // the next page as it scrolls into the well.
  React.useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRecentsLimit((n) => n + RECENTS_PAGE);
      },
      { root, rootMargin: "160px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [mounted, collapsed]);

  const sidebarProjects = React.useMemo(
    () =>
      [...projects]
        .filter((p) => p.starred)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [projects]
  );

  const toggleProjectStar = async (project: SidebarProject) => {
    const next = !project.starred;
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, starred: next } : p)));
    const r = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)));
      toast.error("Couldn’t update the project.");
      return;
    }
    toast.success(next ? "Project pinned." : "Project unpinned.");
    window.dispatchEvent(new CustomEvent("starred:sync"));
    window.dispatchEvent(new CustomEvent("projects:sync"));
  };

  const renameProject = async () => {
    if (!renameTarget || !renameDraft.trim()) return;
    setRenamingProject(true);
    try {
      const r = await fetch(`/api/projects/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameDraft.trim() }),
      });
      if (!r.ok) throw new Error();
      toast.success("Project renamed.");
      await loadProjects();
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setRenameTarget(null);
    } catch {
      toast.error("Couldn’t rename project.");
    } finally {
      setRenamingProject(false);
    }
  };

  const deleteProject = (project: SidebarProject) => {
    setConfirm({
      title: "Delete this project?",
      description:
        "Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.",
      confirmLabel: "Delete project",
      onConfirm: async () => {
        const r = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
        if (!r.ok) {
          toast.error("Couldn’t delete project.");
          return;
        }
        toast.success("Project deleted.");
        window.dispatchEvent(new CustomEvent("projects:sync"));
        if (pathname === `/projects/${project.id}`) router.push("/projects");
      },
    });
  };

  const archiveConversation = React.useCallback(
    async (c: ClientConversation) => {
      removeConversation(c.id);
      const res = await fetch(`/api/conversations/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }).catch(() => null);
      if (!res?.ok) {
        upsertConversation(c);
        toast.error("Couldn’t archive the chat.");
        return;
      }
      toast.success("Chat archived.", {
        action: {
          label: "Undo",
          onClick: async () => {
            const r = await fetch(`/api/conversations/${c.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ archived: false }),
            }).catch(() => null);
            if (r?.ok) upsertConversation({ ...c, archivedAt: null });
          },
        },
      });
      if (c.id === activeConversationId) {
        router.push("/chat");
        window.dispatchEvent(new CustomEvent("juno:new-chat"));
      }
    },
    [activeConversationId, removeConversation, router, upsertConversation]
  );

  /* ── Lists ───────────────────────────────────────────────────────────── */

  const live = React.useMemo(() => conversations.filter((c) => !c.archivedAt && c.kind !== "code"), [conversations]);
  const pinned = React.useMemo(() => live.filter((c) => c.pinned), [live]);
  // Project chats stay in Recents as well as under their project, because a
  // project is a workspace rather than a filing.
  const recents = React.useMemo(
    () => live.filter((c) => !c.pinned),
    [live]
  );
  // The page in view, bucketed by day. Grouped AFTER the slice so the
  // infinite-scroll page size still counts chats, not groups; a group with
  // nothing in the page is simply not drawn.
  const groupedRecents = React.useMemo(() => {
    const now = new Date();
    const buckets = new Map<RecentsGroup, ClientConversation[]>();
    for (const c of recents.slice(0, recentsLimit)) {
      const group = recentsGroupOf(c.lastMessageAt || c.createdAt, now);
      buckets.set(group, [...(buckets.get(group) ?? []), c]);
    }
    return RECENTS_GROUPS.flatMap((group) => {
      const rows = buckets.get(group);
      return rows ? [{ group, rows }] : [];
    });
  }, [recents, recentsLimit]);

  const newChat = () => {
    router.push("/chat");
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };

  const rowProps = {
    renamingId,
    setRenaming: setRenamingId,
    projects,
    onUpdate: updateConversation,
    onRemove: removeConversation,
    onNavigate: () => setSidebarOpen(false),
    onRequestConfirm: setConfirm,
    onShare: setShareId,
    onArchive: archiveConversation,
  };

  const plan = PLANS[quota.plan];
  // A Juno Code session is served at /chat/<id> (app/(app)/chat/[id]/page.tsx
  // renders <CodeSessionView> when the conversation's kind is "code"), so the
  // path alone lit "Chat" for the whole session. The conversation's own kind
  // is the tiebreak — see productOf().
  const activeKind = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)?.kind ?? null
    : null;
  const activeProduct = productOf(pathname, activeKind);
  /*
   * Usage in the footer is a WORD, not a meter.
   *
   * The account menu behind this row already draws the same quota as a
   * `DotFillBar` with a `Messages 12 / 15` header, so the footer's `Progress`
   * bar was a second read of one number — and a bar at 12% full is furniture.
   * Below 80% the footer says nothing about usage at all; above it the plan
   * segment changes copy and tone, which is the only moment the number is
   * worth a person's attention. `quota.remaining` is preferred over
   * `limit - used` so the copy matches whatever the server computed, and it is
   * nullable (types/chat.ts) so it is guarded.
   */
  const usagePct =
    quota.limit != null && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : null;
  const remaining = quota.remaining ?? (quota.limit != null ? Math.max(0, quota.limit - quota.used) : null);
  const planSegment =
    usagePct == null || usagePct < 80
      ? { label: plan.name, tone: "text-muted-foreground" }
      : usagePct >= 100
        ? { label: "Limit reached", tone: "text-destructive" }
        : { label: `${remaining ?? 0} left`, tone: "text-warning" };
  // The whole truth always rides the accessible name, so nothing a sighted
  // reader can see is lost to the truncation on that one line.
  const accountLabel = `${user.name ?? user.email ?? "Account"}, ${plan.name} plan${
    quota.limit == null ? ", no message cap" : `, ${quota.used} of ${quota.limit} messages used`
  }`;

  const layoutTransition = reduceMotion ? { duration: 0 } : spring.layout;

  return (
    <LayoutGroup id="juno-sidebar">
      <div
        key="sidebar"
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "flex h-full flex-col text-sidebar-foreground",
          // Desktop width rides the shell's --juno-sidebar-width (user-resizable);
          // keeping it on the inner column preserves the collapse clip-reveal.
          // w-16 = 64px = app-shell's RAIL_WIDTH. Not the spec's 56: the
          // product switch's rail items are 44px inside `px-2.5`, which is
          // exactly 64, and that control is signed off and not ours to resize.
          collapsed ? "w-16" : "w-full md:w-[var(--juno-sidebar-width,256px)]"
        )}
      >
        {/* ── Brand + collapse ─────────────────────────────────────────── */}
        <motion.div
          layout
          transition={layoutTransition}
          className={cn("flex items-center pt-2", collapsed ? "flex-col gap-1 px-2.5" : "h-9 justify-between px-2")}
        >
          <motion.div layout="position" transition={layoutTransition}>
            <Link
              href="/chat"
              onClick={() => setSidebarOpen(false)}
              aria-label="Juno home"
              className={cn(
                "group/brand flex items-center gap-2 rounded-control",
                collapsed ? "size-11 justify-center" : "h-9 pl-1"
              )}
            >
              <JunoMark className="size-5 shrink-0" />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.span
                    key="wordmark"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={reduceMotion ? { duration: 0 } : transition.fast}
                    className="overflow-hidden whitespace-nowrap font-sans text-body-lg font-semibold tracking-[-0.02em] text-foreground"
                  >
                    Juno
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          </motion.div>
          <motion.div layout="position" transition={layoutTransition} className="flex items-center gap-0.5">
            {onToggleCollapse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn("group hidden md:inline-flex", collapsed ? "size-11" : "size-7 coarse:size-9")}
                    onClick={onToggleCollapse}
                    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-keyshortcuts="Meta+Shift+S"
                  >
                    <SidebarMotionIcon kind={collapsed ? "panel-open" : "panel-close"} className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={collapsed ? "right" : "bottom"}>
                  {collapsed ? "Expand sidebar" : "Collapse sidebar"} <Kbd className="ml-1">⌘⇧S</Kbd>
                </TooltipContent>
              </Tooltip>
            )}
            {!collapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="group size-7 md:hidden coarse:size-9"
                    onClick={() => setSidebarOpen(false)}
                    aria-label="Close menu"
                  >
                    <SidebarMotionIcon kind="close" className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Close</TooltipContent>
              </Tooltip>
            )}
          </motion.div>
        </motion.div>

        {/* ── Chat · Work · Code ───────────────────────────────────────── */}
        {/* The ONE product switch in the shell, at both widths: a hairline
            pill with a tonal thumb when expanded, a 44px icon column at the
            rail (which never had a Chat row at all — the wordmark was the only
            way back, and it never looked selected). Page tabs are underlines
            and never wells, so nothing else in the product wears a track.
            No AnimatePresence around it any more: it renders in both states
            and FOLDS, like every other row in this column. */}
        <ProductSwitch
          collapsed={collapsed}
          active={activeProduct}
          needsYou={workNeedsYou}
          plan={quota.plan}
          onNavigate={() => setSidebarOpen(false)}
        />

        {/* ── Search + New chat ────────────────────────────────────────── */}
        {/* No `pt-*` when expanded: ProductSwitch already closes with `pb-2`,
            which IS the 8px this column puts between sibling groups. */}
        <div className={cn("space-y-0.5", collapsed ? "px-2.5 pt-2" : "px-2")}>
          {/* `juno:search` — the eight-source search palette, not the ⌘K command
              menu. A row labelled Search used to open the command menu, whose
              "Chats" group is a client-side title filter over whatever the
              context happened to hold; the real search was reachable only from
              the mobile magnifier. No key hint: the search palette has none,
              and ⌘K keeps meaning "commands". */}
          <NavRow
            collapsed={collapsed}
            onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
            icon={<SidebarMotionIcon kind="search" />}
            label="Search"
            layoutId="nav-search"
            transition={layoutTransition}
          />
          <NavRow
            collapsed={collapsed}
            onClick={newChat}
            /* Plain, like every sibling. The 22px tinted tile that used to sit
               behind this glyph was the only chip in the panel, and it is what
               made the one row people press most read as the chunkiest. */
            icon={<SidebarMotionIcon kind="new" />}
            label="New chat"
            trailing={<Kbd>⌘⇧O</Kbd>}
            layoutId="nav-new"
            transition={layoutTransition}
          />
        </div>

        {/* ── Destinations ─────────────────────────────────────────────── */}
        {/* Library · Projects · Artifacts, then More for the rest. The rail
            keeps the same order icon-only; More opens the same flyout. */}
        {/* `min-h-0 flex-1 overflow-y-auto` on the rail: collapsed, the list
            scroller below renders nothing, all thirteen rail rows sit in
            non-scrolling blocks, and the shell's `<aside>` is `overflow-hidden`
            — so on a short window the account control was simply clipped away
            with no way to reach it. */}
        <nav
          className={cn(
            "space-y-0.5 pt-2",
            collapsed ? "min-h-0 flex-1 overflow-y-auto no-scrollbar px-2.5" : "px-2"
          )}
          aria-label="Primary"
        >
          {(
            [
              { href: "/library", kind: "library", label: "Library", active: pathname === "/library" },
              { href: "/projects", kind: "projects", label: "Projects", active: !!pathname?.startsWith("/projects") },
              { href: "/artifacts", kind: "artifacts", label: "Artifacts", active: pathname === "/artifacts" },
            ] as const
          ).map((item) => (
            <NavRow
              key={item.href}
              collapsed={collapsed}
              href={item.href}
              active={item.active}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind={item.kind} />}
              label={item.label}
              layoutId={`nav-${item.kind}`}
              transition={layoutTransition}
            />
          ))}
          <MoreFlyout
            collapsed={collapsed}
            pathname={pathname}
            onNavigate={() => setSidebarOpen(false)}
            onOpenArchived={() => setArchivedOpen(true)}
          />
        </nav>

        {/* ── Lists ────────────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-2",
            // The rail has no lists to scroll; its own scroll region is the
            // <nav> above, so this must not also claim the slack.
            collapsed && "hidden"
          )}
        >
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                key="lists"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : transition.fast}
              >
                {!mounted ? (
                  <div className="space-y-1 px-1 pt-1">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="skeleton h-8 rounded-control" style={staggerDelay(i, "tight")} />
                    ))}
                  </div>
                ) : (
                  <>
                    {projectsError && <InlineErrorRow message="Couldn’t load your projects." onRetry={loadProjects} />}

                    {sidebarProjects.length > 0 && (
                      <Section
                        label="Projects"
                        isCollapsed={sectionCollapsed.projects}
                        onToggleCollapse={() => toggleSection("projects")}
                        action={
                          <>
                            <SectionAction label="New project" onClick={() => router.push("/projects?new=1")} always>
                              <Plus className="size-3.5" />
                            </SectionAction>
                            <SectionAction label="All projects" onClick={() => router.push("/projects")}>
                              <ChevronRight className="size-3.5" />
                            </SectionAction>
                          </>
                        }
                      >
                        {sidebarProjects.map((p) => (
                          <ProjectRow
                            key={p.id}
                            project={p}
                            chats={live.filter((c) => c.projectId === p.id)}
                            active={pathname === `/projects/${p.id}`}
                            activePath={pathname}
                            starred={p.starred}
                            onNavigate={() => setSidebarOpen(false)}
                            onNewChat={() => {
                              router.push(`/chat?project=${p.id}`);
                              setSidebarOpen(false);
                            }}
                            onToggleStar={() => toggleProjectStar(p)}
                            onRename={() => {
                              setRenameDraft(p.name);
                              setRenameTarget(p);
                            }}
                            onDelete={() => deleteProject(p)}
                          />
                        ))}
                      </Section>
                    )}

                    {pinned.length > 0 && (
                      <Section label="Pinned" isCollapsed={sectionCollapsed.pinned} onToggleCollapse={() => toggleSection("pinned")}>
                        {pinned.map((c) => (
                          <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} {...rowProps} />
                        ))}
                      </Section>
                    )}

                    {/* THE FOLDS ARE THE HEADERS. There is no "Recents"
                        section wrapper any more: a `text-xs` sentence-case
                        header immediately followed by a `font-mono` "Today"
                        caption one rung below it put two headings over one
                        list, a rung apart in two families, so neither read as
                        the structure. Sans captions under the mono caps
                        eyebrows above them can no longer be confused for one
                        another. Grouping, paging and the sentinel are
                        untouched. */}
                    {recents.length > 0 ? (
                      <div className="mt-4 first:mt-0">
                        {groupedRecents.map(({ group, rows }) => (
                          <div key={group} className="space-y-0.5 pt-2 first:pt-0">
                            <p className="flex h-6 items-center px-2 text-caption text-muted-foreground/80">{group}</p>
                            {rows.map((c) => (
                              <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} {...rowProps} />
                            ))}
                          </div>
                        ))}
                        {recents.length > recentsLimit && (
                          <div ref={sentinelRef} className="flex justify-center py-2" aria-hidden>
                            <span className="skeleton h-2 w-16 rounded-full" />
                          </div>
                        )}
                      </div>
                    ) : (
                      live.length === 0 &&
                      sidebarProjects.length === 0 && (
                        <p className="px-2 py-8 text-center text-ui text-muted-foreground" aria-live="polite">
                          No conversations yet.
                          <br />
                          Start one above.
                        </p>
                      )
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        {/*
         * TWO BLOCKS, 89px total (it was three objects in ~121px: a three-line
         * account block, a two-high stack of icon buttons with two different
         * corner radii, and a Design row above them).
         *
         * Block 1 is Design, pinned above the hairline — the last thing before
         * the footer, never scrolled away, drawn as an ordinary 32px
         * destination row. Block 2 is ONE 36px band carrying three objects the
         * way the composer's controls row carries three: the account trigger,
         * then a two-button cluster.
         */}
        <motion.div layout transition={layoutTransition}>
          <div className={cn(collapsed ? "px-2.5" : "px-2 pb-1.5")}>
            <NavRow
              collapsed={collapsed}
              href="/design"
              active={pathname === "/design"}
              onClick={() => setSidebarOpen(false)}
              /* `SidebarMotionIcon kind="design"` = PenTool, the mark /design,
                 the command palette and the icon registry all draw. This row
                 was the one nav row in the file that bypassed the registry and
                 imported a bare lucide `Pencil`: one destination, two marks. */
              icon={<SidebarMotionIcon kind="design" />}
              label="Design"
              layoutId="nav-design"
              transition={layoutTransition}
            />
          </div>
          {collapsed ? (
            /* The rail loses its dedicated 44px Settings button: Settings is a
               row in the account menu, one click away at BOTH widths, and
               removing it is what lets the rail footer be two controls instead
               of three. DownloadMenu is new here, so nothing the expanded
               footer offers becomes unreachable when collapsed. */
            <>
              {/* Inset like the product switch's separator above, not a
                  full-bleed rule: at 64px a rule that touches both edges reads
                  as the panel ending. */}
              <div className="mx-2.5 mt-1.5 border-b border-sidebar-border" aria-hidden="true" />
              <div className="flex flex-col items-center gap-1 px-2.5 pb-2 pt-1.5">
                <DownloadMenu className="size-11 rounded-control" />
                <UserMenu compact />
              </div>
            </>
          ) : (
            <div className="mt-1.5 flex items-center gap-1 border-t border-sidebar-border px-2 pb-2 pt-1.5">
              <UserMenu
                trigger={
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={accountLabel}
                    className="group flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 text-left transition-[background-color,color] duration-fast ease-out-soft hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent motion-reduce:transition-none coarse:h-11"
                  >
                    {/* The SAME avatar helper the menu this opens draws with.
                        The footer used to render mono initials in a bordered
                        disc while the menu four pixels away rendered a
                        DotIdenticon — one person, two faces, one click apart. */}
                    <UserAvatar className="size-6" />
                    {/* The NAME truncates, the plan segment never does: it is
                        the tonal state, and "Limit reached" is precisely the
                        word a 256px column must not eat. */}
                    <span className="flex min-w-0 flex-1 items-baseline text-ui">
                      <span className="min-w-0 truncate font-medium text-foreground">{user.name ?? user.email}</span>
                      <span className={cn("shrink-0 whitespace-pre", planSegment.tone)}>{` · ${planSegment.label}`}</span>
                    </span>
                    <ChevronUp
                      aria-hidden
                      className="size-3 shrink-0 text-muted-foreground/70 transition-transform duration-fast ease-in-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                    />
                  </button>
                }
              />
              {/* gap-0.5 inside, gap-1 outside: the two buttons read as one
                  object, which the vertical stack they replace never did. */}
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Settings"
                      onClick={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }))}
                      className="group size-9 shrink-0 rounded-control text-muted-foreground hover:bg-sidebar-accent hover:text-foreground coarse:size-11"
                    >
                      <AppIcons.settings className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Settings</TooltipContent>
                </Tooltip>
                {/* cn() lets the call-site radius win, so the one `rounded-full`
                    control in the footer finally matches the square one beside
                    it. */}
                <DownloadMenu className="size-9 rounded-control coarse:size-11" />
              </div>
            </div>
          )}
        </motion.div>

        {/* ── Dialogs ──────────────────────────────────────────────────── */}
        <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{confirm?.title}</DialogTitle>
              <DialogDescription>{confirm?.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  confirm?.onConfirm();
                  setConfirm(null);
                }}
              >
                {confirm?.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>Change the name of this project.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="sidebar-rename-project">Project name</Label>
              <Input
                id="sidebar-rename-project"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                placeholder="New project name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameProject();
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button onClick={renameProject} disabled={renamingProject || !renameDraft.trim()}>
                {renamingProject ? "Renaming…" : "Rename project"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {shareId && <ShareDialog kind="CHAT" conversationId={shareId} open onOpenChange={(o) => !o && setShareId(null)} />}

        <ArchivedChatsDialog
          open={archivedOpen}
          onOpenChange={setArchivedOpen}
          onRestored={(c) => upsertConversation({ ...c, archivedAt: null })}
          onRequestConfirm={setConfirm}
        />
      </div>
    </LayoutGroup>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rows
 * ──────────────────────────────────────────────────────────────────────────── */

function NavRow({
  href,
  onClick,
  icon,
  label,
  trailing,
  active,
  collapsed,
  layoutId,
  transition: t,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  active?: boolean;
  collapsed: boolean;
  layoutId: string;
  transition: object;
}) {
  const cls = navRowClass(collapsed, !!active);
  const inner = (
    <>
      {/* A `size-4` box, not a 22px well: the glyph IS the box, so at `gap-2`
          every label in the panel starts exactly 32px from its edge — the
          project tree's guide line and the chat bullets land there too. */}
      <span className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground">
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="ml-auto shrink-0 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100">{trailing}</span>}
        </>
      )}
    </>
  );
  // `data-active` on the row, read by `group-data-[active]` on the glyph. It
  // replaces an arbitrary ancestor variant keyed to a literal utility string
  // (`[.bg-sidebar-accent_&]:text-foreground`), which can no longer tell the
  // hover fill from the active one now that hover is the same colour at 60%.
  const activeAttr = active ? "" : undefined;
  const el = href ? (
    <Link
      href={href}
      onClick={onClick}
      data-active={activeAttr}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cls}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      data-active={activeAttr}
      aria-label={collapsed ? label : undefined}
      className={cn(cls, "text-left")}
    >
      {inner}
    </button>
  );
  const row = (
    <motion.div layout layoutId={layoutId} transition={t} className={cn(collapsed && "flex justify-center")}>
      {el}
    </motion.div>
  );
  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {trailing && <span className="ml-1.5 inline-flex">{trailing}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The sidebar row recipe, shared by NavRow and the More trigger.
 *
 * No `border border-transparent`: it was a Soft UI artifact that stopped a box
 * changing size under a border that no longer arrives, and against a FIXED
 * `h-8` with `box-border` it now just steals 2px of the row's height.
 *
 * Hover is `bg-sidebar-accent/60`, active is the full fill, and active carries
 * no hover rule at all so it does not brighten under the pointer. They used to
 * be the identical fill, which meant that at any moment the pointer was in the
 * sidebar two rows claimed to be selected and the real one disappeared.
 */
function navRowClass(collapsed: boolean, active: boolean) {
  return cn(
    "group relative flex h-8 w-full items-center rounded-control text-ui font-medium transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
    // The rail: a 44px target around the same 16px glyph, so every icon is
    // one tap and the row's tooltip names it.
    collapsed ? "size-11 justify-center px-0" : "gap-2 px-2 coarse:h-11",
    active
      ? "bg-sidebar-accent text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
  );
}

/**
 * More: the destinations that do not earn a top-level row, in a
 * `.surface-float` flyout to the right of the sidebar (ChatGPT's "More").
 * The same flyout from the rail, where the trigger is an icon with a tooltip.
 * Archived chats lives here too — it opens the dialog rather than a route.
 */
function MoreFlyout({
  collapsed,
  pathname,
  onNavigate,
  onOpenArchived,
}: {
  collapsed: boolean;
  pathname: string | null;
  onNavigate: () => void;
  onOpenArchived: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  /*
   * Work and Code are NOT here any more. They used to lead this list because
   * the only other way to reach them was a header switcher hidden below `md`;
   * the sidebar's product switch now carries all three products at every
   * width (the drawer renders the expanded sidebar, the rail gets icon rows),
   * so a second door in More was the third copy of the same control.
   */
  const items = [
    { href: "/assistants", kind: "assistants" as const, label: "Assistants", active: pathname === "/assistants" },
    { href: "/connections", kind: "connections" as const, label: "Connections", active: pathname === "/connections" },
    { href: "/tasks", kind: "tasks" as const, label: "Tasks", active: pathname === "/tasks" },
  ];
  const anyActive = items.some((item) => item.active);
  const rowClass =
    "flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-ui font-medium text-foreground outline-none transition-[background-color] duration-fast ease-out-soft hover:bg-accent focus-visible:bg-accent motion-reduce:transition-none coarse:h-11";
  // An open flyout takes the ACTIVE recipe, not a fill bolted on beside the
  // inactive one — otherwise `hover:bg-sidebar-accent/60` would win over it and
  // the trigger would go pale the moment the pointer reached the menu it opened.
  const trigger = (
    <button
      type="button"
      aria-label={collapsed ? "More" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      data-active={open ? "" : undefined}
      className={cn(navRowClass(collapsed, open), anyActive && !open && "text-foreground")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground">
        <SidebarMotionIcon kind="more" />
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">More</span>}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn(collapsed && "flex justify-center")}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">More</TooltipContent>
          </Tooltip>
        ) : (
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        )}
      </div>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        collisionPadding={16}
        role="menu"
        aria-label="More"
        className="w-56 p-1.5"
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            aria-current={item.active ? "page" : undefined}
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
            className={cn(rowClass, item.active && "bg-accent font-semibold")}
          >
            <SidebarMotionIcon kind={item.kind} className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </Link>
        ))}
        <div role="separator" aria-hidden="true" className="my-1 h-px bg-border/70" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onOpenArchived();
          }}
          className={rowClass}
        >
          <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">Archived chats</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

function InlineErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mx-0.5 my-1 flex items-center gap-2 rounded-control border border-destructive/40 bg-destructive/10 px-2 py-2 text-ui text-destructive"
    >
      <StatusIcons.error className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="pressable flex shrink-0 items-center gap-1 rounded-control px-1.5 py-0.5 font-medium hover:bg-destructive/20 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

function SectionAction({
  label,
  onClick,
  children,
  always = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** Shown at rest, not only on hover — the section's one standing affordance. */
  always?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          kind="icon"
          size="sm"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "size-6 rounded-control text-muted-foreground/70 transition-opacity duration-fast hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:opacity-100 coarse:size-9 coarse:opacity-100",
            always ? "opacity-100" : "opacity-0 group-hover/section:opacity-100"
          )}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({
  label,
  children,
  isCollapsed,
  onToggleCollapse,
  action,
}: {
  label: string;
  children: React.ReactNode;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  action?: React.ReactNode;
}) {
  return (
    // `mt-4` rather than `mb-3`: the 16px belongs ABOVE the header that owns
    // it, so the first section sits on the scroller's own 8px and every later
    // one is separated from the list it follows.
    <div className="group/section mt-4 first:mt-0">
      <div className="flex items-center">
        <Pressable
          kind="row"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          // 12px mono caps at 0.10em is the declared eyebrow rung — the one
          // voice in this panel that is not a row, which is exactly why the
          // date folds below can be plain sans captions and still read as a
          // level down.
          className="h-6 min-w-0 flex-1 select-none gap-1.5 px-2 py-0 hover:bg-sidebar-accent/60"
        >
          <span className="min-w-0 truncate font-mono text-label uppercase text-muted-foreground">{label}</span>
          {/* `ease-in-out`, not `ease-out-soft`: both endpoints of a chevron
              turn are on screen, so this is an A-to-B move. */}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-fast ease-in-out motion-reduce:transition-none",
              isCollapsed && "-rotate-90"
            )}
          />
        </Pressable>
        {action != null && <span className="flex shrink-0 items-center">{action}</span>}
      </div>
      <Disclosure open={!isCollapsed}>
        <div className="space-y-0.5 pt-0.5">{children}</div>
      </Disclosure>
    </div>
  );
}

/** The panel's one fold: a grid-rows sweep so rows never pop. */
function Disclosure({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,visibility] duration-base ease-out-soft motion-reduce:transition-none",
        open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          !open && "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Inline rename field for a chat row. */
function InlineNameInput({
  initial = "",
  placeholder,
  onCommit,
  onCancel,
  nested,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  nested?: boolean;
}) {
  const [draft, setDraft] = React.useState(initial);
  const committed = React.useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(draft);
  };
  return (
    <div className={cn("flex min-h-8 items-center gap-1 py-0.5 pr-1", nested ? "ml-4 pl-2" : "pl-2")}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            committed.current = true;
            onCancel();
          }
        }}
        className="h-7 w-full text-ui"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="size-7 rounded-control" onMouseDown={(e) => e.preventDefault()} onClick={commit} aria-label="Save">
            <StatusIcons.success className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save</TooltipContent>
      </Tooltip>
    </div>
  );
}

type RowSharedProps = {
  renamingId: string | null;
  setRenaming: (id: string | null) => void;
  projects: { id: string; name: string }[];
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
  onShare: (id: string) => void;
  onArchive: (c: ClientConversation) => void;
};

function ConversationRow({
  conversation,
  active,
  nested,
  renamingId,
  setRenaming,
  projects,
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
  onShare,
  onArchive,
}: RowSharedProps & {
  conversation: ClientConversation;
  active: boolean;
  /** Indented under a folder or project. */
  nested?: boolean;
}) {
  const router = useRouter();
  const renaming = renamingId === conversation.id;

  const patch = async (data: Partial<Pick<ClientConversation, "title" | "titleSource" | "pinned" | "projectId">>) => {
    const optimistic = data.title != null ? { ...data, titleSource: "manual" as const } : data;
    onUpdate(conversation.id, optimistic);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.titleSource == null ? data : { ...data, titleSource: undefined }),
    });
    if (!res.ok) toast.error("Update failed.");
  };

  const remove = () => {
    onRequestConfirm({
      title: "Delete this conversation?",
      description: "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: "Delete chat",
      onConfirm: async () => {
        onRemove(conversation.id);
        const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
        if (!res.ok) {
          toast.error("Delete failed.");
          return;
        }
        if (active) {
          router.push("/chat");
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        }
      },
    });
  };

  if (renaming) {
    return (
      <InlineNameInput
        initial={conversation.title}
        placeholder="Chat name"
        nested={nested}
        onCommit={(value) => {
          setRenaming(null);
          const title = value.trim();
          if (title && title !== conversation.title) patch({ title });
        }}
        onCancel={() => setRenaming(null)}
      />
    );
  }

  return (
    /*
     * One marker language down the whole list. The 22px icon well and its 15px
     * chat bubble are gone; every chat is a 6px hollow bullet in a `size-4`
     * slot — the same mark the project tree already drew under a pinned
     * project — so titles land on the panel's single 32px left inset and the
     * bullet, not the type, carries selection: hollow at 50% at rest, solid
     * `bg-current` when active. The title does NOT change weight on select;
     * `font-semibold` re-measured it and visibly re-truncated the row you had
     * just clicked.
     */
    <div
      data-active={active ? "" : undefined}
      className={cn(
        "group relative flex h-8 items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
        nested && "ml-4",
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-ui font-normal"
        title={conversation.title}
      >
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <span
            className={cn(
              "size-1.5 rounded-full border border-current transition-opacity duration-fast motion-reduce:transition-none",
              active ? "bg-current opacity-100" : "opacity-50 group-hover:opacity-100"
            )}
          />
        </span>
        <AnimatedTitle title={conversation.title || "New chat"} animate={conversation.titleSource === "ai"} className="min-w-0 flex-1" />
        {conversation.pinned && !nested && <Pin className="size-3 shrink-0 fill-current text-muted-foreground/60" aria-hidden />}
      </Link>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" className={KEBAB_CLASS} aria-label="Conversation options">
                <SidebarMotionIcon kind="more" className="size-3.5" />
              </Pressable>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => setRenaming(conversation.id)}>
            <ActionIcons.edit className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => patch({ pinned: !conversation.pinned })}>
            <Pin className={cn("size-4", conversation.pinned && "fill-primary text-primary")} />
            {conversation.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppIcons.projects className="size-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                {conversation.projectId == null ? <StatusIcons.success className="size-4" /> : <span className="size-4" />}
                No project
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => patch({ projectId: p.id })}>
                  {conversation.projectId === p.id ? <StatusIcons.success className="size-4" /> : <AppIcons.projects className="size-4" />}
                  <span dir="auto" className="truncate">
                    {p.name}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/projects")}>
                <Plus className="size-4" /> New project…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onShare(conversation.id)}>
            <ActionIcons.share className="size-4" /> Share
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(conversation)}>
            <Archive className="size-4" /> Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={remove} variant="destructive">
            <ActionIcons.delete className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


function ProjectRow({
  project,
  chats,
  active,
  activePath,
  starred,
  onNavigate,
  onNewChat,
  onToggleStar,
  onRename,
  onDelete,
}: {
  project: SidebarProject;
  chats: ClientConversation[];
  active: boolean;
  activePath: string;
  starred: boolean;
  onNavigate: () => void;
  onNewChat: () => void;
  onToggleStar: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  // Open by default: a pinned project's recent chats are the reason it is
  // pinned, and Claude's sidebar shows them under the project at rest. The
  // chevron still folds a noisy one away.
  const [expanded, setExpanded] = React.useState(true);
  const [showAll, setShowAll] = React.useState(false);
  const PREVIEW = 3;
  const visibleChats = showAll ? chats : chats.slice(0, PREVIEW);
  const hasChats = chats.length > 0;

  return (
    <div>
      <div
        data-active={active ? "" : undefined}
        className={cn(
          "group relative flex h-8 items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
          active
            ? "bg-sidebar-accent text-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
        )}
      >
        <Link
          href={`/projects/${project.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-ui font-normal"
          title={project.name}
        >
          {/* The one glyph that survives in a list row, because its closed →
              open folder crossfade is the single glyph morph in this panel
              that carries meaning. */}
          <span className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground group-data-[active]:text-foreground">
            <SidebarMotionIcon kind="projects" />
          </span>
          <AnimatedTitle title={project.name} animate={project.nameSource === "ai"} className="min-w-0 flex-1" />
        </Link>
        {hasChats && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  setExpanded((v) => !v);
                  if (expanded) setShowAll(false);
                }}
                aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                aria-expanded={expanded}
                className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-control text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground coarse:-my-3 coarse:size-10"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 transition-transform duration-fast ease-in-out motion-reduce:transition-none",
                    expanded && "rotate-90"
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>{expanded ? "Collapse" : "Expand"}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Pressable kind="icon" className={KEBAB_CLASS} aria-label="Project options">
                  <SidebarMotionIcon kind="more" className="size-3.5" />
                </Pressable>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Project options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onNewChat}>
              <Plus className="size-4" /> New chat in project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleStar}>
              <Pin className={cn("size-4", starred && "fill-primary text-primary")} />
              <span>{starred ? "Unpin" : "Pin"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <ActionIcons.edit className="size-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} variant="destructive">
              <ActionIcons.delete className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasChats && (
        <Disclosure open={expanded}>
          {/* The guide drops from the folder's REAL centre — `px-2` (8) plus
              half of `size-4` (8) = 16px — instead of the arbitrary 21px it
              used to be measured at, so `ml-4` is the whole geometry. */}
          <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border pb-1 pl-2">
            {visibleChats.map((c) => (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={onNavigate}
                aria-current={activePath === `/chat/${c.id}` ? "page" : undefined}
                title={c.title}
                className={cn(
                  "group group/pc flex h-7 items-center gap-2 rounded-control px-2 text-ui font-normal transition-[color,background-color] duration-fast ease-out-soft motion-reduce:transition-none coarse:h-11",
                  activePath === `/chat/${c.id}`
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-foreground"
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                  <span
                    className={cn(
                      "size-1.5 rounded-full border border-current transition-opacity duration-fast motion-reduce:transition-none",
                      activePath === `/chat/${c.id}` ? "bg-current opacity-100" : "opacity-50 group-hover/pc:opacity-100"
                    )}
                  />
                </span>
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {c.title || "New chat"}
                </span>
              </Link>
            ))}
            {chats.length > PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex h-7 w-full items-center gap-2 rounded-control px-2 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent/60 hover:text-foreground motion-reduce:transition-none coarse:h-11"
              >
                {/* An empty `size-4` slot, not an arbitrary 1.375rem inset, so
                    this lands on the same left edge as the titles above it. */}
                <span className="size-4 shrink-0" aria-hidden />
                {showAll ? "Show less" : `View all ${chats.length}`}
              </button>
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Archived chats — restore or delete, from the footer.
 * ──────────────────────────────────────────────────────────────────────────── */

function ArchivedChatsDialog({
  open,
  onOpenChange,
  onRestored,
  onRequestConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRestored: (c: ClientConversation) => void;
  onRequestConfirm: (c: ConfirmState) => void;
}) {
  const router = useRouter();
  const [items, setItems] = React.useState<ClientConversation[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    fetch("/api/conversations?archived=only")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { conversations?: ClientConversation[] }) => {
        if (!cancelled) setItems(Array.isArray(data.conversations) ? data.conversations : []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const restore = async (c: ClientConversation) => {
    setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    const r = await fetch(`/api/conversations/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    }).catch(() => null);
    if (!r?.ok) {
      setItems((prev) => (prev ? [c, ...prev] : prev));
      toast.error("Couldn’t restore the chat.");
      return;
    }
    onRestored(c);
    toast.success("Chat restored.");
  };

  const destroy = (c: ClientConversation) => {
    onRequestConfirm({
      title: "Delete this conversation?",
      description: "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: "Delete chat",
      onConfirm: async () => {
        setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
        const r = await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
        if (!r.ok) toast.error("Delete failed.");
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Archived chats</DialogTitle>
          <DialogDescription>Archived chats stay searchable. Restore one to bring it back to Recents.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[50vh] overflow-y-auto">
          {failed ? (
            <p className="px-2 py-6 text-center text-body text-muted-foreground">Couldn’t load archived chats.</p>
          ) : items == null ? (
            <div className="space-y-1 px-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="skeleton h-10 rounded-control" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-2 py-6 text-center text-body text-muted-foreground">Nothing archived.</p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((c) => (
                <li key={c.id} className="group flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-accent">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      router.push(`/chat/${c.id}`);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <SidebarMotionIcon kind="conversation" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{c.title || "New chat"}</span>
                      <span className="block truncate font-mono text-caption text-muted-foreground">
                        Archived {c.archivedAt ? new Date(c.archivedAt).toLocaleDateString() : ""}
                      </span>
                    </span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pressable kind="icon" size="sm" onClick={() => restore(c)} aria-label="Restore">
                        <ArchiveRestore className="size-4" />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent>Restore</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Pressable kind="icon" size="sm" onClick={() => destroy(c)} aria-label="Delete" className="danger-hover">
                        <ActionIcons.delete className="size-4" />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
