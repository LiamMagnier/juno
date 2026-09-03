"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Pencil, Pin, Plus } from "lucide-react";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { DownloadMenu } from "@/components/app/download-menu";
import { UserMenu } from "@/components/app/user-menu";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
import { JunoMark } from "@/components/brand/logo";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ShareDialog } from "@/components/share/share-dialog";
import { PLANS } from "@/lib/plans";
import { spring, staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";

/* ────────────────────────────────────────────────────────────────────────────
 * The sidebar (docs/design/SOFT_UI.md §3).
 *
 * An inset well (the frame is painted by `.app-sidebar-frame` in the shell)
 * holding, top to bottom: brand + collapse, Search (⌘K), New chat, the
 * Chat · Code product switch, the nav destinations, Projects, Folders, Pinned,
 * Recents grouped by date, and a footer with the account, the plan meter and
 * the door to archived chats. The active row is the ONE raised object in the
 * well (`Pressable kind="row" selected` → `.surface-raised`); hover is the
 * flat accent wash.
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
const CHAT_DRAG_TYPE = "application/x-juno-chat";

const SECTION_KEYS = {
  projects: "juno:sidebar:projects:collapsed",
  folders: "juno:sidebar:folders:collapsed",
  pinned: "juno:sidebar:starred:collapsed",
  recents: "juno:sidebar:recents:collapsed",
} as const;

type SectionKey = keyof typeof SECTION_KEYS;

/**
 * The row kebab, once. `coarse:opacity-100` is not polish: reveal-on-hover is
 * the only way this control appears, and a touch device never hovers — on a
 * phone the drawer is the only route to rename, move or delete a chat.
 */
const KEBAB_CLASS =
  "group/kebab size-7 shrink-0 opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-sidebar-accent data-[state=open]:opacity-100 coarse:size-11 coarse:opacity-100";


function initialsOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function AppSidebar({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
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
    folders: false,
    pinned: false,
    recents: false,
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
      const next: Record<SectionKey, boolean> = { projects: false, folders: false, pinned: false, recents: false };
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
      toast.error("Could not update the project.");
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
      toast.error("Could not rename project.");
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
          toast.error("Could not delete project.");
          return;
        }
        toast.success("Project deleted.");
        window.dispatchEvent(new CustomEvent("projects:sync"));
        if (pathname === `/projects/${project.id}`) router.push("/projects");
      },
    });
  };

  /* ── Folders ─────────────────────────────────────────────────────────── */

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
        toast.error("Could not archive the chat.");
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
  // A chat filed in a folder lives under the folder — the folder IS its place
  // in the list — while project chats also stay in Recents, because a project
  // is a workspace rather than a filing.
  const recents = React.useMemo(
    () => live.filter((c) => !c.pinned),
    [live]
  );

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
  const usagePct = quota.limit != null && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : null;

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
          collapsed ? "w-[64px]" : "w-full md:w-[var(--juno-sidebar-width,256px)]"
        )}
      >
        {/* ── Brand + collapse ─────────────────────────────────────────── */}
        <motion.div
          layout
          transition={layoutTransition}
          className={cn("flex items-center pb-1 pt-3", collapsed ? "flex-col gap-1 px-0" : "justify-between px-3")}
        >
          <motion.div layout="position" transition={layoutTransition}>
            <Link
              href="/chat"
              onClick={() => setSidebarOpen(false)}
              aria-label="Juno home"
              className={cn("group/brand flex items-center gap-2 rounded-control", collapsed ? "size-11 justify-center" : "pl-1")}
            >
              <JunoMark className="h-[21px] w-[21px] shrink-0" />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.span
                    key="wordmark"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={reduceMotion ? { duration: 0 } : transition.fast}
                    className="overflow-hidden whitespace-nowrap font-sans text-lg font-semibold tracking-[-0.02em] text-foreground"
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
                    className={cn("group hidden md:inline-flex", collapsed && "size-11")}
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
                    className="group md:hidden"
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

        {/* ── Chat / Code product switch ───────────────────────────────── */}
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="product-switch"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={reduceMotion ? { duration: 0 } : transition.fast}
              className="overflow-hidden px-3"
            >
              <div className="pb-1 pt-2">
                <SegmentedControl<"chat" | "code">
                  value={pathname?.startsWith("/code") ? "code" : "chat"}
                  onChange={(next) => {
                    setSidebarOpen(false);
                    router.push(next === "code" ? "/code" : "/chat");
                  }}
                  ariaLabel="Chat or Code"
                  className="w-full"
                  optionClassName="gap-1.5 px-3 py-1.5 text-ui font-medium"
                  options={[
                    { value: "chat", label: "Chat", icon: <SidebarMotionIcon kind="home" className="size-3.5" /> },
                    { value: "code", label: "Code", icon: <SidebarMotionIcon kind="code" className="size-3.5" /> },
                  ]}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Search + New chat ────────────────────────────────────────── */}
        <div className={cn("space-y-0.5 pt-1", collapsed ? "px-2.5" : "px-2")}>
          <NavRow
            collapsed={collapsed}
            onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
            icon={<SidebarMotionIcon kind="search" />}
            label="Search"
            trailing={<Kbd>⌘K</Kbd>}
            layoutId="nav-search"
            transition={layoutTransition}
          />
          <NavRow
            collapsed={collapsed}
            onClick={newChat}
            icon={
              <span className="flex h-[22px] w-[22px] items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                <SidebarMotionIcon kind="new" className="h-[17px] w-[17px]" />
              </span>
            }
            label="New chat"
            trailing={<Kbd>⌘⇧O</Kbd>}
            layoutId="nav-new"
            transition={layoutTransition}
          />
        </div>

        {/* ── Destinations ─────────────────────────────────────────────── */}
        {/* Library · Projects · Artifacts, then More for the rest. The rail
            keeps the same order icon-only; More opens the same flyout. */}
        <nav className={cn("space-y-0.5 pt-1", collapsed ? "px-2.5" : "px-2")} aria-label="Primary">
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
          {collapsed && (
            <NavRow
              collapsed
              href="/code"
              active={!!pathname?.startsWith("/code")}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="code" />}
              label="Code"
              layoutId="nav-code"
              transition={layoutTransition}
            />
          )}
        </nav>

        {/* ── Lists ────────────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-3", collapsed ? "px-2.5" : "px-2")}
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
                          <SectionAction label="All projects" onClick={() => router.push("/projects")}>
                            <ChevronRight className="size-3.5" />
                          </SectionAction>
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

                    {recents.length > 0 ? (
                      <Section
                        label="Recents"
                        isCollapsed={sectionCollapsed.recents}
                        onToggleCollapse={() => toggleSection("recents")}
                      >
                        <div className="space-y-0.5">
                          {recents.slice(0, recentsLimit).map((c) => (
                            <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} {...rowProps} />
                          ))}
                        </div>
                        {recents.length > recentsLimit && (
                          <div ref={sentinelRef} className="flex justify-center py-2" aria-hidden>
                            <span className="skeleton h-2 w-16 rounded-full" />
                          </div>
                        )}
                      </Section>
                    ) : (
                      live.length === 0 &&
                      sidebarProjects.length === 0 && (
                        <p className="px-3 py-8 text-center text-sm text-muted-foreground" aria-live="polite">
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
        <motion.div
          layout
          transition={layoutTransition}
          className={cn("border-t border-sidebar-border/70", collapsed ? "flex flex-col items-center gap-1 px-2.5 py-2" : "px-2 pb-2 pt-1.5")}
        >
          <NavRow
            collapsed={collapsed}
            href="/design"
            active={pathname === "/design"}
            onClick={() => setSidebarOpen(false)}
            icon={<Pencil className="size-[17px]" />}
            label="Design"
            layoutId="nav-design"
            transition={layoutTransition}
          />
          {collapsed ? (
            <div className="flex flex-col items-center gap-1 pt-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Pressable
                    kind="icon"
                    size="lg"
                    aria-label="Settings"
                    onClick={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }))}
                    className="group size-11 text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
                  >
                    <AppIcons.settings className="size-[18px]" />
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="right">Settings</TooltipContent>
              </Tooltip>
              <UserMenu compact />
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <UserMenu
                  trigger={
                    <Pressable kind="row" className="group gap-2.5 px-2 py-1.5 hover:bg-sidebar-accent">
                      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full surface-raised">
                        {user.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={user.image} alt="" className="size-full object-cover" />
                        ) : (
                          <span className="font-mono text-caption font-medium text-muted-foreground">
                            {initialsOf(user.name, user.email)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{user.name ?? user.email}</span>
                        <span className="block truncate text-caption text-muted-foreground">
                          {plan.name}
                          {usagePct != null ? ` · ${quota.used} / ${quota.limit} messages` : " · no cap"}
                        </span>
                        {usagePct != null && (
                          <Progress
                            value={usagePct}
                            tone={usagePct >= 100 ? "destructive" : usagePct >= 80 ? "warning" : "primary"}
                            aria-label={`${quota.used} of ${quota.limit} messages used`}
                            className="mt-1.5 h-1.5"
                          />
                        )}
                      </span>
                    </Pressable>
                  }
                />
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Settings"
                      onClick={() => window.dispatchEvent(new CustomEvent("juno:settings", { detail: "general" }))}
                      className="group text-sidebar-foreground hover:text-foreground"
                    >
                      <AppIcons.settings className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Settings</TooltipContent>
                </Tooltip>
                <DownloadMenu />
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
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground [.surface-raised_&]:text-foreground">
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
  const el = href ? (
    <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} aria-label={collapsed ? label : undefined} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} aria-label={collapsed ? label : undefined} className={cn(cls, "text-left")}>
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

/** The sidebar row recipe, shared by NavRow and the More trigger. */
function navRowClass(collapsed: boolean, active: boolean) {
  return cn(
    "group relative flex min-h-9 w-full items-center rounded-control text-sm font-medium transition-[background-color,color,box-shadow,border-color] duration-fast ease-out-soft",
    // The rail: a 44px target around the same 22px glyph, so every icon is
    // one tap and the row's tooltip names it.
    collapsed ? "size-11 justify-center px-0" : "gap-2.5 px-2.5 py-1.5",
    active
      ? "surface-raised border-border/60 font-semibold text-foreground"
      : "border border-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
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
  const items = [
    { href: "/assistants", kind: "assistants" as const, label: "Assistants", active: pathname === "/assistants" },
    { href: "/connections", kind: "connections" as const, label: "Connections", active: pathname === "/connections" },
    { href: "/tasks", kind: "tasks" as const, label: "Tasks", active: pathname === "/tasks" },
  ];
  const anyActive = items.some((item) => item.active);
  const rowClass =
    "flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-sm font-medium text-foreground outline-none transition-[background-color] duration-fast ease-out-soft hover:bg-accent focus-visible:bg-accent motion-reduce:transition-none coarse:h-11";
  const trigger = (
    <button
      type="button"
      aria-label={collapsed ? "More" : undefined}
      aria-haspopup="menu"
      className={cn(navRowClass(collapsed, false), open && "bg-sidebar-accent text-foreground", anyActive && "text-foreground")}
    >
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
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
      className="mx-0.5 my-1 flex items-center gap-2 rounded-xs border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-ui text-destructive"
    >
      <StatusIcons.error className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="pressable flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5 font-medium hover:bg-destructive/20 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

function SectionAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          kind="icon"
          size="sm"
          onClick={onClick}
          aria-label={label}
          className="text-muted-foreground/80 opacity-0 transition-opacity duration-fast group-hover/section:opacity-100 focus-visible:opacity-100 coarse:opacity-100"
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
    <div className="group/section mb-3">
      <div className="flex items-center">
        <Pressable
          kind="row"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          className="min-w-0 flex-1 select-none gap-1.5 px-2.5 py-1 hover:bg-sidebar-accent"
        >
          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-fast ease-out-soft",
              isCollapsed && "-rotate-90"
            )}
          />
        </Pressable>
        {action != null && <span className="flex shrink-0 items-center pr-0.5">{action}</span>}
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
          "-mx-2 min-h-0 overflow-hidden px-2 transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          !open && "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Inline rename/create field, shared by chats and folders. */
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
    <div className={cn("flex items-center gap-1 py-0.5 pl-1 pr-1", nested && "pl-5")}>
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
        className="h-8 w-full text-sm"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={commit} aria-label="Save">
            <StatusIcons.success className="size-4" />
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
    <div
      className={cn(
        "group relative flex items-center rounded-control border pr-1 transition-[background-color,color,border-color,box-shadow] duration-fast ease-out-soft",
        nested ? "pl-5" : "pl-2",
        active ? "surface-raised border-border/60 text-foreground" : "border-transparent hover:bg-sidebar-accent"
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_DRAG_TYPE, conversation.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 font-medium text-sidebar-foreground/90 hover:text-foreground",
          nested ? "text-ui" : "text-sm",
          active && "font-semibold text-foreground"
        )}
        title={conversation.title}
      >
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
          <SidebarMotionIcon kind="conversation" className={nested ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"} />
        </span>
        <AnimatedTitle title={conversation.title || "New chat"} animate={conversation.titleSource === "ai"} className="min-w-0 flex-1" />
        {conversation.pinned && !nested && <Pin className="size-3 shrink-0 fill-current text-muted-foreground/60" aria-hidden />}
      </Link>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" className={KEBAB_CLASS} aria-label="Conversation options">
                <SidebarMotionIcon kind="more" className="size-4" />
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
  const [expanded, setExpanded] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const PREVIEW = 3;
  const visibleChats = showAll ? chats : chats.slice(0, PREVIEW);
  const hasChats = chats.length > 0;

  return (
    <div>
      <div
        className={cn(
          "group relative flex items-center rounded-control border pl-2 pr-1 transition-[background-color,color,border-color,box-shadow] duration-fast ease-out-soft",
          active ? "surface-raised border-border/60 text-foreground" : "border-transparent hover:bg-sidebar-accent"
        )}
      >
        <Link
          href={`/projects/${project.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-sm font-medium text-sidebar-foreground/90 hover:text-foreground",
            active && "font-semibold text-foreground"
          )}
          title={project.name}
        >
          <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
            <SidebarMotionIcon kind="projects" className="h-[15px] w-[15px]" />
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
                className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground coarse:-my-3 coarse:size-11"
              >
                <ChevronRight className={cn("size-3.5 transition-transform duration-fast ease-out-soft", expanded && "rotate-90")} />
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
                  <SidebarMotionIcon kind="more" className="size-4" />
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
          <div className="mt-0.5 flex flex-col">
            {visibleChats.map((c) => (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={onNavigate}
                aria-current={activePath === `/chat/${c.id}` ? "page" : undefined}
                title={c.title}
                className={cn(
                  "group group/pc flex items-center gap-2 rounded-xs py-1 pl-9 pr-2 text-ui transition-[color,background-color] duration-fast ease-out-soft hover:bg-sidebar-accent",
                  activePath === `/chat/${c.id}` ? "bg-sidebar-accent font-medium text-foreground" : "text-sidebar-foreground/70 hover:text-foreground"
                )}
              >
                <SidebarMotionIcon
                  kind="conversation"
                  className="size-3.5 shrink-0 text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover/pc:text-foreground"
                />
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {c.title || "New chat"}
                </span>
              </Link>
            ))}
            {chats.length > PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex items-center rounded-xs py-1 pl-9 pr-2 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground"
              >
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
      toast.error("Could not restore the chat.");
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
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">Could not load archived chats.</p>
          ) : items == null ? (
            <div className="space-y-1 px-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="skeleton h-10 rounded-control" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing archived.</p>
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
                      <span className="block truncate text-sm font-medium">{c.title || "New chat"}</span>
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
