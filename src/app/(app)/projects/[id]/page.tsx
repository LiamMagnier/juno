"use client";

import { AppPage } from "@/components/app/app-page";
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ImageOff, ImagePlus, Loader2, Maximize2, Plus } from "@/components/ui/icons";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup, SettingsHint, SettingsRow } from "@/components/projects/project-settings-group";
import { Collapse } from "@/components/ui/collapse";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { useApp } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import type { ReasoningEffort } from "@/types/chat";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WORKSPACE_TOOLS,
  type WorkspaceConfig,
  type WorkspaceTool,
} from "@/lib/projects/workspace-config";
import {
  parseWorkDefaults,
  serializeWorkDefaults,
  type WorkProjectDefaults,
} from "@/lib/work/projects";
import { ProjectWorkDefaults } from "@/components/projects/project-work-defaults";
import { ProjectWorkspaceHeader } from "@/components/projects/project-workspace-header";
import { ProjectPageSkeleton } from "@/components/projects/project-page-skeleton";
import {
  ProjectKnowledgePanel,
  type KnowledgeFile,
  type PanelProjectMemory,
} from "@/components/projects/project-knowledge-panel";
import { ProjectDriveDialog } from "@/components/projects/project-drive-dialog";
import { ProjectLibraryDialog } from "@/components/projects/project-library-dialog";
import { ProjectChatList } from "@/components/projects/project-chat-list";
import { ProjectWorkList, type ProjectWorkItem } from "@/components/projects/project-work-list";
import { ProjectCodeList } from "@/components/projects/project-code-list";
import { ARTIFACT_NOUN, artifactPath, madeInConversations } from "@/lib/artifact-links";
import type { ArtifactType } from "@/lib/message-content";
import {
  DeleteProjectDialog,
  MoveToDialog,
  ProjectNameDialog,
  ProjectSheet,
  ProjectTile,
  canDropInto,
  newFolderRefusal,
  type FolderProject,
  type MoveSubject,
  type ProjectDrag,
} from "@/components/projects/project-folders";
import { ProjectInstructionsDialog, type InheritedInstructions } from "@/components/projects/project-instructions-dialog";
import { MOVE_REFUSAL_MESSAGES, type DeleteChildrenMode, type MoveRefusal } from "@/lib/projects/project-tree";
import { knowledgeUsage } from "@/lib/projects/knowledge-capacity";
import {
  sourcesBusy,
  type DriveAvailability,
  type ProjectSourceView,
  type ProjectSourcesResponse,
} from "@/lib/projects/project-sources-shared";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import { cachedJson } from "@/lib/client-cache";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

// Soft UI only — no save rejection. Warn when the draft is very large.
const INSTRUCTIONS_SOFT_WARN = 50_000;
/** How often the page re-reads its sources while one of them is syncing. */
const SOURCE_POLL_MS = 2_500;

/**
 * Where a `?tab=` link lands. The page is one view now (Claude's project page:
 * the work on the left, what the project knows on the right) plus Settings,
 * and the lists under the composer switch between chats, tasks, code and
 * artifacts. The old tab values still resolve, because people hold them in
 * bookmarks: `work` and `code` open that list, `sources` the overview (the
 * knowledge panel is always on it), `workspace` and `assistant` the settings.
 */
type ListKind = "chats" | "work" | "code" | "artifacts";
type PageView = "overview" | "settings";

function parseTab(raw: string | null): { view: PageView; list?: ListKind } | null {
  switch (raw) {
    case "overview":
    case "sources":
      return { view: "overview" };
    case "work":
    case "code":
    case "artifacts":
      return { view: "overview", list: raw };
    case "settings":
    case "workspace":
    case "assistant":
      return { view: "settings" };
    default:
      return null;
  }
}

interface ProjectArtifactItem {
  id: string;
  identifier: string;
  title: string;
  type: string;
  updatedAt: string;
  conversationId: string | null;
}

interface Detail {
  /** The owner adds and removes knowledge; a collaborator reads it. */
  isOwner?: boolean;
  project: {
    id: string;
    name: string;
    description?: string;
    instructions: string;
    starred: boolean;
    updatedAt: string;
    /** What a Work task filed here inherits. `{}` for a project never asked. */
    workDefaults: WorkProjectDefaults;
    /** The folder it sits in; null at the top level (and for a collaborator). */
    parentId?: string | null;
  };
  /** The folders above it, root first. */
  breadcrumbs?: { id: string; name: string }[];
  /** The folders directly inside it. */
  children?: (FolderProject & { conversationCount: number; fileCount: number; childCount: number })[];
  /** Ancestors whose instructions or files every chat here also receives. */
  inherited?: InheritedInstructions[];
  conversations: {
    id: string;
    title: string;
    lastMessageAt: string;
    pinned: boolean;
    /** `"chat"` or `"code"`: which list it belongs in. */
    kind: string;
    codeWorkspaceName: string | null;
    codeWorkspacePath: string | null;
  }[];
  files: (KnowledgeFile & { kind: string })[];
  workspace: WorkspaceConfig;
}

const WORKSPACE_TOOL_LABELS: Record<WorkspaceTool, string> = {
  webSearch: "Web search",
  deepResearch: FEATURE_NAMES.research.label,
  canvas: "Canvas",
  mediaGeneration: "Image & video",
  connectors: "Connected apps",
  memoryRecall: "Memory",
};

/**
 * A project, laid out the way Claude lays one out: a workspace, not a form.
 *
 * Left: the way back, the name in the house serif and what the project is
 * for, a composer that starts a chat IN the project, and the project's chats
 * (with its tasks, code sessions and artifacts a switch away when it has
 * any). Right: one flat panel with what every chat here begins with: the
 * instructions, the knowledge (uploads, Library files and Google Drive files
 * and folders, kept in sync, with how full the project is) and its memory.
 *
 * On a phone it stacks in reading order: the name, the composer, the panel,
 * then the chats. The left column is `display: contents` below the split, so
 * its children and the panel are siblings that `order` can interleave; at the
 * split the column is a block again and the panel takes the right track.
 *
 * Settings (model, tools, task defaults) moved off the page's face into a
 * view of their own, reached from the actions menu: they are set once and
 * revisited rarely, and five tabs made every project open as a form.
 */
export default function ProjectDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { settings, models } = useApp();
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<"notfound" | "error" | null>(null);
  const [instructions, setInstructions] = React.useState("");
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  /** Guards an unsaved instructions draft against Escape / X / backdrop. */
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  /** The cover's own busy flag: replacing a picture is not adding knowledge. */
  const [uploadingCover, setUploadingCover] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const coverRef = React.useRef<HTMLInputElement>(null);

  const [view, setView] = React.useState<PageView>("overview");
  const [list, setList] = React.useState<ListKind>("chats");
  const [savingInstructions, setSavingInstructions] = React.useState(false);

  // Server-backed project star (Project.starred), toggled optimistically.
  const [isStarred, setIsStarred] = React.useState(false);
  // This project's memory: its own summary and the facts learned in its chats.
  const [projectMemory, setProjectMemory] = React.useState<PanelProjectMemory | null>(null);
  // Every project the account has, as a tree: the Move to… picker and the
  // drop checks read it.
  const [allProjects, setAllProjects] = React.useState<FolderProject[]>([]);
  const [moving, setMoving] = React.useState<MoveSubject | null>(null);
  const [moveBusy, setMoveBusy] = React.useState(false);
  const [folderDialog, setFolderDialog] = React.useState(false);
  const [folderBusy, setFolderBusy] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [chatToDelete, setChatToDelete] = React.useState<{ id: string; title: string } | null>(null);
  const [workspace, setWorkspace] = React.useState<WorkspaceConfig>({});
  const [savingWorkspace, setSavingWorkspace] = React.useState(false);
  /**
   * The Work bundle as the reader is editing it, beside what the server last
   * said. Two copies so Save is enabled by the difference; both go through
   * `serializeWorkDefaults` before they are compared, which fixes key order.
   */
  const [workDefaults, setWorkDefaults] = React.useState<WorkProjectDefaults>({});
  const [savedWorkDefaults, setSavedWorkDefaults] = React.useState<WorkProjectDefaults>({});
  const [savingWorkDefaults, setSavingWorkDefaults] = React.useState(false);
  const [workRuns, setWorkRuns] = React.useState<ProjectWorkItem[]>([]);
  /** The project's artifacts with the chat each was made in (narrowed below). */
  const [accountArtifacts, setAccountArtifacts] = React.useState<ProjectArtifactItem[]>([]);

  // Knowledge sources (Google Drive) and whether Drive can be offered.
  const [sources, setSources] = React.useState<ProjectSourceView[]>([]);
  const [drive, setDrive] = React.useState<DriveAvailability | null>(null);
  const [driveOpen, setDriveOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [sourceToRemove, setSourceToRemove] = React.useState<ProjectSourceView | null>(null);
  const [removingSource, setRemovingSource] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);

  // Composer states. `null` model = not chosen yet → fall back to the
  // project's preferred model, then the account default, without overwriting
  // a pick the user already made.
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort | null>("high");
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const projectModel = selectedModel ?? workspace.preferredModelId
    ?? settings?.defaultModel ?? "anthropic:claude-sonnet-5";

  /**
   * Where you are is part of the URL: `?tab=settings` for Settings, `?tab=work`
   * for the tasks list. `replaceState` rather than a route navigation, so the
   * composer's draft survives, and not `pushState`, so Back leaves the project
   * instead of walking back through every switch.
   */
  const writeTab = React.useCallback((value: string | null) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("tab", value);
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  }, []);
  const openView = React.useCallback(
    (next: PageView) => {
      setView(next);
      writeTab(next === "settings" ? "settings" : list === "chats" ? null : list);
      window.scrollTo?.({ top: 0 });
    },
    [list, writeTab],
  );
  const openList = React.useCallback(
    (next: ListKind) => {
      setList(next);
      writeTab(next === "chats" ? null : next);
    },
    [writeTab],
  );

  const coverFile = data?.files.find((f) => f.fileName === "__cover__");
  const coverUrl = coverFile?.url ?? null;

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/projects/${id}`);
      if (r.status === 404) return setError("notfound");
      if (!r.ok) throw new Error();
      const d: Detail = await r.json();
      setData(d);
      setInstructions(d.project.instructions);
      setWorkspace(d.workspace ?? {});
      // Through the parser on the way in as well as on the way out: a build
      // older than the one that wrote the column draws the parts it knows.
      const defaults = parseWorkDefaults(d.project.workDefaults);
      setWorkDefaults(defaults);
      setSavedWorkDefaults(defaults);
    } catch {
      setError("error");
    }
  }, [id]);

  const loadSources = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${id}/sources`);
      if (!r.ok) {
        // A collaborator: sources are the owner's, and there is nothing to add.
        setDrive({ enabled: false, configured: false, connected: false, accountLabel: null });
        return;
      }
      const body = (await r.json()) as ProjectSourcesResponse | null;
      if (!body || !Array.isArray(body.sources) || !body.drive) return;
      setSources(body.sources);
      setDrive(body.drive);
    } catch {
      // Keep what is drawn; the next poll or visit tries again.
    }
  }, [id]);

  const loadAllProjects = React.useCallback(() => {
    // The account's project list (for Move to… and the breadcrumbs) is the
    // one the sidebar already read; share it instead of reading it again.
    cachedJson<{ projects?: FolderProject[] }>("/api/projects")
      .then((p) => {
        if (p && Array.isArray(p.projects)) {
          setAllProjects(p.projects.map((row: FolderProject) => ({ ...row, parentId: row.parentId ?? null })));
        }
      })
      .catch(() => {});
  }, []);

  const refreshKnowledgeAfterUpload = React.useCallback(() => {
    // Bounded refreshes of the durable index state, not a guessed progress
    // animation: a killed background job leaves the honest queued state.
    for (const delay of [900, 2_500, 6_000]) {
      window.setTimeout(() => void load(), delay);
    }
  }, [load]);

  React.useEffect(() => {
    void load();
    void loadSources();

    // This project's memory, never the account's: a chat here reads only
    // what was learned here, so that is what the panel shows.
    fetch(`/api/projects/${encodeURIComponent(id)}/memory`)
      .then((res) => (res.ok ? res.json() : null))
      .then((m: PanelProjectMemory | null) => {
        setProjectMemory(m && Array.isArray(m.facts) ? m : { summary: null, facts: [], activeCount: 0 });
      })
      .catch(() => setProjectMemory({ summary: null, facts: [], activeCount: 0 }));

    loadAllProjects();

    // This project's delegated tasks, filtered by project on the server.
    fetch(`/api/work/sessions?projectId=${encodeURIComponent(id)}&limit=50`)
      .then((res) => res.json())
      .then((res) => {
        if (res && Array.isArray(res.sessions)) {
          setWorkRuns(
            res.sessions.map((s: Record<string, unknown>) => ({
              id: String(s.id),
              conversationId: s.conversationId == null ? null : String(s.conversationId),
              title: String(s.title || ""),
              goal: String(s.goal || ""),
              status: s.status,
              updatedAt: String(s.updatedAt || ""),
              createdAt: String(s.createdAt || ""),
            }))
          );
        }
      })
      .catch(() => {});

    // This project's artifacts, scoped by the route (`?projectId=`).
    fetch(`/api/artifacts?projectId=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => {
        if (res && Array.isArray(res.items)) {
          setAccountArtifacts(
            res.items.map((a: Record<string, unknown>) => ({
              id: String(a.id),
              identifier: String(a.identifier || a.id),
              title: String(a.title || "Untitled artifact"),
              type: String(a.type || "CODE"),
              conversationId: a.conversationId == null ? null : String(a.conversationId),
              updatedAt: String(a.updatedAt || ""),
            }))
          );
        }
      })
      .catch(() => {});
  }, [load, loadSources, id, loadAllProjects]);

  /**
   * Arrival: a `?tab=` deep link, and the two hand-offs from Google's consent
   * screen. `?drive=1` reopens the Drive picker the person left to connect;
   * `?connected=google-drive` means Drive is linked now, so sources that were
   * waiting on it sync at once. Both flags are dropped from the address so a
   * reload does not repeat them.
   */
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const tab = parseTab(url.searchParams.get("tab"));
    if (tab) {
      setView(tab.view);
      if (tab.list) setList(tab.list);
    }
    const reopenDrive = url.searchParams.get("drive") === "1";
    const connected = url.searchParams.get("connected") === "google-drive";
    const connectError = url.searchParams.get("connect_error");
    if (!reopenDrive && !connected && !connectError) return;
    for (const key of ["drive", "connected", "connect_error"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    if (connectError) {
      toast.error(connectError === "denied" ? "Google Drive wasn’t connected. Nothing changed." : "Couldn’t connect Google Drive. Try again.");
      return;
    }
    if (reopenDrive) setDriveOpen(true);
    if (connected) {
      void fetch(`/api/projects/${id}/sources`)
        .then((r) => (r.ok ? (r.json() as Promise<ProjectSourcesResponse>) : null))
        .then((body) => {
          const waiting = body?.sources.filter((s) => s.errorCode === "reconnect" || s.errorCode === "not_connected" || s.errorCode === "forbidden") ?? [];
          return Promise.all(waiting.map((s) => fetch(`/api/projects/${id}/sources/${s.id}`, { method: "POST" })));
        })
        .then(() => loadSources())
        .catch(() => {});
    }
  }, [id, loadSources]);

  React.useEffect(() => {
    const refresh = () => void load();
    const refreshTree = () => {
      void load();
      loadAllProjects();
    };
    window.addEventListener("juno:sync", refresh);
    window.addEventListener("projects:sync", refreshTree);
    return () => {
      window.removeEventListener("juno:sync", refresh);
      window.removeEventListener("projects:sync", refreshTree);
    };
  }, [load, loadAllProjects]);

  /**
   * While a source is syncing, read the list again every few seconds, and the
   * project once more when it settles so the files it brought are drawn. A
   * poll, not a stream: a sync is minutes at most and runs after a response,
   * and the list is the durable state, so a reload mid-sync tells the truth.
   */
  const busy = sourcesBusy(sources);
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
    if (!busy) return;
    const timer = window.setInterval(() => void loadSources(), SOURCE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load, loadSources]);

  /** The artifacts made in this project's chats, derived so a chat moved out takes its artifacts with it. */
  const conversations = data?.conversations;
  const projectArtifacts = React.useMemo(
    () => madeInConversations(accountArtifacts, (conversations ?? []).map((c) => c.id)),
    [accountArtifacts, conversations]
  );

  React.useEffect(() => {
    if (data?.project.id) setIsStarred(data.project.starred);
  }, [data?.project.id, data?.project.starred]);

  const toggleProjectStar = async () => {
    if (!data?.project.id) return;
    const next = !isStarred;
    setIsStarred(next);
    const r = await fetch(`/api/projects/${data.project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setIsStarred(!next);
      toast.error("Couldn’t update the project.");
      return;
    }
    setData((cur) => (cur ? { ...cur, project: { ...cur.project, starred: next } } : cur));
    // No success toast: the pin fills under the pointer, which is the receipt.
    window.dispatchEvent(new CustomEvent("starred:sync"));
    window.dispatchEvent(new CustomEvent("projects:sync"));
  };

  const saveWorkspace = async () => {
    setSavingWorkspace(true);
    const response = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    }).catch(() => null);
    setSavingWorkspace(false);
    if (!response?.ok) {
      toast.error("Couldn’t save the assistant settings.");
      return;
    }
    toast.success("Assistant settings saved.");
    await load();
  };

  const saveWorkDefaults = async () => {
    setSavingWorkDefaults(true);
    const response = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workDefaults }),
    }).catch(() => null);
    setSavingWorkDefaults(false);
    if (!response?.ok) {
      // Nothing local is touched on a failure, so the draft is still there.
      toast.error("Couldn’t save these task defaults. Nothing has changed.");
      return;
    }
    toast.success("Task defaults saved.");
    await load();
  };

  const setWorkspaceTool = (tool: WorkspaceTool, enabled: boolean) => {
    setWorkspace((current) => {
      const allowed = new Set(current.allowedTools ?? WORKSPACE_TOOLS);
      if (enabled) allowed.add(tool); else allowed.delete(tool);
      return { ...current, allowedTools: WORKSPACE_TOOLS.filter((item) => allowed.has(item)) };
    });
  };

  /**
   * Throws on failure, a network reject included, so a caller never carries
   * on as if a write had landed (a failed instructions save used to close the
   * dialog and lose the draft).
   */
  const patch = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!r || !r.ok) throw new Error("save-failed");
  };

  const saveInstructions = async (): Promise<boolean> => {
    if (!data || instructions === data.project.instructions || savingInstructions) return false;
    setSavingInstructions(true);
    try {
      await patch({ instructions });
      setData({ ...data, project: { ...data.project, instructions, updatedAt: new Date().toISOString() } });
      toast.success("Project instructions saved.");
      return true;
    } catch {
      toast.error("Couldn’t save. Your text is still here, so check your connection and try again.");
      return false;
    } finally {
      setSavingInstructions(false);
    }
  };

  // Close only on a confirmed write; closing after a failure would drop the draft.
  const saveInstructionsAndClose = async () => {
    if (await saveInstructions()) setInstructionsOpen(false);
  };

  // `instructions` is one shared buffer (the panel, the dialog and the
  // settings editor all read it), so dismissing restores the saved value.
  const discardInstructions = () => {
    setInstructions(data?.project.instructions ?? "");
    setInstructionsOpen(false);
    setConfirmDiscard(false);
  };

  /** Every dismissal route funnels here; an unsaved draft asks first. */
  const requestCloseInstructions = () => {
    if (instructions !== (data?.project.instructions ?? "")) {
      setConfirmDiscard(true);
      return;
    }
    discardInstructions();
  };

  const handleSend = (text: string, options?: { deepResearch?: boolean }) => {
    const q = text.trim();
    if (!q) return;
    // The chat is made IN this project (`project=`), with the composer's model
    // carried through the hand-off.
    const params = new URLSearchParams({ project: id, q, model: projectModel });
    if (reasoningEffort) params.set("reasoning", reasoningEffort);
    if (options?.deepResearch) params.set("research", "1");
    router.push(`/chat?${params.toString()}`);
  };

  const uploadFile = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("projectId", id);
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? `Couldn’t upload “${file.name}”.`);
    setData((cur) =>
      cur
        ? {
            ...cur,
            files: [
              {
                ...d.attachment,
                sourceId: null,
                knowledge: { documentId: "pending", state: "queued", error: null, pageCount: null, blockCount: 0 },
              },
              ...cur.files,
            ],
          }
        : cur
    );
  };

  /** One at a time: they share the one `uploading` flag, and the order is the order picked. */
  const uploadFiles = async (picked: File[]) => {
    if (!picked.length) return;
    setUploading(true);
    let added = 0;
    for (const file of picked) {
      try {
        await uploadFile(file);
        added += 1;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn’t upload.");
      }
    }
    setUploading(false);
    if (added > 0) {
      refreshKnowledgeAfterUpload();
      toast.success(added === 1 ? "File added to the project." : `${added} files added to the project.`);
    }
  };

  const uploadCover = async (file: File) => {
    setUploadingCover(true);
    try {
      const existingCover = data?.files.find((f) => f.fileName === "__cover__");
      if (existingCover) {
        await fetch(`/api/attachments/${existingCover.id}`, { method: "DELETE" });
      }
      const newCover = new File([file], "__cover__", { type: file.type });
      const form = new FormData();
      form.append("file", newCover);
      form.append("projectId", id);
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Upload failed.");
      setData((cur) => {
        if (!cur) return null;
        const cleanFiles = cur.files.filter((f) => f.fileName !== "__cover__");
        return { ...cur, files: [{ ...d.attachment, sourceId: null }, ...cleanFiles] };
      });
      toast.success("Project image updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t upload the image.");
    } finally {
      setUploadingCover(false);
    }
  };

  const removeCover = async () => {
    const existingCover = data?.files.find((f) => f.fileName === "__cover__");
    if (!existingCover) return;
    setUploadingCover(true);
    try {
      await fetch(`/api/attachments/${existingCover.id}`, { method: "DELETE" });
      setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.id !== existingCover.id) } : cur));
      toast.success("Project image removed.");
    } catch {
      toast.error("Couldn’t remove the image.");
    } finally {
      setUploadingCover(false);
    }
  };

  const deleteFile = async (fileId: string) => {
    const r = await fetch(`/api/attachments/${fileId}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) {
      setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.id !== fileId) } : cur));
      toast.success("File removed from the project.");
    } else {
      toast.error("Couldn’t remove the file.");
    }
  };

  const syncSource = async (sourceId: string) => {
    setSources((cur) => cur.map((s) => (s.id === sourceId ? { ...s, syncing: true } : s)));
    const r = await fetch(`/api/projects/${id}/sources/${sourceId}`, { method: "POST" }).catch(() => null);
    if (!r?.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      toast.error(d.error ?? "Couldn’t start a sync.");
    }
    void loadSources();
  };

  const removeSource = async () => {
    if (!sourceToRemove) return;
    setRemovingSource(true);
    const r = await fetch(`/api/projects/${id}/sources/${sourceToRemove.id}`, { method: "DELETE" }).catch(() => null);
    setRemovingSource(false);
    if (!r?.ok) {
      toast.error("Couldn’t remove that source.");
      return;
    }
    setSources((cur) => cur.filter((s) => s.id !== sourceToRemove.id));
    setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.sourceId !== sourceToRemove.id) } : cur));
    setSourceToRemove(null);
  };

  const deleteProject = async (mode: DeleteChildrenMode) => {
    setDeleteBusy(true);
    const r = await fetch(`/api/projects/${id}?children=${mode}`, { method: "DELETE" }).catch(() => null);
    setDeleteBusy(false);
    if (r?.ok) {
      window.dispatchEvent(new CustomEvent("projects:sync"));
      // Up one level: the folder this one sat in, or the list.
      const parent = data?.breadcrumbs?.[data.breadcrumbs.length - 1];
      router.push(parent ? `/projects/${parent.id}` : "/projects");
    } else toast.error("Couldn’t delete project.");
  };

  /** Moves a project (this one or one of its folders) under `parentId`. */
  const moveProject = async (projectId: string, parentId: string | null) => {
    const r = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId }),
    }).catch(() => null);
    if (!r || !r.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      toast.error(d.reason ? MOVE_REFUSAL_MESSAGES[d.reason as MoveRefusal] : "Couldn’t move project.");
      return false;
    }
    const target = parentId ? allProjects.find((p) => p.id === parentId)?.name : null;
    toast.success(target ? `Moved into ${target}.` : "Moved to the top level.");
    window.dispatchEvent(new CustomEvent("projects:sync"));
    return true;
  };

  /** A folder or a chat dropped on a folder tile or a breadcrumb. */
  const handleDrop = (targetId: string | null, drag: ProjectDrag) => {
    if (drag.kind === "project") void moveProject(drag.id, targetId);
    else if (targetId) void moveChat(drag.id, targetId);
  };

  const confirmMove = async (targetId: string | null) => {
    if (!moving) return;
    setMoveBusy(true);
    const ok = moving.kind === "project" ? await moveProject(moving.id, targetId) : await moveChat(moving.id, targetId);
    setMoveBusy(false);
    if (ok) setMoving(null);
  };

  const createFolder = async (name: string) => {
    setFolderBusy(true);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || undefined, parentId: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn’t create the folder.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
      // Busy until the folder's page replaces this one, so a second click
      // cannot make a second folder.
      router.push(`/projects/${d.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t create the folder.");
      setFolderBusy(false);
    }
  };

  // The route reuses this page for the new folder's id, so the dialog and its
  // busy flag are put down when the id changes, not when the push is queued.
  React.useEffect(() => {
    setFolderDialog(false);
    setFolderBusy(false);
  }, [id]);

  // Pin a chat. Optimistic: the mark turns under the pointer, which is the receipt.
  const togglePin = async (chatId: string, currentPinned: boolean) => {
    const setPinned = (pinned: boolean) =>
      setData((cur) =>
        cur
          ? { ...cur, conversations: cur.conversations.map((c) => (c.id === chatId ? { ...c, pinned } : c)) }
          : cur
      );
    setPinned(!currentPinned);
    const r = await fetch(`/api/conversations/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !currentPinned }),
    }).catch(() => null);
    if (!r?.ok) {
      setPinned(currentPinned);
      toast.error("Couldn’t update this chat.");
    }
  };

  const deleteChat = async (chatId: string) => {
    setChatToDelete(null);
    const r = await fetch(`/api/conversations/${chatId}`, { method: "DELETE" });
    if (r.ok) {
      setData((cur) => (cur ? { ...cur, conversations: cur.conversations.filter((c) => c.id !== chatId) } : null));
      toast.success("Chat deleted.");
    } else {
      toast.error("Couldn’t delete chat.");
    }
  };

  const moveChat = async (chatId: string, targetProjectId: string | null): Promise<boolean> => {
    const r = await fetch(`/api/conversations/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: targetProjectId }),
    }).catch(() => null);
    if (r?.ok) {
      setData((cur) => (cur ? { ...cur, conversations: cur.conversations.filter((c) => c.id !== chatId) } : null));
      const targetProjectName = targetProjectId
        ? allProjects.find((p) => p.id === targetProjectId)?.name ?? "another project"
        : "no project";
      toast.success(`Chat moved to ${targetProjectName}.`);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      return true;
    }
    toast.error("Couldn’t move chat.");
    return false;
  };

  // Two terminal states, two tones: a missing project is an empty
  // destination, a failed load is an error the reader can retry.
  if (error === "notfound") {
    return (
      <AppPage measure="wide" contentClassName="flex min-h-full items-center">
        <div className="mx-auto w-full max-w-xl">
          <EmptyState
            className="w-full motion-safe:animate-rise-in"
            icon={AppIcons.projects}
            title="Project not found"
            description="It may have been deleted."
            action={
              <Button size="sm" asChild>
                <Link href="/projects">Back to projects</Link>
              </Button>
            }
          />
        </div>
      </AppPage>
    );
  }
  if (error === "error") {
    return (
      <AppPage measure="wide" contentClassName="flex min-h-full items-center">
        <div className="mx-auto w-full max-w-xl">
          <EmptyState
            tone="error"
            className="w-full motion-safe:animate-rise-in"
            icon={StatusIcons.error}
            title="Couldn’t load this project"
            description="Check your connection and try once more."
            action={
              <>
                <Button variant="outline" size="sm" onClick={load}>
                  Try again
                </Button>
                <Button size="sm" asChild>
                  <Link href="/projects">Back to projects</Link>
                </Button>
              </>
            }
          />
        </div>
      </AppPage>
    );
  }
  if (!data) {
    return (
      <AppPage measure="wide" contentClassName="pj-projects-page" role="status" aria-label="Loading project">
        <ProjectPageSkeleton />
      </AppPage>
    );
  }

  const knowledgeFiles = data.files.filter((f) => f.fileName !== "__cover__");
  const instructionsDirty = instructions !== data.project.instructions;
  const nearInstructionsLimit = instructions.length > INSTRUCTIONS_SOFT_WARN;
  const usage = knowledgeUsage(
    knowledgeFiles.map((f) => ({ size: f.size, mimeType: f.mimeType, tokenCount: f.knowledge?.tokenCount ?? null }))
  );

  // `kind` separates a chat from a Code session (never the title).
  const chats = data.conversations.filter((c) => c.kind !== "code");
  const codeSessions = data.conversations.filter((c) => c.kind === "code");
  const folders = data.children ?? [];
  const crumbs = data.breadcrumbs ?? [];
  const inherited = data.inherited ?? [];
  // The tree as the picker and the drop checks need it; until the list
  // arrives, this project and its folders are enough to draw the page.
  const tree: FolderProject[] = allProjects.length
    ? allProjects
    : [{ id: data.project.id, name: data.project.name, parentId: data.project.parentId ?? null }, ...folders.map((f) => ({ ...f, parentId: data.project.id }))];
  const folderRefusal = newFolderRefusal(tree, data.project.id);
  const isOwner = data.isOwner !== false;
  const description = data.project.description ?? "";

  // The lists under the composer: chats always, the others when they hold
  // something (or a link opened them).
  const listOptions = [
    { value: "chats" as const, label: "Chats", count: chats.length },
    ...(workRuns.length > 0 || list === "work" ? [{ value: "work" as const, label: "Tasks", count: workRuns.length }] : []),
    ...(codeSessions.length > 0 || list === "code" ? [{ value: "code" as const, label: "Code", count: codeSessions.length }] : []),
    ...(projectArtifacts.length > 0 || list === "artifacts" ? [{ value: "artifacts" as const, label: "Artifacts", count: projectArtifacts.length }] : []),
  ];

  const header = (
    <ProjectWorkspaceHeader
      project={{ ...data.project, description }}
      isStarred={isStarred}
      onToggleStar={toggleProjectStar}
      onSaveDetails={async ({ name, description: nextDescription }) => {
        await patch({ name, description: nextDescription });
        // Saved in place, under the reader's eye; no toast.
        setData((cur) => (cur ? { ...cur, project: { ...cur.project, name, description: nextDescription } } : cur));
        window.dispatchEvent(new CustomEvent("projects:sync"));
      }}
      onDelete={isOwner ? () => setDeleteOpen(true) : undefined}
      onOpenSettings={() => openView("settings")}
      breadcrumbs={crumbs}
      onDropOnCrumb={isOwner ? handleDrop : undefined}
      acceptOnCrumb={(drag, targetId) => (drag.kind === "chat" ? targetId !== null && targetId !== id : canDropInto(tree, drag, targetId))}
      onMove={isOwner ? () => setMoving({ kind: "project", id: data.project.id, name: data.project.name, parentId: data.project.parentId ?? null }) : undefined}
      onNewFolder={isOwner ? () => setFolderDialog(true) : undefined}
      newFolderRefusal={folderRefusal}
      menuExtras={
        isOwner ? (
          <>
            <DropdownMenuItem disabled={uploadingCover} onSelect={() => coverRef.current?.click()}>
              <ImagePlus className="size-4" aria-hidden="true" />
              <span>{coverUrl ? "Change image" : "Add project image"}</span>
            </DropdownMenuItem>
            {coverUrl && (
              <DropdownMenuItem disabled={uploadingCover} onSelect={removeCover}>
                <ImageOff className="size-4" aria-hidden="true" />
                <span>Remove image</span>
              </DropdownMenuItem>
            )}
          </>
        ) : undefined
      }
    />
  );

  return (
    <AppPage measure="wide" contentClassName="pj-projects-page">
      <div className={cn(view !== "overview" && "hidden")}>
        {header}
        <div className="pj-workspace-grid">
          <div className="pj-workspace-main">
            <section className="pj-composer-card" aria-labelledby="pj-start-chat">
              <div className="pj-composer-heading">
                <h2 id="pj-start-chat">New chat</h2>
                <a className="pj-knowledge-jump" href="#project-knowledge">Project knowledge</a>
              </div>
              <Composer
                conversationId={null}
                frame="inline"
                model={projectModel}
                onModelChange={(m) => setSelectedModel(m)}
                onSend={(text, _attachments, options) => handleSend(text, options)}
                isBusy={false}
                status="idle"
                onStop={() => {}}
                reasoningEffort={reasoningEffort}
                onReasoningChange={setReasoningEffort}
                /* The project's own name where it fits: this composer starts
                   a chat in this project, not anywhere. */
                placeholder={
                  data.project.name.length <= 32
                    ? `Start a chat in ${data.project.name}…`
                    : "Start a chat in this project…"
                }
              />
            </section>

            <div className="pj-workspace-history">
              {/* Folders: the projects inside this one, as compact cards that
                  are drop targets. Shown when there are some; making one is in
                  the actions menu, with the project's other filing verbs. */}
              {isOwner && folders.length > 0 && (
                <section className="pj mb-10" aria-labelledby="pj-folders-title">
                  <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
                      <h2 id="pj-folders-title" className="pj-section-title flex items-baseline gap-2">
                      Folders
                      <span className="text-caption font-normal tabular-nums text-muted-foreground">{folders.length}</span>
                    </h2>
                    {folderRefusal ? (
                      <span className="text-caption text-muted-foreground">{folderRefusal}</span>
                    ) : (
                      <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={() => setFolderDialog(true)}>
                        <Plus className="size-4" aria-hidden="true" /> New folder
                      </Button>
                    )}
                  </div>
                  <ul className="pj-grid grid gap-2 @[30rem]/page:grid-cols-2">
                    {folders.map((folder, i) => (
                      <li key={folder.id} className="min-w-0">
                        <ProjectTile
                          compact
                          index={i}
                          project={folder}
                          allProjects={tree}
                          onMove={() => setMoving({ kind: "project", id: folder.id, name: folder.name, parentId: data.project.id })}
                          onDropInto={(drag) => handleDrop(folder.id, drag)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-labelledby="pj-history-title">
                <div className="pj-history-heading">
                  <h2 id="pj-history-title" className="pj-section-title">{listOptions.length > 1 ? "Project activity" : "Chats"}</h2>
                  {listOptions.length > 1 && (
                    <SegmentedControl
                      size="sm"
                      columns="content"
                      value={list}
                      onChange={openList}
                      ariaLabel="Show"
                      options={listOptions}
                    />
                  )}
                </div>

                {list === "chats" && (
                  <ProjectChatList
                    projectId={data.project.id}
                    conversations={chats}
                    onTogglePin={togglePin}
                    onRequestMove={(chat) => setMoving({ kind: "chat", id: chat.id, name: chat.title, projectId: data.project.id })}
                    onDeleteChat={(chat) => setChatToDelete({ id: chat.id, title: chat.title })}
                    onNewChat={() => router.push(`/chat?project=${id}`)}
                  />
                )}
                {list === "work" && (
                  <ProjectWorkList
                    projectId={data.project.id}
                    workRuns={workRuns}
                    // A task starts where every task starts: the chat
                    // composer, with this project selected.
                    onNewWork={() => router.push(`/chat?project=${data.project.id}`)}
                  />
                )}
                {list === "code" && (
                  <ProjectCodeList
                    projectId={data.project.id}
                    sessions={codeSessions.map((c) => ({
                      id: c.id,
                      title: c.title,
                      lastMessageAt: c.lastMessageAt,
                      workspaceName: c.codeWorkspaceName ?? undefined,
                      workspacePath: c.codeWorkspacePath ?? undefined,
                    }))}
                    onNewCodeSession={() => router.push("/code")}
                  />
                )}
                {list === "artifacts" && <ArtifactList artifacts={projectArtifacts} />}
              </section>
            </div>
          </div>

          <div
            id="project-knowledge"
            tabIndex={-1}
            className={cn(
              "pj-workspace-context",
              dropping && "ring-2 ring-presence/60"
            )}
            onDragOver={(event) => {
              if (!isOwner || !event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDropping(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
            }}
            onDrop={(event) => {
              if (!isOwner || !event.dataTransfer.files.length) return;
              event.preventDefault();
              setDropping(false);
              void uploadFiles([...event.dataTransfer.files]);
            }}
          >
            <ProjectKnowledgePanel
              className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(1)}
              coverUrl={coverUrl}
              onPickCover={() => coverRef.current?.click()}
              onRemoveCover={removeCover}
              uploadingCover={uploadingCover}
              instructions={data.project.instructions}
              inherited={inherited}
              onEditInstructions={() => setInstructionsOpen(true)}
              files={knowledgeFiles}
              sources={sources}
              drive={drive}
              usage={usage}
              canEdit={isOwner}
              uploading={uploading}
              onUpload={() => fileRef.current?.click()}
              onAddFromLibrary={() => setLibraryOpen(true)}
              onAddFromDrive={() => setDriveOpen(true)}
              onDeleteFile={(fileId) => void deleteFile(fileId)}
              onSyncSource={(sourceId) => void syncSource(sourceId)}
              onRemoveSource={setSourceToRemove}
              onFixDrive={() => setDriveOpen(true)}
              memory={projectMemory}
              // Straight to this project's slice of the memory page, when it has one.
              onManageMemory={() =>
                router.push(
                  projectMemory && (projectMemory.activeCount > 0 || projectMemory.summary)
                    ? `/memory?project=${encodeURIComponent(id)}`
                    : "/memory"
                )
              }
            />
          </div>
        </div>
      </div>

      {view === "settings" && (
        <div className="motion-safe:animate-rise-in">
          <div className="mb-6">
            <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => openView("overview")}>
              <ArrowLeft className="size-4" aria-hidden="true" /> {data.project.name}
            </Button>
            <h1 className="app-page-title mt-2 text-page-title">Settings</h1>
          </div>
          <div className="max-w-3xl space-y-6">
            <SettingsGroup
              title="Instructions"
              description="Every chat, task and code session in this project follows them."
              action={
                <Button variant="outline" size="sm" onClick={() => setInstructionsOpen(true)}>
                  <Maximize2 className="size-3.5" />
                  Full editor
                </Button>
              }
              footer={
                <>
                  <span className="flex flex-wrap items-center gap-x-1 text-caption tabular-nums">
                    <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                      {instructions.length.toLocaleString()} characters
                      {nearInstructionsLimit ? " · a long prompt (the model’s context is the limit)" : ""}
                    </span>
                    <span className="text-muted-foreground">· Updated {timeAgo(data.project.updatedAt)}</span>
                  </span>
                  <Button size="sm" onClick={saveInstructions} disabled={!instructionsDirty || savingInstructions}>
                    {savingInstructions && <Loader2 className="size-3.5 animate-spin" />}
                    Save
                  </Button>
                </>
              }
            >
              <div className="px-4 pb-4">
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={`How should ${PRODUCT_NAME} work here? Its role, tone, and what to always or never do.`}
                  spellCheck={false}
                  aria-label="Project instructions"
                  className="min-h-[14rem] text-body leading-relaxed"
                />
              </div>
            </SettingsGroup>

            {/* Identity, model and tools in ONE group, because one Save
                writes all three (`saveWorkspace`). */}
            <SettingsGroup
              title="Identity and model"
              description={`What ${PRODUCT_NAME} is called here, and which model answers by default.`}
              footer={
                <>
                  <span />
                  <Button onClick={saveWorkspace} disabled={savingWorkspace} size="sm" className="gap-2">
                    {savingWorkspace && <Loader2 className="size-3.5 animate-spin" />}
                    Save
                  </Button>
                </>
              }
            >
              <SettingsRow label="Persona name">
                <Input
                  value={workspace.personaName ?? ""}
                  onChange={(event) =>
                    setWorkspace((current) => ({ ...current, personaName: event.target.value || undefined }))
                  }
                  placeholder={data.project.name}
                />
              </SettingsRow>
              <SettingsRow label="Preferred model">
                <Select
                  value={workspace.preferredModelId ?? "account-default"}
                  onValueChange={(value) =>
                    setWorkspace((current) => ({ ...current, preferredModelId: value === "account-default" ? undefined : value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="account-default">Account default</SelectItem>
                    {models
                      .filter((model) => model.modality === "chat")
                      .map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow label="Tools" as="div">
                <div className="flex min-h-9 items-center justify-between gap-4">
                  <p className="text-pretty text-ui text-muted-foreground">{`Narrow what ${PRODUCT_NAME} may reach for while answering here.`}</p>
                  <Switch
                    checked={workspace.allowedTools !== undefined}
                    onCheckedChange={(checked) =>
                      setWorkspace((current) => ({ ...current, allowedTools: checked ? [...WORKSPACE_TOOLS] : undefined }))
                    }
                    aria-label="Restrict assistant tools"
                    className="shrink-0"
                  />
                </div>
                {/* The list unfolds under the switch and goes `inert` with
                    it, so a row still on screen while the fold plays cannot
                    be toggled. */}
                <div className="contents" inert={workspace.allowedTools === undefined}>
                  <Collapse open={workspace.allowedTools !== undefined} className="-mx-1" innerClassName="px-1 pt-3">
                    <div className="divide-y divide-foreground/[.07] border-y border-foreground/[.07]">
                      {WORKSPACE_TOOLS.map((tool) => (
                        <label key={tool} className="flex min-h-11 items-center justify-between gap-4 py-2">
                          <span className="text-ui text-foreground">{WORKSPACE_TOOL_LABELS[tool]}</span>
                          <Switch
                            checked={workspace.allowedTools?.includes(tool) ?? false}
                            onCheckedChange={(checked) => setWorkspaceTool(tool, checked)}
                            aria-label={WORKSPACE_TOOL_LABELS[tool]}
                          />
                        </label>
                      ))}
                    </div>
                    <SettingsHint>
                      {`Restrictions narrow what is available while ${PRODUCT_NAME} answers in this project. They do not disconnect anything.`}
                    </SettingsHint>
                  </Collapse>
                </div>
              </SettingsRow>
            </SettingsGroup>

            <ProjectWorkDefaults
              value={workDefaults}
              onChange={setWorkDefaults}
              onSave={() => void saveWorkDefaults()}
              saving={savingWorkDefaults}
              dirty={JSON.stringify(serializeWorkDefaults(workDefaults)) !== JSON.stringify(serializeWorkDefaults(savedWorkDefaults))}
            />
          </div>
        </div>
      )}

      {/* The two hidden pickers live at page level: the knowledge panel, its
          empty state and the drop target all open the file picker, and the
          actions menu and the cover itself open the image picker. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          void uploadFiles(picked);
        }}
      />
      <input
        ref={coverRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadCover(f);
          e.target.value = "";
        }}
      />

      <ProjectDriveDialog
        open={driveOpen}
        onOpenChange={setDriveOpen}
        projectId={data.project.id}
        drive={drive}
        onAdded={(next) => setSources(next)}
      />
      <ProjectLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        projectId={data.project.id}
        existingNames={new Set(knowledgeFiles.map((f) => f.fileName))}
        onAdded={() => {
          void load();
          refreshKnowledgeAfterUpload();
        }}
      />

      <ProjectSheet
        open={sourceToRemove !== null}
        onOpenChange={(open) => !open && setSourceToRemove(null)}
        title={`Remove “${sourceToRemove?.name ?? ""}”?`}
        description={
          sourceToRemove?.kind === "folder"
            ? `Its ${sourceToRemove.fileCount.toLocaleString()} ${sourceToRemove.fileCount === 1 ? "file leaves" : "files leave"} this project’s knowledge and it stops syncing. Nothing changes in Google Drive.`
            : "It leaves this project’s knowledge and stops syncing. Nothing changes in Google Drive."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setSourceToRemove(null)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={removingSource} onClick={() => void removeSource()}>
              Remove
            </Button>
          </>
        }
      />

      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        project={data.project}
        parentName={crumbs[crumbs.length - 1]?.name}
        folderCount={folders.length}
        busy={deleteBusy}
        onConfirm={(mode) => void deleteProject(mode)}
      />

      <MoveToDialog
        open={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        subject={moving}
        projects={tree}
        busy={moveBusy}
        onConfirm={(target) => void confirmMove(target)}
      />

      <ProjectNameDialog
        open={folderDialog}
        onOpenChange={setFolderDialog}
        mode="folder"
        parentName={data.project.name}
        busy={folderBusy}
        onSubmit={(name) => void createFolder(name)}
      />

      <ProjectSheet
        open={chatToDelete !== null}
        onOpenChange={(open) => !open && setChatToDelete(null)}
        annot="Delete chat"
        title={`Delete “${chatToDelete?.title ?? ""}”?`}
        description={`Its messages are removed for good. Anything ${PRODUCT_NAME} made in it stays in your Library. This can’t be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setChatToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => chatToDelete && deleteChat(chatToDelete.id)}>
              Delete chat
            </Button>
          </>
        }
      />

      <ProjectInstructionsDialog
        open={instructionsOpen}
        projectName={data.project.name}
        value={instructions}
        onChange={setInstructions}
        dirty={instructionsDirty}
        saving={savingInstructions}
        inherited={inherited}
        onSave={() => void saveInstructionsAndClose()}
        onRequestClose={requestCloseInstructions}
        onOpen={() => setInstructionsOpen(true)}
      />

      {/* Sibling, not nested: two live focus traps fight each other, and this must
          be able to take focus while the instructions sheet is still open behind it. */}
      <ProjectSheet
        open={confirmDiscard}
        onOpenChange={(open) => !open && setConfirmDiscard(false)}
        annot="Unsaved instructions"
        title="Discard your changes?"
        description="These instructions haven’t been saved. Closing now loses what you wrote."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={discardInstructions}>
              Discard
            </Button>
          </>
        }
      />
    </AppPage>
  );
}

/** The artifacts made in this project's chats, each opening in place. */
function ArtifactList({ artifacts }: { artifacts: ProjectArtifactItem[] }) {
  if (!artifacts.length) {
    return (
      <p className="py-6 text-pretty text-ui text-muted-foreground">
        {`What ${PRODUCT_NAME} makes in this project’s chats (documents, apps, diagrams) collects here.`}
      </p>
    );
  }
  return (
    <ul className="-mx-2 space-y-px" aria-label="Artifacts">
      {artifacts.map((art, index) => (
        <li key={art.id} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]" style={staggerDelay(Math.min(index, 8))}>
          <Link
            href={artifactPath(art.id)}
            className="group flex w-full items-center gap-3 rounded-inner px-2 py-2 text-left transition-colors duration-fast ease-out-soft hover:bg-accent"
          >
            <AppIcons.artifacts className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-foreground">{art.title}</span>
              <span className="block text-caption text-muted-foreground">
                {ARTIFACT_NOUN[art.type as ArtifactType] ?? art.type}
                {art.updatedAt ? ` · ${timeAgo(art.updatedAt)}` : ""}
              </span>
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 coarse:opacity-100" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
