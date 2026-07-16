"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Box,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Command,
  Folder,
  Home,
  Library,
  MessageCircle,
  MoreVertical,
  PanelLeftClose,
  PanelLeft,
  Pencil,
  Plug,
  Search,
  Shapes,
  Plus,
  Trash2,
  Pin,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { UserMenu } from "@/components/app/user-menu";
import { AnimatedTitle } from "@/components/app/animated-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useApp } from "@/components/app/app-provider";
import { dateGroup, cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";

type ConfirmState = { title: string; description: string; confirmLabel: string; onConfirm: () => void } | null;

type SidebarProject = {
  id: string;
  name: string;
  updatedAt: string;
  conversationCount: number;
  fileCount?: number;
  coverUrl?: string | null;
};

export function AppSidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    conversations,
    folders,
    setFolders,
    updateConversation,
    removeConversation,
    activeConversationId,
    setSidebarOpen,
  } = useApp();
  const [query, setQuery] = React.useState("");
  const [folderFilter, setFolderFilter] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);
  // Date grouping (Today/Yesterday/…) depends on the local clock, so defer the
  // list to after mount to keep SSR and the first client render in agreement.
  const [mounted, setMounted] = React.useState(false);
  const [projects, setProjects] = React.useState<SidebarProject[]>([]);
  const [starredProjectIds, setStarredProjectIds] = React.useState<string[]>([]);
  const [starredCollapsed, setStarredCollapsed] = React.useState(false);
  const [recentsCollapsed, setRecentsCollapsed] = React.useState(false);
  // Home shows web + app chats; Code shows Juno Code sessions synced from the
  // app (conversations with kind "code"). Persisted like the collapse prefs.
  const [mode, setMode] = React.useState<"home" | "code">("home");
  const [renameTarget, setRenameTarget] = React.useState<SidebarProject | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renamingProject, setRenamingProject] = React.useState(false);

  const loadProjects = React.useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        const nextProjects = Array.isArray(data.projects) ? data.projects : [];
        React.startTransition(() => setProjects(nextProjects));
      }
    } catch {}
  }, []);

  const loadStarred = React.useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        const starred = JSON.parse(localStorage.getItem("starredProjects") || "[]");
        setStarredProjectIds(Array.isArray(starred) ? starred : []);
      } catch {
        setStarredProjectIds([]);
      }
    }
  }, []);

  React.useEffect(() => {
    setMounted(true);
    loadProjects();
    loadStarred();

    try {
      const starred = localStorage.getItem("juno:sidebar:starred:collapsed");
      if (starred) setStarredCollapsed(JSON.parse(starred));
      const recents = localStorage.getItem("juno:sidebar:recents:collapsed");
      if (recents) setRecentsCollapsed(JSON.parse(recents));
      const modePref = localStorage.getItem("juno:sidebar:mode");
      if (modePref === "code") setMode("code");
    } catch {}

    const handleSync = () => {
      loadProjects();
      loadStarred();
    };

    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [loadProjects, loadStarred]);

  const toggleStarredCollapsed = () => {
    const next = !starredCollapsed;
    setStarredCollapsed(next);
    try {
      localStorage.setItem("juno:sidebar:starred:collapsed", JSON.stringify(next));
    } catch {}
  };

  const toggleRecentsCollapsed = () => {
    const next = !recentsCollapsed;
    setRecentsCollapsed(next);
    try {
      localStorage.setItem("juno:sidebar:recents:collapsed", JSON.stringify(next));
    } catch {}
  };

  // Only starred projects appear in the sidebar, most-recently-updated first.
  const sidebarProjects = React.useMemo(() => {
    return [...projects]
      .filter((p) => starredProjectIds.includes(p.id))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [projects, starredProjectIds]);

  const toggleProjectStar = (id: string) => {
    try {
      const raw = JSON.parse(localStorage.getItem("starredProjects") || "[]");
      const starred: string[] = Array.isArray(raw) ? raw : [];
      const isStarred = starred.includes(id);
      const nextStarred = isStarred ? starred.filter((pId) => pId !== id) : [...starred, id];
      localStorage.setItem("starredProjects", JSON.stringify(nextStarred));
      toast.success(isStarred ? "Project unpinned." : "Project pinned!");
      window.dispatchEvent(new CustomEvent("starred:sync"));
    } catch {}
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
        try {
          const raw = JSON.parse(localStorage.getItem("starredProjects") || "[]");
          const starred: string[] = Array.isArray(raw) ? raw : [];
          localStorage.setItem("starredProjects", JSON.stringify(starred.filter((pId) => pId !== project.id)));
        } catch {}
        window.dispatchEvent(new CustomEvent("projects:sync"));
        if (pathname === `/projects/${project.id}`) router.push("/projects");
      },
    });
  };

  const switchMode = React.useCallback((next: "home" | "code") => {
    setMode(next);
    try {
      localStorage.setItem("juno:sidebar:mode", next);
    } catch {}
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter(
      (c) =>
        (mode === "code" ? c.kind === "code" : c.kind !== "code") &&
        (!q || c.title.toLowerCase().includes(q)) &&
        (!folderFilter || c.folderId === folderFilter)
    );
  }, [conversations, query, folderFilter, mode]);

  // Code mode: group synced Juno Code sessions by their app-side workspace
  // (project folder), mirroring the app's own sidebar. Sessions without a
  // workspace fall through to the flat Sessions list below.
  const codeProjects = React.useMemo(() => {
    if (mode !== "code") return [] as { name: string; sessions: ClientConversation[] }[];
    const byName = new Map<string, ClientConversation[]>();
    for (const c of filtered) {
      const name = c.codeWorkspaceName?.trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(c);
    }
    return [...byName.entries()].map(([name, sessions]) => ({ name, sessions }));
  }, [filtered, mode]);


  const pinned = React.useMemo(() => filtered.filter((c) => c.pinned), [filtered]);
  const groups = React.useMemo(() => {
    const map = new Map<string, ClientConversation[]>();
    for (const c of filtered.filter((c) => !c.pinned)) {
      const g = dateGroup(c.lastMessageAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const newChat = () => {
    router.push("/chat");
    // If we're already on /chat the router.push is a no-op, so also
    // dispatch a reset event so ChatView clears any stale state.
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };


  const deleteFolder = (id: string) => {
    setConfirm({
      title: "Delete this folder?",
      description: "Conversations inside it are kept — they just move out of the folder.",
      confirmLabel: "Delete folder",
      onConfirm: async () => {
        setFolders(folders.filter((f) => f.id !== id));
        if (folderFilter === id) setFolderFilter(null);
        for (const c of conversations) if (c.folderId === id) updateConversation(c.id, { folderId: null });
        const res = await fetch(`/api/folders/${id}`, { method: "DELETE" });
        if (!res.ok) toast.error("Could not delete folder.");
      },
    });
  };

  // Collapsed icon rail (desktop only). Fixed width + keyed fade-in so the
  // content doesn't reflow while the shell animates the aside's width, and the
  // layout swap reads as a cross-fade instead of a pop.
  if (collapsed) {
    return (
      <div key="rail" className="flex h-full w-[64px] flex-col items-center bg-sidebar py-3 text-sidebar-foreground motion-safe:animate-fade-in">
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast hover:scale-105 active:scale-95 hover:bg-sidebar-accent"
        >
          <PanelLeft className="h-[18px] w-[18px] text-muted-foreground" />
        </button>
        <div className="mt-3 flex flex-col items-center gap-1">
          <RailIcon onClick={newChat} label="New chat">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast hover:scale-105 active:scale-95">
              <Plus className="h-4 w-4" />
            </span>
          </RailIcon>
          <RailIcon href="/library" active={pathname === "/library"} label="Library"><Library className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/artifacts" active={pathname === "/artifacts"} label="Artifacts"><Shapes className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/projects" active={!!pathname?.startsWith("/projects")} label="Projects"><Box className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/tasks" active={pathname === "/tasks"} label="Tasks"><CalendarClock className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/connections" active={pathname === "/connections"} label="Connections"><Plug className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))} label="Search (⌘K)">
            <Search className="h-[18px] w-[18px]" />
          </RailIcon>
        </div>
        <div className="mt-auto">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    <div key="expanded" className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground motion-safe:animate-fade-in md:w-[280px]">
      {/* pb-2 (+ the nav's pt-1) = 12px to the first row. This was pb-7, which
          left a ~32px void between the wordmark and "New chat" and read as a
          layout gap rather than a deliberate break. */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link href="/chat" onClick={() => setSidebarOpen(false)} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-serif text-2xl font-normal tracking-normal text-foreground pl-1">
            Juno
          </span>
        </Link>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
            aria-label="Search — command palette (⌘K)"
          >
            <Search className="h-4 w-4" />
          </Button>
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden md:inline-flex"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Home / Code — the same two surfaces as the Juno app. Code lists the
          Juno Code sessions synced from the Mac app. */}
      <div className="px-3 pb-2 pt-1">
        <div className="grid grid-cols-2 gap-0.5 rounded-[10px] bg-muted/50 p-0.5" role="tablist" aria-label="Sidebar mode">
          {(["home", "code"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-[8px] px-3 py-1 text-[13px] font-medium transition-colors duration-base ease-out-soft",
                mode === value
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
              )}
            >
              {value === "home" ? <Home className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
              {value === "home" ? "Home" : "Code"}
            </button>
          ))}
        </div>
      </div>

      {/* Primary nav (Claude-style rows) — the same full set in Home and Code,
          like the reference sidebars; only the session list below differs. */}
      <nav className="space-y-0.5 px-2 pt-1">
        <NavRow
          onClick={newChat}
          icon={
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast group-hover:scale-105">
              <Plus className="h-3.5 w-3.5" />
            </span>
          }
          label="New chat"
        />
        <NavRow href="/library" active={pathname === "/library"} onClick={() => setSidebarOpen(false)} icon={<Library className="h-[18px] w-[18px]" />} label="Library" />
        <NavRow href="/artifacts" active={pathname === "/artifacts"} onClick={() => setSidebarOpen(false)} icon={<Shapes className="h-[18px] w-[18px]" />} label="Artifacts" />
        <NavRow href="/connections" active={pathname === "/connections"} onClick={() => setSidebarOpen(false)} icon={<Plug className="h-[18px] w-[18px]" />} label="Connections" />
        <NavRow href="/projects" active={!!pathname?.startsWith("/projects")} onClick={() => setSidebarOpen(false)} icon={<Box className="h-[18px] w-[18px]" />} label="Projects" />
        <NavRow href="/tasks" active={pathname === "/tasks"} onClick={() => setSidebarOpen(false)} icon={<CalendarClock className="h-[18px] w-[18px]" />} label="Tasks" />
      </nav>

      <div className="pt-2" />

      {mode === "home" && folders.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          <FolderChip active={folderFilter === null} onClick={() => setFolderFilter(null)}>All</FolderChip>
          {folders.map((f) => (
            <FolderChip
              key={f.id}
              active={folderFilter === f.id}
              onClick={() => setFolderFilter(f.id)}
              onDelete={() => deleteFolder(f.id)}
            >
              {f.name}
            </FolderChip>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!mounted ? (
          <div className="space-y-1 px-1 pt-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-8 rounded-lg" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground" aria-live="polite">
            {query ? (
              <>No {mode === "code" ? "code sessions" : "chats"} match “{query}”.</>
            ) : mode === "code" ? (
              <>No Juno Code sessions yet.<br />They sync here from the Juno app.</>
            ) : (
              <>No conversations yet.<br />Start one above.</>
            )}
          </p>
        ) : (
          <>
            {mode === "code" && codeProjects.length > 0 && (
              <Section label="Projects">
                {codeProjects.map((p) => (
                  <div key={p.name}>
                    <div className="group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] font-medium text-sidebar-foreground/90 transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground">
                      <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-muted-foreground/70">
                        <Folder className="h-[16px] w-[16px]" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </div>
                    <div className="flex flex-col">
                      {p.sessions.map((c) => (
                        <Link
                          key={c.id}
                          href={`/chat/${c.id}`}
                          onClick={() => setSidebarOpen(false)}
                          aria-current={pathname === `/chat/${c.id}` ? "page" : undefined}
                          title={c.title}
                          className={cn(
                            "flex items-center rounded-md py-1 pl-11 pr-2 text-[13px] transition-all duration-fast ease-out-soft hover:translate-x-0.5 hover:bg-sidebar-accent",
                            pathname === `/chat/${c.id}`
                              ? "font-medium text-foreground"
                              : "text-sidebar-foreground/70 hover:text-foreground"
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{c.title || "New session"}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>
            )}
            {((mode === "home" && sidebarProjects.length > 0) || pinned.length > 0) && (
              <Section
                label="Pinned"
                count={(mode === "home" ? sidebarProjects.length : 0) + pinned.length}
                collapsible
                isCollapsed={starredCollapsed}
                onToggleCollapse={toggleStarredCollapsed}
              >
                {(mode === "home" ? sidebarProjects : []).map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    chats={conversations.filter((c) => c.projectId === p.id)}
                    active={pathname === `/projects/${p.id}`}
                    activePath={pathname}
                    starred={starredProjectIds.includes(p.id)}
                    onNavigate={() => setSidebarOpen(false)}
                    onNewChat={() => {
                      router.push(`/chat?project=${p.id}`);
                      setSidebarOpen(false);
                    }}
                    onToggleStar={() => toggleProjectStar(p.id)}
                    onRename={() => {
                      setRenameDraft(p.name);
                      setRenameTarget(p);
                    }}
                    onDelete={() => deleteProject(p)}
                  />
                ))}
                {pinned.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeConversationId}
                    renaming={renamingId === c.id}
                    setRenaming={setRenamingId}
                    projects={projects}
                    onUpdate={updateConversation}
                    onRemove={removeConversation}
                    onNavigate={() => setSidebarOpen(false)}
                    onRequestConfirm={setConfirm}
                  />
                ))}
              </Section>
            )}
            {filtered.filter((c) => !c.pinned).length > 0 && (
              <Section
                label={mode === "code" ? "Sessions" : "Recents"}
                count={filtered.filter((c) => !c.pinned).length}
                collapsible
                isCollapsed={recentsCollapsed}
                onToggleCollapse={toggleRecentsCollapsed}
              >
                {/* One flat list, newest first — no date-group headers. */}
                <div className="mt-1 space-y-0.5">
                    {groups
                      .flatMap(([, items]) => items)
                      .filter((c) => mode !== "code" || !c.codeWorkspaceName?.trim())
                      .map((c) => (
                      <ConversationRow
                        key={c.id}
                        conversation={c}
                        active={c.id === activeConversationId}
                        renaming={renamingId === c.id}
                        setRenaming={setRenamingId}
                        projects={projects}
                        onUpdate={updateConversation}
                        onRemove={removeConversation}
                        onNavigate={() => setSidebarOpen(false)}
                        onRequestConfirm={setConfirm}
                      />
                    ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>

      <div className="border-t border-sidebar-border p-2">
        <UserMenu />
      </div>

      {/* New-folder dialog (replaces window.prompt) */}

      {/* Confirm dialog (replaces window.confirm) */}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">{confirm?.title}</DialogTitle>
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

      {/* Project rename dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">Rename project</DialogTitle>
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
    </div>
  );
}

function RailIcon({
  href,
  onClick,
  label,
  active,
  children,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const cls = cn(
    "flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast ease-out-soft hover:scale-105 active:scale-95",
    active ? "bg-sidebar-accent text-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-foreground"
  );
  if (href) {
    return (
      <Link href={href} title={label} aria-label={label} aria-current={active ? "page" : undefined} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={cls}>
      {children}
    </button>
  );
}

/** Accent bar on the active row — scales/fades per row, so moving the active
 *  item reads as the old bar retracting while the new one grows in. */
function ActiveIndicator({ active }: { active?: boolean }) {
  return null;
}

function NavRow({
  href,
  onClick,
  icon,
  label,
  active,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  // Claude-density rows: a touch taller (py-2) with roomier gaps, so the nav
  // breathes like the reference sidebar instead of packing rows tight.
  const cls = cn(
    "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] font-medium transition-all duration-fast ease-out-soft hover:bg-sidebar-accent hover:translate-x-0.5",
    active
      ? "bg-sidebar-accent font-semibold text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
  );
  const inner = (
    <>
      <ActiveIndicator active={active} />
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-muted-foreground/80 transition-transform duration-fast group-hover:scale-105 group-hover:text-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(cls, "w-full text-left")}>
      {inner}
    </button>
  );
}

function Section({
  label,
  count,
  icon: Icon,
  children,
  collapsible,
  isCollapsed,
  onToggleCollapse,
  action,
}: {
  label: string;
  count?: number;
  icon?: typeof Pin;
  children: React.ReactNode;
  collapsible?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  action?: React.ReactNode;
}) {
  const headerInner = (
    <>
      {/* Claude-style header: sentence-case label with a small chevron hugging
          it ("Pinned ⌄") — no leading icon column, no count badge. */}
      {Icon && !collapsible && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
      <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/60">
        {label}
      </span>
      {collapsible && (
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform duration-fast ease-out-soft",
            isCollapsed && "-rotate-90"
          )}
        />
      )}
    </>
  );

  return (
    <div className="mb-5 mt-1">
      <div className="flex items-center">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!isCollapsed}
            className="pressable flex min-w-0 flex-1 select-none items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent/50"
          >
            {headerInner}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 select-none items-center gap-2.5 px-2 py-1.5">{headerInner}</div>
        )}
        {action != null && <span className="flex shrink-0 items-center pr-1">{action}</span>}
      </div>
      {/* Grid-rows sweep so 10+ rows don't appear/vanish in one frame; visibility
          rides the same transition, which also drops hidden rows from tab order. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,visibility] duration-base ease-out-soft",
          isCollapsed ? "invisible grid-rows-[0fr]" : "visible grid-rows-[1fr]"
        )}
      >
        <div
          className={cn(
            // -mx/px bleed keeps the rows' hover nudge from clipping at the fold edge.
            "-mx-2 min-h-0 overflow-hidden px-2 transition-opacity duration-base ease-out-soft",
            isCollapsed && "opacity-0"
          )}
        >
          <div className="space-y-0.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function FolderChip({
  active,
  onClick,
  onDelete,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "group/chip pressable inline-flex items-center rounded-full border text-xs",
        active ? "border-primary/40 bg-primary/10 text-primary" : "hover:bg-sidebar-accent"
      )}
    >
      <button onClick={onClick} aria-pressed={active} className={cn("inline-flex items-center gap-1 py-1 pl-2.5", onDelete ? "pr-1" : "pr-2.5")}>
        <Folder className="h-3 w-3" /> {children}
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete folder"
          className="mr-1 rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-destructive focus-visible:opacity-100 group-hover/chip:opacity-100 coarse:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function ConversationRow({
  conversation,
  active,
  renaming,
  setRenaming,
  projects,
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
}: {
  conversation: ClientConversation;
  active: boolean;
  renaming: boolean;
  setRenaming: (id: string | null) => void;
  projects: { id: string; name: string }[];
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState(conversation.title);

  const patch = async (data: Partial<Pick<ClientConversation, "title" | "titleSource" | "pinned" | "folderId" | "projectId">>) => {
    const optimistic = data.title != null ? { ...data, titleSource: "manual" as const } : data;
    onUpdate(conversation.id, optimistic);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.titleSource == null ? data : { ...data, titleSource: undefined }),
    });
    if (!res.ok) toast.error("Update failed.");
  };

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(null);
    if (title && title !== conversation.title) patch({ title });
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
          // Force ChatView to reset even if the URL was already /chat
          // (e.g. the chat was created on /chat and replaced via shallow URL).
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        }
      },
    });
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 pl-2 pr-1 py-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(null);
          }}
          className="h-8 w-full"
        />
        <Button size="icon-sm" variant="ghost" onClick={commitRename} aria-label="Save">
          <Check className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-center rounded-md pl-2 pr-1 transition-all duration-fast ease-out-soft hover:translate-x-0.5",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
      )}
    >
      <ActiveIndicator active={active} />
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-[14px] font-medium text-sidebar-foreground/90 hover:text-foreground",
          active && "font-semibold text-foreground"
        )}
        title={conversation.title}
      >
        {/* Claude-style: every chat carries the same speech-bubble mark. */}
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-muted-foreground/60 transition-colors duration-fast group-hover:text-foreground">
          <MessageCircle className="h-[15px] w-[15px]" />
        </span>
        <AnimatedTitle title={conversation.title} className="min-w-0 flex-1" />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="pressable rounded-sm p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:p-1.5 coarse:opacity-100"
            aria-label="Conversation options"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 origin-popper data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out">
          <DropdownMenuItem onSelect={() => patch({ pinned: !conversation.pinned })}>
            <Pin className={cn("h-4 w-4", conversation.pinned ? "fill-primary text-primary" : "")} />
            <span>{conversation.pinned ? "Unpin" : "Pin"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setDraft(conversation.title);
              setRenaming(conversation.id);
            }}
          >
            <Pencil className="h-4 w-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Box className="h-4 w-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 origin-popper data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out">
              <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                {conversation.projectId == null ? <Check className="h-4 w-4" /> : <span className="h-4 w-4" />} No project
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => patch({ projectId: p.id })}>
                  {conversation.projectId === p.id ? <Check className="h-4 w-4" /> : <Box className="h-4 w-4" />}
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/projects")}>
                <Plus className="h-4 w-4" /> New project…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={remove}
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
          >
            <Trash2 className="h-4 w-4" /> Delete
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
  // Per-project disclosure. Session-only state (plain useState, nothing
  // persisted), so every reload starts collapsed — the requested default.
  const [expanded, setExpanded] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const PREVIEW = 2;
  const visibleChats = showAll ? chats : chats.slice(0, PREVIEW);
  const hasChats = chats.length > 0;

  return (
    <div>
    <div
      className={cn(
        "group relative flex items-center rounded-md pl-2 pr-1 transition-all duration-fast ease-out-soft hover:translate-x-0.5",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
      )}
    >
      <ActiveIndicator active={active} />
      <Link
        href={`/projects/${project.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 items-center gap-2.5 py-1.5 text-[14px] font-medium text-sidebar-foreground/90 hover:text-foreground",
          active && "font-semibold text-foreground"
        )}
        title={project.name}
      >
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-muted-foreground/80 transition-transform duration-fast group-hover:scale-105 group-hover:text-foreground">
          <Box className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 truncate">{project.name}</span>
      </Link>
      {/* Claude-style disclosure: a small › hugging the name, rotating open. */}
      {hasChats && (
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => !v);
            if (expanded) setShowAll(false);
          }}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          aria-expanded={expanded}
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-fast ease-out-soft", expanded && "rotate-90")} />
        </button>
      )}
      <span className="min-w-0 flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="pressable rounded-sm p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:p-1.5 coarse:opacity-100"
            aria-label="Project options"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 origin-popper data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out">
          <DropdownMenuItem onSelect={onNewChat}>
            <Plus className="h-4 w-4" /> New chat in project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleStar}>
            <Pin className={cn("h-4 w-4", starred && "fill-primary text-primary")} />
            <span>{starred ? "Unpin" : "Pin"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="h-4 w-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {hasChats && expanded && (
      <div className="mt-0.5 flex flex-col">
        {visibleChats.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            onClick={onNavigate}
            aria-current={activePath === `/chat/${c.id}` ? "page" : undefined}
            title={c.title}
            className={cn(
              "group/pc flex items-center gap-2 rounded-md py-1 pl-9 pr-2 text-[12.5px] transition-all duration-fast ease-out-soft hover:translate-x-0.5 hover:bg-sidebar-accent",
              activePath === `/chat/${c.id}`
                ? "font-medium text-foreground"
                : "text-sidebar-foreground/70 hover:text-foreground"
            )}
          >
            <MessageCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/pc:text-foreground" />
            <span className="min-w-0 flex-1 truncate">{c.title || "New chat"}</span>
          </Link>
        ))}
        {chats.length > PREVIEW && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="flex items-center rounded-md py-1 pl-9 pr-2 text-[12px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {showAll ? "Show less" : `View all ${chats.length}`}
          </button>
        )}
      </div>
    )}
    </div>
  );
}
