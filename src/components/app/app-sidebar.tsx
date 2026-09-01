"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, Pin } from "lucide-react";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { usePathname } from "next/navigation";
import { DownloadMenu } from "@/components/app/download-menu";
import { UserMenu } from "@/components/app/user-menu";
import { SidebarMotionIcon } from "@/components/app/sidebar-motion-icon";
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
import { Pressable, pressableVariants } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useApp } from "@/components/app/app-provider";
import { CODE_SYNC_EVENT } from "@/hooks/use-code-session";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkSessions,
} from "@/components/work/work-transport";
import { WorkStatusDot } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import type { ClientWorkSession } from "@/lib/work/serializers";
import type { ClientConversation } from "@/types/chat";
import { staggerDelay } from "@/lib/motion";

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
} | null;

/** The product mode the whole sidebar is threaded through.
 *
 *  Design is deliberately not one of these. A mode owns the whole sidebar —
 *  its own nav rows, its own list, its own rail — and Design never had any of
 *  that, so being the fourth segment only ever meant "route away and leave
 *  Home's sidebar standing". It is a destination, and it lives in the footer
 *  next to the account row where a destination belongs. */
/**
 * The sidebar has exactly two row scales, and every row is one of them.
 *
 *   L1  rounded-control · px-2.5 py-1.5 · text-sm · font-medium
 *       Destinations and section toggles — things that own a list.
 *   L2  rounded-xs      · pl-6|pl-9 pr-2 py-1 · text-ui
 *       Items inside one — a chat under a project, a run under a task.
 *
 * L2 was `rounded-md`, which is Tailwind's generic 8px step and the one rung in
 * this panel that is not on the product's radius ladder (…xs 6 · control 9 ·
 * field 10 · menu 12…). 6px is the rung below L1's 9, so the two tiers still
 * step, and the column stops carrying a radius no other surface can name.
 *
 * L2's size was `text-[12.5px]` — nine restatements of the half-pixel value
 * `text-ui` exists to retire (tailwind.config.ts: no 1x display can honour the
 * .5, and nobody chose it). The token is the same rung to the eye and the one
 * every other dense list in the product reads at, so the sidebar stops carrying
 * a private size. L1's `text-[14px]` is `text-sm` under an arbitrary alias.
 *
 * The indent (pl-6 vs pl-9) is the only thing that varies within L2, and it
 * encodes real nesting depth rather than taste.
 *
 * Three rows had drifted off this when it was written down: the Work session
 * row carried px-2 where every other L1 has px-2.5, the project-chat row used
 * L1's radius at L2's size, and "View all" was the single text-[12px] in a
 * 12.5px tier. None of the three was visible on its own, which is exactly how a
 * panel ends up feeling unconsidered — no one row looks wrong and the column
 * does.
 */
type SidebarMode = "home" | "work" | "code" | "projects";

/** Landing route per mode — what switching the toggle actually navigates to. */
const MODE_HOME: Record<SidebarMode, string> = {
  home: "/chat",
  work: "/work",
  code: "/code/new",
  projects: "/projects",
};

type SidebarProject = {
  id: string;
  name: string;
  nameSource?: "default" | "ai" | "manual";
  starred: boolean;
  updatedAt: string;
  conversationCount: number;
  fileCount?: number;
  coverUrl?: string | null;
};

/** `key` is the stable server-synced workspace identity (nullable for rows
 *  mirrored by pre-key clients); `path` is device metadata. */
type CodeWorkspace = {
  id: string;
  name: string;
  path: string;
  key?: string | null;
  lastOpenedAt: string;
};

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
const ACTIVE_TASK_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_approval",
]);

/**
 * The row kebab, once.
 *
 * ConversationRow and ProjectRow had this recipe copy-pasted verbatim, and both
 * copies lifted on `hover:bg-background` — which worked while the sidebar was a
 * warm tint over a paper page. On the dark theme `--background` and `--sidebar`
 * are both pure black, so the hover fill became byte-identical to the panel
 * behind it while the parent row was simultaneously painting `bg-sidebar-accent`
 * at 11%: the kebab read as a black hole punched into the hovered row instead of
 * a control lifting out of it. `--sidebar-accent` is the panel's own elevated
 * rung and rises in both themes.
 *
 * A circle rather than the old rounded-xs. That value existed to stop the
 * button's corner poking past the row's own rounded-control at 4px of padding —
 * a circle has no corner, so it satisfies the same constraint strictly, and it
 * puts the kebab in the one shape every other bare glyph in the product uses.
 *
 * `coarse:opacity-100` is not polish. Reveal-on-hover was the ONLY way this
 * control appeared, and a touch device never hovers: on a phone — where the
 * sidebar is the drawer and this is the only route to rename, pin, move or
 * delete a chat — the kebab was permanently invisible, and the 44px hit area
 * beside it was hitting nothing anyone could see. It stays a hover reveal on a
 * fine pointer, where the row is quieter for it.
 */
const KEBAB_CLASS =
  "group/kebab size-7 shrink-0 opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-sidebar-accent data-[state=open]:opacity-100 coarse:size-11 coarse:opacity-100";

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
  // Home shows web + app chats; Work shows Juno Work tasks (their own model,
  // not conversations); Code shows Juno Code sessions synced from the app
  // (conversations with kind "code"). Persisted like the collapse prefs.
  const [mode, setMode] = React.useState<SidebarMode>("home");

  /**
   * Work mode follows the ROUTE, because it is no longer a segment anyone can
   * click here — it moved to the Chat/Work slider above the composer.
   *
   * Scoped to `/work` on purpose. The other two modes stay user-chosen and
   * persisted: making all three route-derived would mean landing on /settings
   * or /projects (which match nothing) silently kept whatever mode was last
   * set, while /chat would forcibly overrule a restored `code` preference on
   * every cold load. One new rule, for the one mode that gained a new door.
   */
  React.useEffect(() => {
    if (!pathname) return;
    if (pathname.startsWith("/work")) setMode("work");
    else if (pathname.startsWith("/code")) setMode("code");
    else if (pathname.startsWith("/projects")) setMode("projects");
    else if (pathname.startsWith("/chat") || pathname === "/") setMode("home");
  }, [pathname]);

  // Work mode data: the user's Work tasks, polled like the Code lists below.
  const [workSessions, setWorkSessions] = React.useState<ClientWorkSession[]>(
    [],
  );
  const [workLoaded, setWorkLoaded] = React.useState(false);
  const [workError, setWorkError] = React.useState(false);
  // Code mode data: the app's workspaces (project folders) mirrored from
  // /api/code/workspaces, and remote code tasks for status rows.
  const [codeWorkspaces, setCodeWorkspaces] = React.useState<CodeWorkspace[]>(
    [],
  );
  const [codeTasks, setCodeTasks] = React.useState<CodeTaskRow[]>([]);
  const [codeLoaded, setCodeLoaded] = React.useState(false);
  const [codeError, setCodeError] = React.useState(false);
  // Per-workspace disclosure, persisted; unlisted paths default to open.
  const [codeExpanded, setCodeExpanded] = React.useState<
    Record<string, boolean>
  >({});
  const [renameTarget, setRenameTarget] = React.useState<SidebarProject | null>(
    null,
  );
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
      const nextProjects: SidebarProject[] = Array.isArray(data.projects)
        ? data.projects
        : [];
      if (!migratedLegacyStars.current) {
        migratedLegacyStars.current = true;
        try {
          const raw = JSON.parse(
            localStorage.getItem(LEGACY_STARRED_KEY) || "[]",
          );
          const legacy: string[] = Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === "string")
            : [];
          if (legacy.length > 0) {
            const toStar = nextProjects.filter(
              (p) => legacy.includes(p.id) && !p.starred,
            );
            const results = await Promise.all(
              toStar.map((p) =>
                fetch(`/api/projects/${p.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ starred: true }),
                })
                  .then((r) => r.ok)
                  .catch(() => false),
              ),
            );
            toStar.forEach((p, i) => {
              if (results[i]) p.starred = true;
            });
            // Only drop the legacy key once every star made it to the server.
            if (results.every(Boolean))
              localStorage.removeItem(LEGACY_STARRED_KEY);
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
      if (modePref === "code" || modePref === "work") setMode(modePref);
      const expanded = JSON.parse(
        localStorage.getItem(CODE_EXPANDED_KEY) || "{}",
      );
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
      localStorage.setItem(
        "juno:sidebar:starred:collapsed",
        JSON.stringify(next),
      );
    } catch {}
  };

  const toggleRecentsCollapsed = () => {
    const next = !recentsCollapsed;
    setRecentsCollapsed(next);
    try {
      localStorage.setItem(
        "juno:sidebar:recents:collapsed",
        JSON.stringify(next),
      );
    } catch {}
  };

  // Only starred projects appear in the sidebar, most-recently-updated first.
  const sidebarProjects = React.useMemo(() => {
    return [...projects]
      .filter((p) => p.starred)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  }, [projects]);

  const toggleProjectStar = async (project: SidebarProject) => {
    const next = !project.starred;
    setProjects((prev) =>
      prev.map((p) => (p.id === project.id ? { ...p, starred: next } : p)),
    );
    const r = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)),
      );
      toast.error("Could not update the project.");
      return;
    }
    toast.success(next ? "Project pinned!" : "Project unpinned.");
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
        const r = await fetch(`/api/projects/${project.id}`, {
          method: "DELETE",
        });
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

  const switchMode = React.useCallback(
    (next: SidebarMode) => {
      setMode(next);
      try {
        localStorage.setItem("juno:sidebar:mode", next);
      } catch {}
      // Switching the toggle should change the MAIN view too, not just the
      // sidebar — otherwise the composer only updates after a separate New
      // chat / New session click. Land on the mode's home composer directly.
      router.push(MODE_HOME[next]);
      if (next === "home") {
        // A no-op push when already on /chat won't remount, so also reset any
        // stale chat state (mirrors newChat()).
        window.dispatchEvent(new CustomEvent("juno:new-chat"));
      }
      setSidebarOpen(false);
    },
    [router, setSidebarOpen],
  );

  const filtered = React.useMemo(() => {
    // Home shows every web/app chat; Code shows the synced Juno Code sessions.
    // Grouping now lives in Projects, so there's no folder scoping here.
    //
    // Work is deliberately absent: a Work task is a WorkSession, not a
    // Conversation, so there is no `kind` to filter on and nothing here to
    // show. Giving Work a conversation kind purely to reuse this list would
    // put every Work task into the chat sidebar of anyone on an older client.
    if (mode === "work" || mode === "projects") return [];
    return conversations.filter((c) =>
      mode === "code" ? c.kind === "code" : c.kind !== "code",
    );
  }, [conversations, mode]);

  const loadWork = React.useCallback(async () => {
    const result = await fetchWorkSessions(30);
    if (result.kind !== "ok") {
      setWorkError(true);
      return;
    }
    setWorkError(false);
    setWorkSessions(result.value);
    setWorkLoaded(true);
  }, []);

  // The same interval + visibility + event trio the Code lists use, and for the
  // same reason: the sidebar mounts once in the persistent shell, so a task that
  // starts running (or stops to ask a question) would otherwise keep the status
  // it had when the mode was first opened.
  React.useEffect(() => {
    if (mode !== "work") return;
    void loadWork();
    const tick = () => {
      if (!document.hidden) void loadWork();
    };
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [mode, loadWork]);

  const workAttention = React.useMemo(
    () => workSessions.filter((session) => session.needsAttention),
    [workSessions],
  );
  const workRecent = React.useMemo(
    () =>
      workSessions.filter(
        (session) => !session.needsAttention && !session.archived,
      ),
    [workSessions],
  );

  const loadCode = React.useCallback(async () => {
    setCodeError(false);
    try {
      const [w, t] = await Promise.all([
        fetch("/api/code/workspaces"),
        fetch("/api/code/tasks?limit=100"),
      ]);
      if (!w.ok || !t.ok) throw new Error();
      const wd = await w.json();
      const td = await t.json();
      setCodeWorkspaces(Array.isArray(wd.workspaces) ? wd.workspaces : []);
      setCodeTasks(
        (Array.isArray(td.tasks) ? td.tasks : []).map(
          (x: Record<string, unknown>): CodeTaskRow => ({
            id: String(x.id ?? ""),
            conversationId:
              typeof x.conversationId === "string" && x.conversationId
                ? x.conversationId
                : null,
            workspacePath: String(x.workspacePath ?? ""),
            workspaceName: String(x.workspaceName ?? ""),
            workspaceKey:
              typeof x.workspaceKey === "string" && x.workspaceKey
                ? x.workspaceKey
                : null,
            title: String(x.title ?? ""),
            status: String(x.status ?? ""),
            createdAt: String(x.createdAt ?? ""),
          }),
        ),
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
      return [] as {
        id: string;
        key: string | null;
        name: string;
        path: string;
        sessions: ClientConversation[];
      }[];
    const sessionsFor = (w: {
      key: string | null;
      name: string;
      path: string;
    }) =>
      filtered.filter((c) => {
        // Both sides keyed → identity decides, path/name are just metadata.
        if (c.codeWorkspaceKey && w.key) return c.codeWorkspaceKey === w.key;
        return (
          c.codeWorkspacePath === w.path ||
          (!c.codeWorkspacePath && c.codeWorkspaceName?.trim() === w.name)
        );
      });
    const projects = codeWorkspaces.map((w) => {
      const key = w.key ?? null;
      return {
        id: key ?? w.path,
        key,
        name: w.name,
        path: w.path,
        sessions: sessionsFor({ key, name: w.name, path: w.path }),
      };
    });
    // Sessions naming a workspace the mirror doesn't know yet still group.
    const knownKeys = new Set(
      projects.map((p) => p.key).filter((k): k is string => k != null),
    );
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
      ...[...orphans.entries()].map(([name, sessions]) => ({
        id: name,
        key: null,
        name,
        path: name,
        sessions,
      })),
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
  const codeSessionIds = React.useMemo(
    () => new Set(filtered.map((c) => c.id)),
    [filtered],
  );

  // The latest still-relevant task per linked session, for the row status dots.
  const taskByConversation = React.useMemo(() => {
    const map = new Map<string, CodeTaskRow>();
    const now = Date.now();
    for (const t of codeTasks) {
      if (!t.conversationId) continue;
      const relevant =
        ACTIVE_TASK_STATUSES.has(t.status) ||
        (t.status === "failed" &&
          now - new Date(t.createdAt).getTime() < FAILED_TASK_TTL_MS);
      if (!relevant) continue;
      const existing = map.get(t.conversationId);
      if (
        !existing ||
        new Date(t.createdAt).getTime() > new Date(existing.createdAt).getTime()
      ) {
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
        (t.status === "failed" &&
          now - new Date(t.createdAt).getTime() < FAILED_TASK_TTL_MS);
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
    () =>
      filtered.filter(
        (c) => c.pinned && !(mode === "code" && groupedSessionIds.has(c.id)),
      ),
    [filtered, mode, groupedSessionIds],
  );
  const recents = React.useMemo(
    () =>
      filtered.filter(
        (c) => !c.pinned && !(mode === "code" && groupedSessionIds.has(c.id)),
      ),
    [filtered, mode, groupedSessionIds],
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

  const newWorkTask = () => {
    router.push("/work");
    setSidebarOpen(false);
  };

  // Collapsed icon rail (desktop only). Fixed width + keyed fade-in so the
  // content doesn't reflow while the shell animates the aside's width, and the
  // layout swap reads as a cross-fade instead of a pop.
  if (collapsed) {
    return (
      <div
        key="rail"
        className="flex h-full w-[64px] flex-col items-center py-3 text-sidebar-foreground motion-safe:animate-fade-in"
      >
        {/* A real Tooltip, not the native `title` the rail used to lean on: the
            OS bubble ignores the provider's 200ms delay and the popper's motion
            pair, so the rail's labels appeared on a different clock from every
            other hover hint in the product. `side="right"` for the whole rail —
            a label has no room over a 64px column and belongs beside it. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Pressable
              kind="icon"
              size="lg"
              onClick={onToggleCollapse}
              aria-label="Expand sidebar"
              // hover:text-foreground, like every RailIcon directly beneath it. This
              // one resolved its hover to the colour it already had, so the top
              // control in the rail was the only one whose glyph did not answer.
              className="group text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <SidebarMotionIcon kind="panel-open" />
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="right">Expand sidebar</TooltipContent>
        </Tooltip>
        <div className="mt-3">
          <ModeToggle mode={mode} onChange={switchMode} compact />
        </div>
        <div className="mt-3 flex flex-col items-center gap-1">
          {mode === "work" ? (
            <>
              <RailIcon onClick={newWorkTask} label="New task">
                <span className="flex size-7 items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="size-4" />
                </span>
              </RailIcon>
              <RailIcon
                href="/tasks"
                active={pathname === "/tasks"}
                label="Scheduled"
              >
                <SidebarMotionIcon kind="tasks" />
              </RailIcon>
              <RailIcon
                href="/connections"
                active={pathname === "/connections"}
                label="Connected apps"
              >
                <SidebarMotionIcon kind="connections" />
              </RailIcon>
            </>
          ) : mode === "code" ? (
            <>
              <RailIcon onClick={newCodeSession} label="New session">
                <span className="flex size-7 items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="size-4" />
                </span>
              </RailIcon>
              <RailIcon href="/code" active={pathname === "/code"} label="Runs">
                <SidebarMotionIcon kind="code" />
              </RailIcon>
              <RailIcon
                href="/code/pulls"
                active={pathname === "/code/pulls"}
                label="Pull requests"
              >
                <SidebarMotionIcon kind="pulls" />
              </RailIcon>
            </>
          ) : mode === "projects" ? (
            <>
              <RailIcon onClick={() => router.push("/projects")} label="New project">
                <span className="flex size-7 items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="size-4" />
                </span>
              </RailIcon>
              <RailIcon
                href="/projects"
                active={pathname === "/projects"}
                label="All projects"
              >
                <SidebarMotionIcon kind="projects" />
              </RailIcon>
            </>
          ) : (
            <>
              <RailIcon onClick={newChat} label="New chat">
                <span className="flex size-7 items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="size-4" />
                </span>
              </RailIcon>
              <RailIcon
                href="/assistants"
                active={pathname === "/assistants"}
                label="Assistants"
              >
                <SidebarMotionIcon kind="assistants" />
              </RailIcon>
            </>
          )}
          <RailIcon
            onClick={() => window.dispatchEvent(new CustomEvent("juno:search"))}
            label="Search chats and projects"
          >
            <SidebarMotionIcon kind="search" />
          </RailIcon>
        </div>
        {/* Mirrors the expanded footer: Design sits at the bottom corner in
            both layouts, so the rail and the full sidebar agree about where
            the door is. */}
        <div className="mt-auto flex flex-col items-center gap-1">
          <RailIcon
            href="/design"
            active={pathname === "/design"}
            label="Design"
          >
            <SidebarMotionIcon kind="design" />
          </RailIcon>
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    // Desktop width rides the shell's --juno-sidebar-width (user-resizable);
    // keeping it on the inner column preserves the collapse clip-reveal.
    //
    // No `bg-sidebar` here, and that is not a tidy-up. This column has two
    // hosts: the desktop <aside>, which already paints --sidebar, and the mobile
    // Sheet, which paints --popover so a drawer floating over the page reads as
    // ABOVE it. Filling the column with --sidebar covered the second one edge to
    // edge — and on dark --sidebar is #000, so the drawer became a black panel
    // over a black page under a black scrim, which is exactly the failure
    // SheetContent's own comment says it moved to --popover to avoid. The fill
    // belongs to whichever frame is hosting the panel.
    <div
      key="expanded"
      className="flex size-full flex-col text-sidebar-foreground motion-safe:animate-fade-in md:w-[var(--juno-sidebar-width,280px)]"
    >
      {/* pb-2 (+ the nav's pt-1) = 12px to the first row. This was pb-7, which
          left a ~32px void between the wordmark and "New chat" and read as a
          layout gap rather than a deliberate break. */}
      <div className="flex items-center justify-between px-3 pb-2 pt-3.5">
        {/* No `outline-none` + hand-rolled ring. The global `:focus-visible` rule
            in globals.css is the authoritative focus treatment (see the note at
            the top of button.tsx, where four forked ring-offset colours had to be
            unpicked); switching the outline off here bought a ring that draws in
            the accent, which is reserved for actions and status. */}
        <Link
          href="/chat"
          onClick={() => setSidebarOpen(false)}
          className="group/brand rounded-control"
        >
          <span className="flex items-center gap-2 pl-1">
            <JunoMark className="h-[21px] w-[21px]" />
            {/* Off the type scale on purpose: this is the logotype, not a
                heading — the same exemption AsciiWordmark's tracking carries.
                Snapping it to `title` (22px) would alter the brand mark to
                satisfy a ladder built for interface text. */}
            <span className="font-sans text-lg font-semibold tracking-[-0.02em] text-foreground">
              Juno
            </span>
          </span>
        </Link>
        {/* Every bare glyph in this panel carries a Tooltip on the shared
            200ms provider clock. `side="bottom"` along this top edge — a
            top-placed label here would collide with the viewport and flip
            per-button, so the row states the direction once instead. */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="group"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("juno:search"))
                }
                aria-label="Search chats and projects"
              >
                <SidebarMotionIcon kind="search" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search</TooltipContent>
          </Tooltip>
          {onToggleCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="group hidden md:inline-flex"
                  onClick={onToggleCollapse}
                  aria-label="Collapse sidebar"
                >
                  <SidebarMotionIcon kind="panel-close" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse sidebar</TooltipContent>
            </Tooltip>
          )}
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
        </div>
      </div>

      {/* Home / Code — the same two surfaces as the Juno app. Code lists the
          Juno Code sessions synced from the Mac app. */}
      <div className="px-3 pb-2 pt-1">
        <ModeToggle mode={mode} onChange={switchMode} />
      </div>

      {/* Primary destinations for the active mode */}
      <nav className="space-y-0.5 px-2 pt-1">
        {mode === "work" ? (
          <>
            <NavRow
              onClick={newWorkTask}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="h-[17px] w-[17px]" />
                </span>
              }
              label="New task"
            />
            <NavRow
              href="/tasks"
              active={pathname === "/tasks"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="tasks" />}
              label="Scheduled"
            />
            <NavRow
              href="/connections"
              active={pathname === "/connections"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="connections" />}
              label="Connected apps"
            />
          </>
        ) : mode === "code" ? (
          <>
            <NavRow
              onClick={newCodeSession}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="h-[17px] w-[17px]" />
                </span>
              }
              label="New session"
            />
            <NavRow
              href="/code"
              active={pathname === "/code"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="code" />}
              label="Runs"
            />
            <NavRow
              href="/code/pulls"
              active={pathname === "/code/pulls"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="pulls" />}
              label="Pull requests"
            />
          </>
        ) : mode === "projects" ? (
          <>
            <NavRow
              onClick={() => {
                router.push("/projects");
                setSidebarOpen(false);
              }}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="h-[17px] w-[17px]" />
                </span>
              }
              label="New project"
            />
            <NavRow
              href="/projects"
              active={pathname === "/projects"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="projects" />}
              label="All projects"
            />
          </>
        ) : (
          <>
            <NavRow
              onClick={newChat}
              icon={
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-control bg-muted-foreground/10 text-foreground transition-colors duration-fast ease-out-soft group-hover:bg-muted-foreground/15">
                  <SidebarMotionIcon kind="new" className="h-[17px] w-[17px]" />
                </span>
              }
              label="New chat"
            />
            <NavRow
              href="/assistants"
              active={pathname === "/assistants"}
              onClick={() => setSidebarOpen(false)}
              icon={<SidebarMotionIcon kind="assistants" />}
              label="Assistants"
            />
          </>
        )}
      </nav>

      <div className="pt-2" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!mounted ? (
          <div className="space-y-1 px-1 pt-1">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="skeleton h-8 rounded-control"
                style={staggerDelay(i, "tight")}
              />
            ))}
          </div>
        ) : mode === "work" ? (
          <>
            {workError && (
              <InlineErrorRow
                message="Couldn’t load your Work tasks."
                onRetry={loadWork}
              />
            )}
            {!workLoaded && !workError ? (
              <div className="space-y-1 px-1 pt-1">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="skeleton h-8 rounded-control"
                    style={staggerDelay(i, "tight")}
                  />
                ))}
              </div>
            ) : (
              <>
                {/* Attention first and always disclosed. A task that has stopped
                    to ask something is the one row a user must not have to go
                    looking for, so this section is never collapsible. */}
                {workAttention.length > 0 && (
                  <Section label="Needs you">
                    {workAttention.map((session) => (
                      <WorkSessionRow
                        key={session.id}
                        session={session}
                        active={pathname === `/work/${session.id}`}
                        onNavigate={() => setSidebarOpen(false)}
                      />
                    ))}
                  </Section>
                )}
                {workRecent.length > 0 ? (
                  <Section
                    label="Tasks"
                    collapsible
                    isCollapsed={recentsCollapsed}
                    onToggleCollapse={toggleRecentsCollapsed}
                  >
                    <div className="mt-1 space-y-0.5">
                      {workRecent.map((session) => (
                        <WorkSessionRow
                          key={session.id}
                          session={session}
                          active={pathname === `/work/${session.id}`}
                          onNavigate={() => setSidebarOpen(false)}
                        />
                      ))}
                    </div>
                  </Section>
                ) : (
                  workAttention.length === 0 &&
                  !workError && (
                    <p
                      className="px-3 py-8 text-center text-sm text-muted-foreground"
                      aria-live="polite"
                    >
                      No tasks yet.
                      <br />
                      Start one above.
                    </p>
                  )
                )}
              </>
            )}
          </>
        ) : mode === "code" ? (
          <>
            {/* Projects always renders in Code mode — a mirror with zero
                sessions still has workspaces worth showing (commit 4364b90). */}
            <Section label="Projects">
              {codeError ? (
                <InlineErrorRow
                  message="Couldn’t load your Code projects."
                  onRetry={loadCode}
                />
              ) : !codeLoaded ? (
                <div className="space-y-1 px-1 pt-1">
                  {[...Array(3)].map((_, i) => (
                    <div
                      key={i}
                      className="skeleton h-8 rounded-control"
                      style={staggerDelay(i, "tight")}
                    />
                  ))}
                </div>
              ) : codeProjects.length === 0 ? (
                <p className="px-2.5 py-1 text-ui text-muted-foreground">
                  Your Juno Code projects appear here once the app syncs them.
                </p>
              ) : (
                codeProjects.map((p) => (
                  <CodeWorkspaceGroup
                    key={p.id}
                    name={p.name}
                    sessions={p.sessions}
                    tasks={
                      (p.key
                        ? codeTasksByWorkspace.byKey.get(p.key)
                        : undefined) ??
                      codeTasksByWorkspace.byPath.get(p.path) ??
                      codeTasksByWorkspace.byName.get(p.name) ??
                      []
                    }
                    taskStatusFor={(id) => taskByConversation.get(id)?.status}
                    // Legacy prefs were keyed by path; fall back so an upgrade
                    // (path → key ids) doesn't reset anyone's disclosure state.
                    expanded={
                      codeExpanded[p.id] ?? codeExpanded[p.path] ?? true
                    }
                    onToggle={() =>
                      toggleWorkspaceExpanded(
                        p.id,
                        codeExpanded[p.id] ?? codeExpanded[p.path] ?? true,
                      )
                    }
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
            {projectsError && (
              <InlineErrorRow
                message="Couldn’t load your projects."
                onRetry={loadProjects}
              />
            )}
            <p
              className="px-3 py-8 text-center text-sm text-muted-foreground"
              aria-live="polite"
            >
              No conversations yet.
              <br />
              Start one above.
            </p>
          </>
        ) : mode === "projects" ? (
          <>
            {projectsError && (
              <InlineErrorRow
                message="Couldn’t load your projects."
                onRetry={loadProjects}
              />
            )}
            {!projectsError && (
              <>
                {sidebarProjects.length > 0 && (
                  <Section
                    label="Pinned"
                    collapsible
                    isCollapsed={starredCollapsed}
                    onToggleCollapse={toggleStarredCollapsed}
                  >
                    <div className="mt-1 space-y-0.5">
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
                    </div>
                  </Section>
                )}
                <Section
                  label="All projects"
                  collapsible
                  isCollapsed={recentsCollapsed}
                  onToggleCollapse={toggleRecentsCollapsed}
                >
                  <div className="mt-1 space-y-0.5">
                    {projects.length > 0 ? (
                      projects.map((p) => (
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
                      ))
                    ) : (
                      <p className="px-3 py-6 text-center text-caption text-muted-foreground">
                        No projects yet.
                        <br />
                        Create one above.
                      </p>
                    )}
                  </div>
                </Section>
              </>
            )}
          </>
        ) : (
          <>
            {projectsError && (
              <InlineErrorRow
                message="Couldn’t load your projects."
                onRetry={loadProjects}
              />
            )}
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

      {/* Secondary Resources & Destinations: Library, Artifacts, Connections, Design */}
      <div className="space-y-0.5 px-2 pb-1 border-t border-sidebar-border/60 pt-1.5">
        <div className="grid grid-cols-2 gap-1">
          <NavRow
            href="/library"
            active={pathname === "/library"}
            onClick={() => setSidebarOpen(false)}
            icon={<SidebarMotionIcon kind="library" />}
            label="Library"
            className="text-caption py-1 pl-2"
          />
          <NavRow
            href="/artifacts"
            active={pathname === "/artifacts"}
            onClick={() => setSidebarOpen(false)}
            icon={<SidebarMotionIcon kind="artifacts" />}
            label="Artifacts"
            className="text-caption py-1 pl-2"
          />
          <NavRow
            href="/connections"
            active={pathname === "/connections"}
            onClick={() => setSidebarOpen(false)}
            icon={<SidebarMotionIcon kind="connections" />}
            label="Connectors"
            className="text-caption py-1 pl-2"
          />
          <NavRow
            href="/design"
            active={pathname === "/design"}
            onClick={() => setSidebarOpen(false)}
            icon={<SidebarMotionIcon kind="design" />}
            label="Design"
            className="text-caption py-1 pl-2"
          />
        </div>
      </div>

      {/* The account row and, beside it, the way to get the app. A separate
          control rather than a row inside the account menu: downloading Juno is
          not an account setting, and a person looking for it is looking at the
          bottom-left corner where every app puts "get the desktop version". */}
      <div className="flex items-center gap-1 border-t border-sidebar-border p-2">
        <div className="min-w-0 flex-1">
          <UserMenu />
        </div>
        <DownloadMenu />
      </div>

      {/* Confirm dialog (replaces window.confirm) */}
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

      {/* Project rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(o) => !o && setRenameTarget(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              Change the name of this project.
            </DialogDescription>
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
            <Button
              onClick={renameProject}
              disabled={renamingProject || !renameDraft.trim()}
            >
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
 *  vertically (icon-only) in the collapsed rail.
 *
 *  Work is deliberately NOT a third segment. It is not a third product — it is
 *  the same assistant doing something on your behalf instead of answering you,
 *  so it belongs beside Chat, not beside Code. It now lives in the Chat/Work
 *  slider above the composer (`ChatWorkSwitcher`), which also gives it a place
 *  where the choice is visible while you are making it, rather than in a
 *  sidebar that is collapsed half the time.
 *
 *  Two consequences worth knowing. The sidebar still HAS a work mode — it swaps
 *  its list — but it now reads that from the route rather than from this
 *  toggle. And at 240px the labels get their padding back, because two segments
 *  fit where three had to be squeezed to `px-2`. */
function ModeToggle({
  mode,
  onChange,
  compact,
}: {
  mode: SidebarMode;
  onChange: (mode: SidebarMode) => void;
  compact?: boolean;
}) {
  return (
    <SegmentedControl<SidebarMode>
      value={mode}
      onChange={onChange}
      ariaLabel="Product mode"
      orientation={compact ? "vertical" : "horizontal"}
      labelHidden={compact}
      optionClassName={compact ? undefined : "gap-1 px-1.5 py-1 text-caption"}
      options={[
        {
          value: "home",
          label: "Chat",
          icon: <SidebarMotionIcon kind="home" className="size-3.5" />,
        },
        {
          value: "work",
          label: "Work",
          icon: <SidebarMotionIcon kind="work" className="size-3.5" />,
        },
        {
          value: "code",
          label: "Code",
          icon: <SidebarMotionIcon kind="code" className="size-3.5" />,
        },
        {
          value: "projects",
          label: "Projects",
          icon: <SidebarMotionIcon kind="projects" className="size-3.5" />,
        },
      ]}
    />
  );
}

/** A Juno Work task in the sidebar: title, and the one fact that decides
 *  whether the user needs to open it. The status is a dot rather than a word
 *  because the row is 14px of type in a 240px column, and the word for
 *  `waiting_approval` does not fit beside a real task title. */
function WorkSessionRow({
  session,
  active,
  onNavigate,
}: {
  session: ClientWorkSession;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={`/work/${session.id}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={session.title || session.goal}
      className={cn(
        "group flex items-center gap-2.5 rounded-control py-1.5 pl-2.5 pr-2.5 text-sm font-medium transition-[background-color,color] duration-fast ease-out-soft",
        active
          ? "bg-sidebar-accent font-semibold text-foreground"
          : "text-sidebar-foreground/90 hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
        <SidebarMotionIcon kind="work" className="h-[15px] w-[15px]" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {session.title || "Untitled task"}
      </span>
      <WorkStatusDot status={session.status} />
    </Link>
  );
}

/** Compact in-list failure row + retry — the sidebar-density version of the
 *  tasks page's error card, so a failed fetch never masquerades as empty. */
function InlineErrorRow({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    // role="alert": these replace a section's contents when a fetch fails, so
    // without it the section just reads as empty to a screen reader.
    <div
      role="alert"
      // bg-destructive/10, not /5: over the pure-black ground a 5% tint
      // composites to ~2.5% lightness and disappears, leaving the one row that
      // must not be mistaken for ordinary content carried by its border alone.
      className="mx-0.5 my-1 flex items-center gap-2 rounded-xs border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-ui text-destructive"
    >
      <StatusIcons.error className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        // coarse: pad the ~20px target out to 44px without changing the row's
        // density on pointer devices (negative margins absorb the extra box).
        // No `transition-colors` beside `.pressable`: the class already declares
        // a transition covering colour AND transform, and a later transition-*
        // utility replaces that shorthand wholesale — which dropped `transform`
        // from the list and made the press dip to scale(.97) in a single frame.
        className="pressable flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5 font-medium hover:bg-destructive/20 coarse:-my-2.5 coarse:min-h-[44px] coarse:px-3 coarse:py-2.5"
      >
        <ActionIcons.refresh className="size-3" aria-hidden="true" /> Retry
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
  // Built from the shared icon recipe rather than restated, so the rail's nav
  // marks are the same object as the expand toggle sitting directly above them.
  // They were not: the toggle became circular with the rest of the product's
  // bare glyphs while these stayed rounded-field, which put two 36px squares of
  // different shape in one 64px column — the most visible place in the app to
  // get that wrong.
  const cls = cn(
    pressableVariants({ kind: "icon", size: "lg" }),
    "group text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
    active && "bg-sidebar-accent text-foreground",
  );
  // Tooltip, not the native `title` this carried: the OS bubble runs on its own
  // ~1s clock and skips the popper motion pair, so the rail's labels were the
  // one set of hover hints in the product off the shared 200ms delay.
  // `side="right"` matches the expand toggle above — beside the rail is the
  // only direction with room.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link
            href={href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cls}
          >
            {children}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className={cls}
          >
            {children}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavRow({
  href,
  onClick,
  icon,
  label,
  active,
  className,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  className?: string;
}) {
  const cls = cn(
    "group relative flex min-h-9 items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm font-medium transition-colors duration-fast ease-out-soft",
    active
      ? "bg-sidebar-accent font-semibold text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
    className,
  );
  const inner = (
    <>
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={cls}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "w-full text-left")}
    >
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
      {Icon && !collapsible && (
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
      )}
      {/* Full --muted-foreground, no alpha. At /75 against the black ground this
          label measured under the 4.5:1 floor, and it is the only thing naming
          the list under it.
          text-xs, not text-[12px]: the same 12px, but named — and the exact
          voice DropdownMenuLabel already speaks (text-xs font-medium
          text-muted-foreground), so a section heading reads the same whether
          the list lives in this panel or in a menu. Sentence case throughout;
          the uppercase `label` token is for mono eyebrows, not headings. */}
      <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {collapsible && (
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-fast ease-out-soft",
            isCollapsed && "-rotate-90",
          )}
        />
      )}
    </>
  );

  return (
    <div className="mb-5 mt-1">
      <div className="flex items-center">
        {collapsible ? (
          <Pressable
            kind="row"
            onClick={onToggleCollapse}
            aria-expanded={!isCollapsed}
            // px-2.5 to sit on the same left edge as the L1 rows beneath it.
            // Every section label in this panel was at px-2 against rows at
            // px-2.5, so each heading hung 2px left of its own list — a ragged
            // margin running the height of the sidebar that no single element
            // looks wrong for.
            // Full sidebar-accent, like every row beneath it. At /50 on the
            // black ground the header answered the pointer at 5.5% while its own
            // list answered at 11% — two hover strengths stacked in one 256px
            // column, and the weaker one read as no response at all.
            // No radius here either: Pressable's `row` already sets
            // rounded-control, and now that cn() resolves the ladder the
            // `rounded-md` this carried actually won — drawing the section
            // header at 8px directly above its own 9px rows.
            className="min-w-0 flex-1 select-none gap-1.5 px-2.5 py-1 hover:bg-sidebar-accent"
          >
            {headerInner}
          </Pressable>
        ) : (
          <div className="flex min-w-0 flex-1 select-none items-center gap-1.5 px-2.5 py-1">
            {headerInner}
          </div>
        )}
        {action != null && (
          <span className="flex shrink-0 items-center pr-1">{action}</span>
        )}
      </div>
      <Disclosure open={!isCollapsed}>
        <div className="space-y-0.5">{children}</div>
      </Disclosure>
    </div>
  );
}

/**
 * The panel's one fold.
 *
 * Grid-rows sweep so 10+ rows don't appear/vanish in one frame; visibility rides
 * the same transition, which also drops hidden rows from tab order.
 *
 * Extracted because three disclosures live in this one column and only ONE of
 * them animated: `Section` swept, while the Code workspace group and the project
 * row both mounted their children with a bare `{expanded && …}` and popped in
 * and out in a single frame directly beneath a section that glides. Three folds
 * in 256px cannot disagree about what folding looks like, and keeping the recipe
 * in one place is the only way that stays true.
 */
function Disclosure({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,visibility] duration-base ease-out-soft motion-reduce:transition-none",
        open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]",
      )}
    >
      <div
        className={cn(
          // -mx/px bleed keeps the rows' hover nudge from clipping at the fold edge.
          "-mx-2 min-h-0 overflow-hidden px-2 transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          !open && "opacity-0",
        )}
      >
        {children}
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
        className="group flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm font-medium text-sidebar-foreground/90 transition-[color,background-color] duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground"
      >
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
          <SidebarMotionIcon kind="folder" className="h-[16px] w-[16px]" />
        </span>
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {name}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-fast ease-out-soft",
            expanded && "rotate-90",
          )}
        />
      </button>
      <Disclosure open={expanded}>
        <div className="mt-0.5 flex flex-col gap-0.5">
          {sessions.length === 0 && tasks.length === 0 && (
            <p className="py-1 pl-6 pr-2 text-ui text-muted-foreground">
              No sessions yet.
            </p>
          )}
          {sessions.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              variant="code"
              nested
              taskStatus={taskStatusFor(c.id)}
              active={
                c.id === activeConversationId || activePath === `/chat/${c.id}`
              }
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
      </Disclosure>
    </div>
  );
}

const TASK_STATUS_META: Record<string, { label: string; dot: string }> = {
  queued: { label: "Queued", dot: "bg-muted-foreground/50" },
  // icon-breathe, not Tailwind's stock `animate-pulse`: that is a 2s
  // cubic-bezier(0.4,0,0.6,1) loop which appears nowhere in the motion tokens,
  // and an ease-OUT curve run as a loop visibly stutters at its seam — the exact
  // failure --ease-breathe was added to fix.
  running: {
    label: "Running",
    dot: "bg-success motion-safe:animate-icon-breathe",
  },
  awaiting_approval: { label: "Approval", dot: "bg-warning" },
  failed: { label: "Failed", dot: "bg-destructive" },
};

/** A remote Juno Code task shown standalone (its session row, if any, isn't in
 *  the list). Linked tasks deep-link to their session; app-started tasks have
 *  no session to open, so their row stays a plain, non-interactive readout —
 *  a row that went nowhere would be a dead button. */
function CodeTaskStatusRow({
  task,
  onNavigate,
}: {
  task: CodeTaskRow;
  onNavigate?: () => void;
}) {
  const meta = TASK_STATUS_META[task.status];
  if (!meta) return null;
  const inner = (
    <>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", meta.dot)}
        aria-hidden="true"
      />
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {task.title}
      </span>
      {/* text-micro is the mono metadata floor (tailwind.config.ts) — the
          text-[10px] it replaces sat under it, losing hairline strokes on 1x
          displays in exactly the muted ink this label is set in. */}
      <span className="shrink-0 font-mono text-micro text-muted-foreground">
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
        // Fill and ink only — no hover:translate-x nudge. Every other L2 row in
        // the column (project chats, nested sessions, "View all") answers the
        // pointer with the flat sidebar-accent fill; this was the single row
        // that also slid, which made one tier carry two hover grammars.
        className="flex items-center gap-2 rounded-xs py-1 pl-6 pr-2 text-ui text-sidebar-foreground/70 transition-[background-color,color] duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-xs py-1 pl-6 pr-2 text-ui text-sidebar-foreground/70"
      title={task.title}
    >
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

  const patch = async (
    data: Partial<
      Pick<ClientConversation, "title" | "titleSource" | "pinned" | "projectId">
    >,
  ) => {
    const optimistic =
      data.title != null ? { ...data, titleSource: "manual" as const } : data;
    onUpdate(conversation.id, optimistic);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        data.titleSource == null ? data : { ...data, titleSource: undefined },
      ),
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
      title:
        variant === "code"
          ? "Delete this session?"
          : "Delete this conversation?",
      description:
        "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: variant === "code" ? "Delete session" : "Delete chat",
      onConfirm: async () => {
        onRemove(conversation.id);
        const res = await fetch(`/api/conversations/${conversation.id}`, {
          method: "DELETE",
        });
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
      <div
        className={cn(
          "flex items-center gap-1 pl-2 pr-1 py-1",
          nested && "pl-6",
        )}
      >
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={commitRename}
              aria-label="Save"
            >
              <StatusIcons.success className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft",
        nested && "pl-6",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent",
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 font-medium text-sidebar-foreground/90 hover:text-foreground",
          // text-ui is L2, text-sm is L1 (see the header comment) — the two row
          // tiers, named, so this row cannot drift half a point off either one.
          nested ? "text-ui" : "text-sm",
          active && "font-semibold text-foreground",
        )}
        title={conversation.title}
      >
        {/* Claude-style: every chat carries the same speech-bubble mark. */}
        <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
          <SidebarMotionIcon
            kind="conversation"
            className={nested ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"}
          />
        </span>
        <AnimatedTitle
          title={
            conversation.title ||
            (variant === "code" ? "New session" : "New chat")
          }
          animate={conversation.titleSource === "ai"}
          className="min-w-0 flex-1"
        />
        {taskStatus && TASK_STATUS_META[taskStatus] && (
          /* A 6px dot cannot carry a word, so the word rides a Tooltip — in the
             mono metadata voice, because this is the same readout
             CodeTaskStatusRow prints inline (font-mono text-micro), shown on
             demand instead of always. The native `title` it replaces ignored
             the shared 200ms delay. */
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 items-center pl-1">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    TASK_STATUS_META[taskStatus].dot,
                  )}
                  aria-hidden="true"
                />
                <span className="sr-only">
                  {TASK_STATUS_META[taskStatus].label}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-micro">
              {TASK_STATUS_META[taskStatus].label}
            </TooltipContent>
          </Tooltip>
        )}
      </Link>
      <DropdownMenu>
        {/* Tooltip around DropdownMenuTrigger, the composition DownloadMenu
            already uses: both slots merge onto the one Pressable, and Radix
            drops the tooltip the moment the menu opens. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Pressable
                kind="icon"
                className={KEBAB_CLASS}
                aria-label={
                  variant === "code"
                    ? "Session options"
                    : "Conversation options"
                }
              >
                <SidebarMotionIcon kind="more" className="size-4" />
              </Pressable>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {variant === "code" ? "Session options" : "Conversation options"}
          </TooltipContent>
        </Tooltip>
        {/* Width only. The origin and the pop-in/out pair are already on the
            primitive; re-declaring them here (with `!` to win a specificity fight
            that no longer exists) is how the other ~30 menus quietly drifted. */}
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => patch({ pinned: !conversation.pinned })}
          >
            <Pin
              className={cn(
                "size-4",
                conversation.pinned ? "fill-primary text-primary" : "",
              )}
            />
            <span>{conversation.pinned ? "Unpin" : "Pin"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setDraft(conversation.title);
              setRenaming(conversation.id);
            }}
          >
            <ActionIcons.edit className="size-4" /> Rename
          </DropdownMenuItem>
          {variant === "chat" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <AppIcons.projects className="size-4" /> Add to project
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                    {conversation.projectId == null ? (
                      <StatusIcons.success className="size-4" />
                    ) : (
                      <span className="size-4" />
                    )}{" "}
                    No project
                  </DropdownMenuItem>
                  {projects.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => patch({ projectId: p.id })}
                    >
                      {conversation.projectId === p.id ? (
                        <StatusIcons.success className="size-4" />
                      ) : (
                        <AppIcons.projects className="size-4" />
                      )}
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
            </>
          )}
          <DropdownMenuSeparator />
          {/* The primitive's destructive variant, not a per-site class. The
              string this carried filled focus with FULL --destructive — the one
              menu in the product where Delete highlighted like a primary action
              instead of taking the tinted /10 fill the variant was QA'd to. */}
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
          "group relative flex items-center rounded-control pl-2 pr-1 transition-[background-color,color] duration-fast ease-out-soft",
          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent",
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
            "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-sm font-medium text-sidebar-foreground/90 hover:text-foreground",
            active && "font-semibold text-foreground",
          )}
          title={project.name}
        >
          {/* 20px box, 15px mark — the same icon column as ConversationRow, which
            this row is stacked directly on top of under "Pinned". It was a 22px
            box around an unsized 18px glyph, so a project and the chats beneath
            it started their titles 2px apart and wore marks three points
            different in weight, in one list. */}
          <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
            <SidebarMotionIcon kind="projects" className="h-[15px] w-[15px]" />
          </span>
          <AnimatedTitle
            title={project.name}
            animate={project.nameSource === "ai"}
            className="min-w-0 flex-1"
          />
        </Link>
        {/* Disclosure ›, rotating open. Sits with the kebab at the row's trailing
          edge: the project link owns the whole span it paints hover across. */}
        {hasChats && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  setExpanded((v) => !v);
                  if (expanded) setShowAll(false);
                }}
                aria-label={
                  expanded
                    ? `Collapse ${project.name}`
                    : `Expand ${project.name}`
                }
                aria-expanded={expanded}
                // 20px is well under the 44px touch minimum — widen on coarse
                // pointers only, with negative margins so row height is unchanged.
                // Circular, and it fills on hover: `rounded-sm` (4px, off the ladder)
                // put a square 2px from the circular kebab it shares a row with, and a
                // colour-only hover on a 20px glyph gives the pointer nothing to land
                // on — the kebab beside it has answered with a fill all along.
                className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-sidebar-accent hover:text-foreground coarse:-my-3 coarse:size-11"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform duration-fast ease-out-soft",
                    expanded && "rotate-90",
                  )}
                />
              </button>
            </TooltipTrigger>
            {/* The verb alone — aria-label keeps the project name for readers,
              but a hover hint restating a title already on screen is noise. */}
            <TooltipContent>{expanded ? "Collapse" : "Expand"}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Pressable
                  kind="icon"
                  className={KEBAB_CLASS}
                  aria-label="Project options"
                >
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
              <Pin
                className={cn("size-4", starred && "fill-primary text-primary")}
              />
              <span>{starred ? "Unpin" : "Pin"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <ActionIcons.edit className="size-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Same variant note as ConversationRow's Delete: the primitive owns
              the destructive treatment. */}
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
                aria-current={
                  activePath === `/chat/${c.id}` ? "page" : undefined
                }
                title={c.title}
                className={cn(
                  "group group/pc flex items-center gap-2 rounded-xs py-1 pl-9 pr-2 text-ui transition-[color,background-color] duration-fast ease-out-soft hover:bg-sidebar-accent",
                  // bg-sidebar-accent on the active row, like every other selected
                  // row in this panel (a deliberate QA decision: neutral fill, no
                  // accent rail). This was the one selected state carried by weight
                  // alone, so the open chat vanished the moment a sibling hovered.
                  activePath === `/chat/${c.id}`
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-sidebar-foreground/70 hover:text-foreground",
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
