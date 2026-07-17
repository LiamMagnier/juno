"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  Box,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Folder,
  GitPullRequest,
  Home,
  Library,
  MessageCircle,
  MoreVertical,
  PanelLeftClose,
  PanelLeft,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Shapes,
  Plus,
  Trash2,
  Pin,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { UserMenu } from "@/components/app/user-menu";
import { JunoMark } from "@/components/brand/logo";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useApp } from "@/components/app/app-provider";
import { CODE_SYNC_EVENT } from "@/hooks/use-code-session";
import { cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";

type ConfirmState = { title: string; description: string; confirmLabel: string; onConfirm: () => void } | null;

type SidebarProject = {
  id: string;
  name: string;
  starred: boolean;
  updatedAt: string;
  conversationCount: number;
  fileCount?: number;
  coverUrl?: string | null;
};

/** `key` is the stable server-synced workspace identity (nullable for rows
 *  mirrored by pre-key clients); `path` is device metadata. */
type CodeWorkspace = { id: string; name: string; path: string; key?: string | null; lastOpenedAt: string };

/** Remote Juno Code task (from /api/code/tasks) — status rides on these rows.
 *  Tasks started from a web session carry its conversationId and show as a
 *  status dot on that session's row; unlinked tasks (started from the app)
 *  attach to their workspace group as plain status rows. */
type CodeTaskRow = {
  id: string;
  conversationId: string | null;
  workspacePath: string;
  workspaceName: string;
  workspaceKey: string | null;
  title: string;
  status: string;
  createdAt: string;
};

const CODE_EXPANDED_KEY = "juno:sidebar:code:expanded";
const LEGACY_STARRED_KEY = "starredProjects";
// Matches the session view's presence poll: frequent enough that a status dot
// settles on its own, gentle enough to sit behind an idle Code tab all day.
const CODE_POLL_MS = 30_000;
// A failed task stays visible for a day; after that it's stale noise.
const FAILED_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "awaiting_approval"]);

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
    updateConversation,
    removeConversation,
    activeConversationId,
    setSidebarOpen,
  } = useApp();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);
  // Date grouping (Today/Yesterday/…) depends on the local clock, so defer the
  // list to after mount to keep SSR and the first client render in agreement.
  const [mounted, setMounted] = React.useState(false);
  const [projects, setProjects] = React.useState<SidebarProject[]>([]);
  const [projectsError, setProjectsError] = React.useState(false);
  const [starredCollapsed, setStarredCollapsed] = React.useState(false);
  const [recentsCollapsed, setRecentsCollapsed] = React.useState(false);
  // Home shows web + app chats; Code shows Juno Code sessions synced from the
  // app (conversations with kind "code"). Persisted like the collapse prefs.
  const [mode, setMode] = React.useState<"home" | "code">("home");
  // Code mode data: the app's workspaces (project folders) mirrored from
  // /api/code/workspaces, and remote code tasks for status rows.
  const [codeWorkspaces, setCodeWorkspaces] = React.useState<CodeWorkspace[]>([]);
  const [codeTasks, setCodeTasks] = React.useState<CodeTaskRow[]>([]);
  const [codeLoaded, setCodeLoaded] = React.useState(false);
  const [codeError, setCodeError] = React.useState(false);
  // Per-workspace disclosure, persisted; unlisted paths default to open.
  const [codeExpanded, setCodeExpanded] = React.useState<Record<string, boolean>>({});
  const [renameTarget, setRenameTarget] = React.useState<SidebarProject | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renamingProject, setRenamingProject] = React.useState(false);

  // One-shot migration guard: legacy localStorage stars are pushed to the
  // server on the first successful projects load, then the key is dropped.
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
            // Only drop the legacy key once every star made it to the server.
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
      const starred = localStorage.getItem("juno:sidebar:starred:collapsed");
      if (starred) setStarredCollapsed(JSON.parse(starred));
      const recents = localStorage.getItem("juno:sidebar:recents:collapsed");
      if (recents) setRecentsCollapsed(JSON.parse(recents));
      const modePref = localStorage.getItem("juno:sidebar:mode");
      if (modePref === "code") setMode("code");
      const expanded = JSON.parse(localStorage.getItem(CODE_EXPANDED_KEY) || "{}");
      if (expanded && typeof expanded === "object") setCodeExpanded(expanded);
    } catch {}

    const handleSync = () => {
      loadProjects();
    };

    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [loadProjects]);

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
      .filter((p) => p.starred)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [projects]);

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
    toast.success(next ? "Project pinned!" : "Project unpinned.");
    window.dispatchEvent(new CustomEvent("starred:sync"));
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

  const switchMode = React.useCallback((next: "home" | "code") => {
    setMode(next);
    try {
      localStorage.setItem("juno:sidebar:mode", next);
    } catch {}
  }, []);

  const filtered = React.useMemo(() => {
    // Home shows every web/app chat; Code shows the synced Juno Code sessions.
    // Grouping now lives in Projects, so there's no folder scoping here.
    return conversations.filter((c) => (mode === "code" ? c.kind === "code" : c.kind !== "code"));
  }, [conversations, mode]);

  const loadCode = React.useCallback(async () => {
    setCodeError(false);
    try {
      const [w, t] = await Promise.all([fetch("/api/code/workspaces"), fetch("/api/code/tasks?limit=100")]);
      if (!w.ok || !t.ok) throw new Error();
      const wd = await w.json();
      const td = await t.json();
      setCodeWorkspaces(Array.isArray(wd.workspaces) ? wd.workspaces : []);
      setCodeTasks(
        (Array.isArray(td.tasks) ? td.tasks : []).map(
          (x: Record<string, unknown>): CodeTaskRow => ({
            id: String(x.id ?? ""),
            conversationId: typeof x.conversationId === "string" && x.conversationId ? x.conversationId : null,
            workspacePath: String(x.workspacePath ?? ""),
            workspaceName: String(x.workspaceName ?? ""),
            workspaceKey: typeof x.workspaceKey === "string" && x.workspaceKey ? x.workspaceKey : null,
            title: String(x.title ?? ""),
            status: String(x.status ?? ""),
            createdAt: String(x.createdAt ?? ""),
          })
        )
      );
      setCodeLoaded(true);
    } catch {
      setCodeError(true);
    }
  }, []);

  // The sidebar mounts once in the persistent shell, so a single load on mode
  // flip left status dots frozen ("Running" forever). Poll gently while Code
  // mode is on screen and the tab is visible, refresh on refocus, and react
  // immediately when a session hook reports a task start/finish.
  React.useEffect(() => {
    if (mode !== "code") return;
    void loadCode();
    const tick = () => {
      if (!document.hidden) void loadCode();
    };
    const interval = window.setInterval(tick, CODE_POLL_MS);
    window.addEventListener(CODE_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(CODE_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [mode, loadCode]);

  // `id` is the group's stable identity: workspace key when synced, else path.
  // `current` is the resolved on-screen state (includes the legacy path-keyed
  // fallback), so the first toggle after an id migration still flips visibly.
  const toggleWorkspaceExpanded = (id: string, current: boolean) => {
    setCodeExpanded((prev) => {
      const next = { ...prev, [id]: !current };
      try {
        localStorage.setItem(CODE_EXPANDED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Code mode: group synced Juno Code sessions by their app-side workspace
  // (project folder), mirroring the app's own sidebar. Attribution is by the
  // stable workspace key when both sides carry one (a moved folder keeps its
  // sessions grouped); path, then name, remain the fallback for pre-key rows.
  // Sessions without a workspace fall through to the flat Sessions list below.
  const codeProjects = React.useMemo(() => {
    if (mode !== "code")
      return [] as { id: string; key: string | null; name: string; path: string; sessions: ClientConversation[] }[];
    const sessionsFor = (w: { key: string | null; name: string; path: string }) =>
      filtered.filter((c) => {
        // Both sides keyed → identity decides, path/name are just metadata.
        if (c.codeWorkspaceKey && w.key) return c.codeWorkspaceKey === w.key;
        return c.codeWorkspacePath === w.path || (!c.codeWorkspacePath && c.codeWorkspaceName?.trim() === w.name);
      });
    const projects = codeWorkspaces.map((w) => {
      const key = w.key ?? null;
      return { id: key ?? w.path, key, name: w.name, path: w.path, sessions: sessionsFor({ key, name: w.name, path: w.path }) };
    });
    // Sessions naming a workspace the mirror doesn't know yet still group.
    const knownKeys = new Set(projects.map((p) => p.key).filter((k): k is string => k != null));
    const known = new Set(projects.map((p) => p.path));
    const knownNames = new Set(projects.map((p) => p.name));
    const orphans = new Map<string, ClientConversation[]>();
    for (const c of filtered) {
      const name = c.codeWorkspaceName?.trim();
      if (!name || knownNames.has(name)) continue;
      if (c.codeWorkspaceKey && knownKeys.has(c.codeWorkspaceKey)) continue;
      if (c.codeWorkspacePath && known.has(c.codeWorkspacePath)) continue;
      if (!orphans.has(name)) orphans.set(name, []);
      orphans.get(name)!.push(c);
    }
    return [
      ...projects,
      ...[...orphans.entries()].map(([name, sessions]) => ({ id: name, key: null, name, path: name, sessions })),
    ];
  }, [filtered, mode, codeWorkspaces]);

  // A grouped session lives ONLY in its workspace group — never duplicated in
  // Pinned or the flat Sessions list (pinning still floats it inside its group,
  // since the server sorts pinned-first).
  const groupedSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const p of codeProjects) for (const c of p.sessions) ids.add(c.id);
    return ids;
  }, [codeProjects]);

  // Session ids currently listed in Code mode — a task linked to one of these
  // shows as a status dot ON the session row, never as a duplicate status row.
  const codeSessionIds = React.useMemo(() => new Set(filtered.map((c) => c.id)), [filtered]);

  // The latest still-relevant task per linked session, for the row status dots.
  const taskByConversation = React.useMemo(() => {
    const map = new Map<string, CodeTaskRow>();
    const now = Date.now();
    for (const t of codeTasks) {
      if (!t.conversationId) continue;
      const relevant =
        ACTIVE_TASK_STATUSES.has(t.status) ||
        (t.status === "failed" && now - new Date(t.createdAt).getTime() < FAILED_TASK_TTL_MS);
      if (!relevant) continue;
      const existing = map.get(t.conversationId);
      if (!existing || new Date(t.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
        map.set(t.conversationId, t);
      }
    }
    return map;
  }, [codeTasks]);

  // Active/recent-failed remote tasks per workspace key, path AND name — key
  // wins when present (survives folder moves); orphan groups (name only)
  // still pick up their tasks.
  const codeTasksByWorkspace = React.useMemo(() => {
    const byKey = new Map<string, CodeTaskRow[]>();
    const byPath = new Map<string, CodeTaskRow[]>();
    const byName = new Map<string, CodeTaskRow[]>();
    const now = Date.now();
    for (const t of codeTasks) {
      const active =
        ACTIVE_TASK_STATUSES.has(t.status) ||
        (t.status === "failed" && now - new Date(t.createdAt).getTime() < FAILED_TASK_TTL_MS);
      if (!active) continue;
      // Attributed to a listed session — its row carries the dot instead.
      if (t.conversationId && codeSessionIds.has(t.conversationId)) continue;
      if (t.workspaceKey) {
        if (!byKey.has(t.workspaceKey)) byKey.set(t.workspaceKey, []);
        byKey.get(t.workspaceKey)!.push(t);
      }
      if (t.workspacePath) {
        if (!byPath.has(t.workspacePath)) byPath.set(t.workspacePath, []);
        byPath.get(t.workspacePath)!.push(t);
      }
      const name = t.workspaceName.trim();
      if (name) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(t);
      }
    }
    return { byKey, byPath, byName };
  }, [codeTasks, codeSessionIds]);

  const pinned = React.useMemo(
    () => filtered.filter((c) => c.pinned && !(mode === "code" && groupedSessionIds.has(c.id))),
    [filtered, mode, groupedSessionIds]
  );
  const recents = React.useMemo(
    () => filtered.filter((c) => !c.pinned && !(mode === "code" && groupedSessionIds.has(c.id))),
    [filtered, mode, groupedSessionIds]
  );

  const newChat = () => {
    router.push("/chat");
    // If we're already on /chat the router.push is a no-op, so also
    // dispatch a reset event so ChatView clears any stale state.
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };

  const newCodeSession = () => {
    router.push("/code/new");
    setSidebarOpen(false);
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
          className="group flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast active:scale-95 hover:bg-sidebar-accent"
        >
          <PanelLeft className="h-[18px] w-[18px] text-muted-foreground transition-transform duration-fast group-hover:scale-110" />
        </button>
        <div className="mt-3">
          <ModeToggle mode={mode} onChange={switchMode} compact />
        </div>
        <div className="mt-3 flex flex-col items-center gap-1">
          {mode === "code" ? (
            <>
              <RailIcon onClick={newCodeSession} label="New session">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast group-hover:scale-110">
                  <Plus className="h-4 w-4" />
                </span>
              </RailIcon>
              <RailIcon href="/code/pulls" active={pathname === "/code/pulls"} label="Pull requests"><GitPullRequest className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/tasks" active={pathname === "/tasks"} label="Scheduled"><CalendarClock className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/connections" active={pathname === "/connections"} label="Plugins"><Plug className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
            </>
          ) : (
            <>
              <RailIcon onClick={newChat} label="New chat">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast group-hover:scale-110">
                  <Plus className="h-4 w-4" />
                </span>
              </RailIcon>
              <RailIcon href="/library" active={pathname === "/library"} label="Library"><Library className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/artifacts" active={pathname === "/artifacts"} label="Artifacts"><Shapes className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/projects" active={!!pathname?.startsWith("/projects")} label="Projects"><Box className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/tasks" active={pathname === "/tasks"} label="Tasks"><CalendarClock className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
              <RailIcon href="/connections" active={pathname === "/connections"} label="Connections"><Plug className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" /></RailIcon>
            </>
          )}
          <RailIcon onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))} label="Search chats and projects">
            <Search className="h-[18px] w-[18px] transition-transform duration-fast group-hover:scale-110" />
          </RailIcon>
        </div>
        <div className="mt-auto">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    // Desktop width rides the shell's --juno-sidebar-width (user-resizable);
    // keeping it on the inner column preserves the collapse clip-reveal.
    <div key="expanded" className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground motion-safe:animate-fade-in md:w-[var(--juno-sidebar-width,280px)]">
      {/* pb-2 (+ the nav's pt-1) = 12px to the first row. This was pb-7, which
          left a ~32px void between the wordmark and "New chat" and read as a
          layout gap rather than a deliberate break. */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link href="/chat" onClick={() => setSidebarOpen(false)} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex items-center gap-2 pl-1">
            <JunoMark className="h-[22px] w-[22px] transition-transform duration-base ease-out-soft group-hover/brand:-rotate-6 group-hover/brand:scale-105" />
            <span className="font-serif text-2xl font-normal tracking-normal text-foreground">Juno</span>
          </span>
        </Link>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="group"
            onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
            aria-label="Search chats and projects"
          >
            <Search className="h-4 w-4 transition-transform duration-fast group-hover:scale-110" />
          </Button>
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="group hidden md:inline-flex"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4 transition-transform duration-fast group-hover:scale-110" />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" className="group md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X className="h-4 w-4 transition-transform duration-fast group-hover:scale-110" />
          </Button>
        </div>
      </div>

      {/* Home / Code — the same two surfaces as the Juno app. Code lists the
          Juno Code sessions synced from the Mac app. */}
      <div className="px-3 pb-2 pt-1">
        <ModeToggle mode={mode} onChange={switchMode} />
      </div>

      {/* Primary destinations — Home keeps the full chat nav; Code gets its own
          compact set (only surfaces with a real data path behind them). */}
      <nav className="space-y-0.5 px-2 pt-1">
        {mode === "code" ? (
          <>
            <NavRow
              onClick={newCodeSession}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-muted-foreground/15 text-foreground">
                  <Plus className="h-3.5 w-3.5 transition-transform duration-base ease-out-soft group-hover:rotate-90" />
                </span>
              }
              label="New session"
            />
            <NavRow href="/code/pulls" active={pathname === "/code/pulls"} onClick={() => setSidebarOpen(false)} icon={<GitPullRequest className="h-[18px] w-[18px]" />} label="Pull requests" />
            <NavRow href="/tasks" active={pathname === "/tasks"} onClick={() => setSidebarOpen(false)} icon={<CalendarClock className="h-[18px] w-[18px]" />} label="Scheduled" />
            <NavRow href="/connections" active={pathname === "/connections"} onClick={() => setSidebarOpen(false)} icon={<Plug className="h-[18px] w-[18px]" />} label="Plugins" />
          </>
        ) : (
          <>
            <NavRow
              onClick={newChat}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-muted-foreground/15 text-foreground">
                  <Plus className="h-3.5 w-3.5 transition-transform duration-base ease-out-soft group-hover:rotate-90" />
                </span>
              }
              label="New chat"
            />
            <NavRow href="/library" active={pathname === "/library"} onClick={() => setSidebarOpen(false)} icon={<Library className="h-[18px] w-[18px]" />} label="Library" />
            <NavRow href="/artifacts" active={pathname === "/artifacts"} onClick={() => setSidebarOpen(false)} icon={<Shapes className="h-[18px] w-[18px]" />} label="Artifacts" />
            <NavRow href="/connections" active={pathname === "/connections"} onClick={() => setSidebarOpen(false)} icon={<Plug className="h-[18px] w-[18px]" />} label="Connections" />
            <NavRow href="/projects" active={!!pathname?.startsWith("/projects")} onClick={() => setSidebarOpen(false)} icon={<Box className="h-[18px] w-[18px]" />} label="Projects" />
            <NavRow href="/tasks" active={pathname === "/tasks"} onClick={() => setSidebarOpen(false)} icon={<CalendarClock className="h-[18px] w-[18px]" />} label="Tasks" />
          </>
        )}
      </nav>

      <div className="pt-2" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!mounted ? (
          <div className="space-y-1 px-1 pt-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-8 rounded-lg" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : mode === "code" ? (
          <>
            {/* Projects always renders in Code mode — a mirror with zero
                sessions still has workspaces worth showing (commit 4364b90). */}
            <Section label="Projects">
              {codeError ? (
                <InlineErrorRow message="Couldn’t load your Code projects." onRetry={loadCode} />
              ) : !codeLoaded ? (
                <div className="space-y-1 px-1 pt-1">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="skeleton h-8 rounded-lg" style={{ animationDelay: `${i * 60}ms` }} />
                  ))}
                </div>
              ) : codeProjects.length === 0 ? (
                <p className="px-2.5 py-1 text-[12.5px] leading-5 text-muted-foreground">
                  Your Juno Code projects appear here once the app syncs them.
                </p>
              ) : (
                codeProjects.map((p) => (
                  <CodeWorkspaceGroup
                    key={p.id}
                    name={p.name}
                    sessions={p.sessions}
                    tasks={
                      (p.key ? codeTasksByWorkspace.byKey.get(p.key) : undefined) ??
                      codeTasksByWorkspace.byPath.get(p.path) ??
                      codeTasksByWorkspace.byName.get(p.name) ??
                      []
                    }
                    taskStatusFor={(id) => taskByConversation.get(id)?.status}
                    // Legacy prefs were keyed by path; fall back so an upgrade
                    // (path → key ids) doesn't reset anyone's disclosure state.
                    expanded={codeExpanded[p.id] ?? codeExpanded[p.path] ?? true}
                    onToggle={() => toggleWorkspaceExpanded(p.id, codeExpanded[p.id] ?? codeExpanded[p.path] ?? true)}
                    activeConversationId={activeConversationId}
                    activePath={pathname}
                    renamingId={renamingId}
                    setRenaming={setRenamingId}
                    onUpdate={updateConversation}
                    onRemove={removeConversation}
                    onNavigate={() => setSidebarOpen(false)}
                    onRequestConfirm={setConfirm}
                  />
                ))
              )}
            </Section>
            {pinned.length > 0 && (
              <Section
                label="Pinned"
                collapsible
                isCollapsed={starredCollapsed}
                onToggleCollapse={toggleStarredCollapsed}
              >
                {pinned.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    variant="code"
                    taskStatus={taskByConversation.get(c.id)?.status}
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
            {recents.length > 0 && (
              <Section
                label="Sessions"
                collapsible
                isCollapsed={recentsCollapsed}
                onToggleCollapse={toggleRecentsCollapsed}
              >
                {/* One flat list, newest first — sessions the app hasn't tied
                    to a workspace. */}
                <div className="mt-1 space-y-0.5">
                  {recents.map((c) => (
                    <ConversationRow
                      key={c.id}
                      conversation={c}
                      variant="code"
                      taskStatus={taskByConversation.get(c.id)?.status}
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
        ) : filtered.length === 0 && sidebarProjects.length === 0 ? (
          <>
            {projectsError && <InlineErrorRow message="Couldn’t load your projects." onRetry={loadProjects} />}
            <p className="px-3 py-8 text-center text-sm text-muted-foreground" aria-live="polite">
              No conversations yet.<br />Start one above.
            </p>
          </>
        ) : (
          <>
            {projectsError && <InlineErrorRow message="Couldn’t load your projects." onRetry={loadProjects} />}
            {(sidebarProjects.length > 0 || pinned.length > 0) && (
              <Section
                label="Pinned"
                collapsible
                isCollapsed={starredCollapsed}
                onToggleCollapse={toggleStarredCollapsed}
              >
                {sidebarProjects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    chats={conversations.filter((c) => c.projectId === p.id)}
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
            {recents.length > 0 && (
              <Section
                label="Recents"
                collapsible
                isCollapsed={recentsCollapsed}
                onToggleCollapse={toggleRecentsCollapsed}
              >
                {/* One flat list, newest first — no date-group headers. */}
                <div className="mt-1 space-y-0.5">
                  {recents.map((c) => (
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

/** Home/Code switch. A thin wrapper over the shared SegmentedControl: same
 *  depth idiom (well track + raised thumb) and radiogroup semantics, laid out
 *  vertically (icon-only) in the collapsed rail. The segment icons keep the
 *  sidebar's hover micro-motion. */
function ModeToggle({
  mode,
  onChange,
  compact,
}: {
  mode: "home" | "code";
  onChange: (mode: "home" | "code") => void;
  compact?: boolean;
}) {
  const iconCls =
    "h-3.5 w-3.5 transition-transform duration-fast ease-out-soft group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100";
  return (
    <SegmentedControl
      value={mode}
      onChange={onChange}
      ariaLabel="Sidebar mode"
      orientation={compact ? "vertical" : "horizontal"}
      labelHidden={compact}
      ringOffsetClassName="focus-visible:ring-offset-sidebar"
      options={[
        { value: "home", label: "Home", icon: <Home className={iconCls} /> },
        { value: "code", label: "Code", icon: <Code className={iconCls} /> },
      ]}
    />
  );
}

/** Compact in-list failure row + retry — the sidebar-density version of the
 *  tasks page's error card, so a failed fetch never masquerades as empty. */
function InlineErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    // role="alert": these replace a section's contents when a fetch fails, so
    // without it the section just reads as empty to a screen reader.
    <div
      role="alert"
      className="mx-0.5 my-1 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12.5px] text-destructive"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        // coarse: pad the ~20px target out to 44px without changing the row's
        // density on pointer devices (negative margins absorb the extra box).
        className="pressable flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium transition-colors duration-fast hover:bg-destructive/10 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
      </button>
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
  // Icon micro-motion is carried by the icon itself (group-hover:scale-110 at
  // the call sites), matching the expanded rows — the button only presses.
  const cls = cn(
    "group flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast ease-out-soft active:scale-95",
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
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-muted-foreground/80 transition-transform duration-fast group-hover:scale-110 group-hover:text-foreground">{icon}</span>
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
  icon: Icon,
  children,
  collapsible,
  isCollapsed,
  onToggleCollapse,
  action,
}: {
  label: string;
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

/** A Code-mode workspace (project folder) with its sessions and any remote
 *  tasks nested under a real disclosure. */
function CodeWorkspaceGroup({
  name,
  sessions,
  tasks,
  taskStatusFor,
  expanded,
  onToggle,
  activeConversationId,
  activePath,
  renamingId,
  setRenaming,
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
}: {
  name: string;
  sessions: ClientConversation[];
  tasks: CodeTaskRow[];
  /** Latest relevant remote-task status for a session id (row status dot). */
  taskStatusFor: (id: string) => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  activeConversationId: string | null;
  activePath: string;
  renamingId: string | null;
  setRenaming: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[14px] font-medium text-sidebar-foreground/90 transition-all duration-fast ease-out-soft hover:translate-x-0.5 hover:bg-sidebar-accent hover:text-foreground"
      >
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-muted-foreground/70 transition-transform duration-fast group-hover:scale-110">
          <Folder className="h-[16px] w-[16px]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-fast ease-out-soft",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {sessions.length === 0 && tasks.length === 0 && (
            <p className="py-1 pl-6 pr-2 text-[12.5px] leading-5 text-muted-foreground">No sessions yet.</p>
          )}
          {sessions.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              variant="code"
              nested
              taskStatus={taskStatusFor(c.id)}
              active={c.id === activeConversationId || activePath === `/chat/${c.id}`}
              renaming={renamingId === c.id}
              setRenaming={setRenaming}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onNavigate={onNavigate}
              onRequestConfirm={onRequestConfirm}
            />
          ))}
          {tasks.map((t) => (
            <CodeTaskStatusRow key={t.id} task={t} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

const TASK_STATUS_META: Record<string, { label: string; dot: string }> = {
  queued: { label: "Queued", dot: "bg-muted-foreground/50" },
  running: { label: "Running", dot: "bg-success motion-safe:animate-pulse" },
  awaiting_approval: { label: "Approval", dot: "bg-warning" },
  failed: { label: "Failed", dot: "bg-destructive" },
};

/** A remote Juno Code task shown standalone (its session row, if any, isn't in
 *  the list). Linked tasks deep-link to their session; app-started tasks have
 *  no session to open, so their row stays a plain, non-interactive readout —
 *  a row that went nowhere would be a dead button. */
function CodeTaskStatusRow({ task, onNavigate }: { task: CodeTaskRow; onNavigate?: () => void }) {
  const meta = TASK_STATUS_META[task.status];
  if (!meta) return null;
  const inner = (
    <>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {meta.label}
      </span>
    </>
  );
  if (task.conversationId) {
    return (
      <Link
        href={`/chat/${task.conversationId}`}
        onClick={onNavigate}
        title={task.title}
        className="flex items-center gap-2 rounded-md py-1 pl-6 pr-2 text-[12.5px] text-sidebar-foreground/70 transition-all duration-fast ease-out-soft hover:translate-x-0.5 hover:bg-sidebar-accent hover:text-foreground"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md py-1 pl-6 pr-2 text-[12.5px] text-sidebar-foreground/70" title={task.title}>
      {inner}
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  renaming,
  setRenaming,
  projects = [],
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
  variant = "chat",
  nested,
  taskStatus,
}: {
  conversation: ClientConversation;
  active: boolean;
  renaming: boolean;
  setRenaming: (id: string | null) => void;
  /** Only read by the "chat" variant's "Add to project" submenu. */
  projects?: { id: string; name: string }[];
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
  /** "code" trims the menu to session actions (no project/folder moves). */
  variant?: "chat" | "code";
  /** Indented under a parent row (Code workspace groups). */
  nested?: boolean;
  /** Latest remote-task status for this session — rendered as a status dot. */
  taskStatus?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState(conversation.title);

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

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(null);
    if (title && title !== conversation.title) patch({ title });
  };

  const remove = () => {
    onRequestConfirm({
      title: variant === "code" ? "Delete this session?" : "Delete this conversation?",
      description: "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: variant === "code" ? "Delete session" : "Delete chat",
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
      <div className={cn("flex items-center gap-1 pl-2 pr-1 py-1", nested && "pl-6")}>
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
        nested && "pl-6",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 font-medium text-sidebar-foreground/90 hover:text-foreground",
          nested ? "text-[13px]" : "text-[14px]",
          active && "font-semibold text-foreground"
        )}
        title={conversation.title}
      >
        {/* Claude-style: every chat carries the same speech-bubble mark. */}
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-muted-foreground/60 transition-[color,transform] duration-fast group-hover:scale-110 group-hover:text-foreground">
          <MessageCircle className={nested ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"} />
        </span>
        <AnimatedTitle title={conversation.title || (variant === "code" ? "New session" : "New chat")} className="min-w-0 flex-1" />
        {taskStatus && TASK_STATUS_META[taskStatus] && (
          <span className="flex shrink-0 items-center pl-1" title={TASK_STATUS_META[taskStatus].label}>
            <span className={cn("h-1.5 w-1.5 rounded-full", TASK_STATUS_META[taskStatus].dot)} aria-hidden="true" />
            <span className="sr-only">{TASK_STATUS_META[taskStatus].label}</span>
          </span>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="pressable group/kebab rounded-sm p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:p-1.5 coarse:opacity-100"
            aria-label={variant === "code" ? "Session options" : "Conversation options"}
          >
            <MoreVertical className="h-4 w-4 transition-transform duration-fast group-hover/kebab:scale-110" />
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
          {variant === "chat" && (
            <>
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
            </>
          )}
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
      <Link
        href={`/projects/${project.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          // flex-1 so the link fills the row it paints hover across: a
          // content-width link next to a flex-1 spacer left the middle of the
          // row looking clickable but doing nothing (as ConversationRow does).
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-[14px] font-medium text-sidebar-foreground/90 hover:text-foreground",
          active && "font-semibold text-foreground"
        )}
        title={project.name}
      >
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-muted-foreground/80 transition-transform duration-fast group-hover:scale-110 group-hover:text-foreground">
          <Box className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 truncate">{project.name}</span>
      </Link>
      {/* Disclosure ›, rotating open. Sits with the kebab at the row's trailing
          edge: the project link owns the whole span it paints hover across. */}
      {hasChats && (
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => !v);
            if (expanded) setShowAll(false);
          }}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          aria-expanded={expanded}
          // 20px is well under the 44px touch minimum — widen on coarse
          // pointers only, with negative margins so row height is unchanged.
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground coarse:-my-3 coarse:h-11 coarse:w-11"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-fast ease-out-soft", expanded && "rotate-90")} />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="pressable group/kebab rounded-sm p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:p-1.5 coarse:opacity-100"
            aria-label="Project options"
          >
            <MoreVertical className="h-4 w-4 transition-transform duration-fast group-hover/kebab:scale-110" />
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
            <MessageCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-[color,transform] duration-fast group-hover/pc:scale-110 group-hover/pc:text-foreground" />
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
