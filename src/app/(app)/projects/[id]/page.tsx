"use client";

import { AppPage } from "@/components/app/app-page";
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ImageOff, ImagePlus, Loader2, Maximize2 } from "@/components/ui/icons";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardEyebrow } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import type { KnowledgeIndexState } from "@/components/library/index-status";
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
import { ProjectOverviewRail, type RailProjectMemory } from "@/components/projects/project-overview-rail";
import { ProjectChatList } from "@/components/projects/project-chat-list";
import { ProjectWorkList, type ProjectWorkItem } from "@/components/projects/project-work-list";
import { ProjectCodeList } from "@/components/projects/project-code-list";
import { ProjectSourcesList, type ProjectArtifactItem } from "@/components/projects/project-sources-list";
import { madeInConversations } from "@/lib/artifact-links";

// Soft UI only — no save rejection. Warn when the draft is very large.
const INSTRUCTIONS_SOFT_WARN = 50_000;

/**
 * The tabs, and the `?tab=` values that reach them.
 *
 * `workspace` and `assistant` are older spellings of `settings` that people
 * may still hold in a bookmark, so they resolve rather than 404 into Overview.
 */
const TABS = ["overview", "work", "code", "sources", "settings"] as const;
type TabValue = (typeof TABS)[number];

const TAB_ALIASES: Record<string, TabValue> = { workspace: "settings", assistant: "settings" };

function parseTab(raw: string | null): TabValue | null {
  if (!raw) return null;
  if ((TABS as readonly string[]).includes(raw)) return raw as TabValue;
  return TAB_ALIASES[raw] ?? null;
}

interface Detail {
  project: {
    id: string;
    name: string;
    instructions: string;
    starred: boolean;
    updatedAt: string;
    /** What a Work task filed here inherits. `{}` for a project never asked. */
    workDefaults: WorkProjectDefaults;
  };
  conversations: {
    id: string;
    title: string;
    lastMessageAt: string;
    pinned: boolean;
    /** `"chat"` or `"code"` — see the Code tab below for why it is on the wire. */
    kind: string;
    codeWorkspaceName: string | null;
    codeWorkspacePath: string | null;
  }[];
  files: {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    url: string;
    kind: string;
    knowledge?: (KnowledgeIndexState & { documentId: string }) | null;
  }[];
  workspace: WorkspaceConfig;
}

const WORKSPACE_TOOL_LABELS: Record<WorkspaceTool, string> = {
  webSearch: "Web search",
  deepResearch: "Deep research",
  canvas: "Canvas",
  mediaGeneration: "Image & video",
  connectors: "Connected apps",
  memoryRecall: "Memory",
};

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
  /**
   * The cover's own busy flag.
   *
   * It used to share `uploading` with the source uploader, and the two are not
   * the same event to anyone watching: picking a project image put the Sources
   * section's add button into a spinner and disabled it, so the rail reported
   * that a file was being added to the project's knowledge when a decorative
   * picture was being replaced. Two independent actions, two flags.
   */
  const [uploadingCover, setUploadingCover] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const coverRef = React.useRef<HTMLInputElement>(null);

  // Workspace tab state
  const [tab, setTab] = React.useState<TabValue>("overview");
  const [savingInstructions, setSavingInstructions] = React.useState(false);

  // Server-backed project star (Project.starred), toggled optimistically.
  const [isStarred, setIsStarred] = React.useState(false);
  // This project's memory — its own summary and the facts learned in its
  // chats. null until it arrives; the rail holds its place meanwhile.
  const [projectMemory, setProjectMemory] = React.useState<RailProjectMemory | null>(null);
  // Store all projects for moving chats
  const [allProjects, setAllProjects] = React.useState<{ id: string; name: string }[]>([]);
  // Chat pending deletion — a real dialog, matching the project-delete confirm.
  const [chatToDelete, setChatToDelete] = React.useState<{ id: string; title: string } | null>(null);
  const [workspace, setWorkspace] = React.useState<WorkspaceConfig>({});
  const [savingWorkspace, setSavingWorkspace] = React.useState(false);
  /**
   * The Work bundle as the reader is editing it, beside what the server last
   * said.
   *
   * Two copies rather than one, for the same reason the instructions box keeps
   * a draft: the save button is enabled by the difference, and comparing the
   * draft against the loaded value is the only way to tell an unchanged form
   * from an edited one. Both sides go through `serializeWorkDefaults` before
   * they are compared, because that is what fixes the key order — a form that
   * set a field and unset it again would otherwise serialise the same settings
   * in a different order and read as edited for the rest of the session.
   */
  const [workDefaults, setWorkDefaults] = React.useState<WorkProjectDefaults>({});
  const [savedWorkDefaults, setSavedWorkDefaults] = React.useState<WorkProjectDefaults>({});
  const [savingWorkDefaults, setSavingWorkDefaults] = React.useState(false);
  const [workRuns, setWorkRuns] = React.useState<ProjectWorkItem[]>([]);
  /** The project's artifacts as the route found them, each with the chat it
   *  was made in. Kept whole and narrowed below, because the project's chats
   *  arrive from another request and can change while the page is open. */
  const [accountArtifacts, setAccountArtifacts] = React.useState<(ProjectArtifactItem & { conversationId: string })[]>([]);

  // Composer states. `null` model = not chosen yet → fall back to account default
  // without overwriting a pick the user already made (that overwrite was sending
  // every project chat to defaultModel / Kimi).
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort | null>("high");
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const projectModel = selectedModel ?? workspace.preferredModelId
    ?? settings?.defaultModel ?? "anthropic:claude-sonnet-5";

  // Deep-link in: /projects/{id}?tab=sources
  React.useEffect(() => {
    const t = parseTab(new URLSearchParams(window.location.search).get("tab"));
    if (t) setTab(t);
  }, []);

  /**
   * …and deep-link OUT, which is the half that was missing.
   *
   * `?tab=` was readable on arrival and never written, so the address bar said
   * Overview no matter which tab you were on: a reload dropped you back to the
   * first one, and a link copied from the Sources tab opened somewhere else for
   * whoever you sent it to. The tab is part of where you are, so it belongs in
   * the URL.
   *
   * `replaceState` rather than `router.replace`: this changes nothing the
   * server renders, and a route-level navigation for a local state change
   * remounts the tab panels — which would throw away the composer draft the
   * `forceMount` below exists to preserve. It is also deliberately not
   * `pushState`: Back should leave the project, not walk the reader back
   * through five tabs to get out of it.
   */
  const selectTab = React.useCallback((next: string) => {
    const value = parseTab(next);
    if (!value) return;
    setTab(value);
    const url = new URL(window.location.href);
    if (value === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", value);
    window.history.replaceState(null, "", url);
  }, []);

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
      // older than the one that wrote the column must draw the parts it
      // understands rather than a field it would ignore on save.
      const defaults = parseWorkDefaults(d.project.workDefaults);
      setWorkDefaults(defaults);
      setSavedWorkDefaults(defaults);
    } catch {
      setError("error");
    }
  }, [id]);

  const refreshKnowledgeAfterUpload = React.useCallback(() => {
    // These are bounded refreshes of the durable state machine, not a guessed
    // progress animation. If the background invocation was killed, the UI
    // stays at the honest queued/unknown state instead of claiming completion.
    for (const delay of [900, 2_500, 6_000]) {
      window.setTimeout(() => void load(), delay);
    }
  }, [load]);

  React.useEffect(() => {
    load();

    // This project's memory — never the account's. A chat here reads only
    // what was learned here, so that is what the rail shows.
    //
    // It used to fetch `/api/memory` and test the answer with `Array.isArray`,
    // but that route answers `{ memories, summary }` — so the rail was empty
    // for everyone, always. Had the test passed it would have been worse: the
    // whole account's facts, every other project's included, on this page.
    fetch(`/api/projects/${encodeURIComponent(id)}/memory`)
      .then((res) => (res.ok ? res.json() : null))
      .then((m: RailProjectMemory | null) => {
        setProjectMemory(
          m && Array.isArray(m.facts) ? m : { summary: null, facts: [], activeCount: 0 }
        );
      })
      .catch(() => setProjectMemory({ summary: null, facts: [], activeCount: 0 }));

    // Fetch all projects
    fetch("/api/projects")
      .then((res) => res.json())
      .then((p) => {
        if (p && Array.isArray(p.projects)) setAllProjects(p.projects);
      })
      .catch(() => {});

    // Fetch this project's delegated tasks.
    //
    // `/api/work/sessions?projectId=`, not `/api/work?limit=50`. There is no
    // route at `/api/work` — `src/app/api/work` holds only subdirectories — so
    // this tab has been silently empty for as long as it has existed: the fetch
    // 404d, `res.sessions` was undefined, and the `.catch` swallowed it. The
    // real route filters by project server-side, which is why the client-side
    // `.filter` on `projectId` is gone with it rather than kept as a belt.
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

    // This project's artifacts (X-21).
    //
    // The route answers `{ items }`, and this read `res.artifacts`, so the
    // Sources tab and the Overview count said zero for everyone, always. Had
    // the field matched it would have been worse: the fetch was the whole
    // account's list, so every other project's artifacts would have been
    // filed here too. The route scopes by `?projectId=` now, so the 200 it
    // answers are this project's own rather than the account's latest 200
    // narrowed after the fact. `projectArtifacts` below still keeps only the
    // ones from the chats on screen, so a chat moved out while the page is
    // open takes its artifacts with it without a refetch.
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
              conversationId: String(a.conversationId ?? ""),
              updatedAt: String(a.updatedAt || ""),
            }))
          );
        }
      })
      .catch(() => {});
  }, [load, id]);

  React.useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("juno:sync", refresh);
    return () => window.removeEventListener("juno:sync", refresh);
  }, [load]);

  /** The artifacts made in this project's chats. Derived rather than stored, so
   *  a chat moved out of the project (or deleted from it) takes its artifacts
   *  off this page the moment the list of chats changes, with no refetch. */
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
    // No success toast: the star fills under the pointer, which is the receipt.
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
    toast.success("Assistant settings synced.");
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
      // Nothing local is touched on a failure, so the draft the reader
      // assembled is still in front of them and the button is still enabled.
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
   * Throws on failure — including a network reject, which `fetch` raises rather
   * than resolving. It used to toast and return normally, so callers carried on
   * as if the write had landed: a failed instructions save reported success,
   * overwrote local state and closed the dialog, silently destroying a draft the
   * user may have spent real effort pasting in.
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
      // Keep the dialog open and the draft intact so the user can retry.
      toast.error("Couldn’t save. Your text is still here, so check your connection and try again.");
      return false;
    } finally {
      setSavingInstructions(false);
    }
  };

  // Save from the dialog. Closing via setInstructionsOpen (not onOpenChange) is what
  // keeps the just-saved draft from being discarded by `discardInstructions`.
  const saveInstructionsAndClose = async () => {
    // Only close on a confirmed write — closing after a failure would drop the
    // draft the error toast just told the user was safe.
    if (await saveInstructions()) setInstructionsOpen(false);
  };

  // `instructions` is one shared buffer — the sidebar preview and the Workspace inline
  // editor both read it. Dismissing the dialog has to restore the saved value, or an
  // abandoned draft keeps rendering elsewhere as if it were persisted.
  const discardInstructions = () => {
    setInstructions(data?.project.instructions ?? "");
    setInstructionsOpen(false);
    setConfirmDiscard(false);
  };

  /**
   * Every dismissal route — Escape, the X, the backdrop, Cancel — funnels through
   * here. Dismissing DISCARDS (the shared buffer above forces that), so with an
   * unsaved draft it must ask first: people paste long prompts in here and a stray
   * Escape silently destroying one is unacceptable.
   */
  const requestCloseInstructions = () => {
    // Computed here rather than reusing `instructionsDirty`, which is declared
    // below the early returns — this handler must not depend on that ordering.
    if (instructions !== (data?.project.instructions ?? "")) {
      setConfirmDiscard(true);
      return;
    }
    discardInstructions();
  };

  const handleSend = (text: string, options?: { deepResearch?: boolean }) => {
    const q = text.trim();
    if (!q) return;
    // Carry the composer model through the /chat hand-off. Without `model=`,
    // NewChatPage always seeds ChatView with the account default (e.g. Kimi).
    const params = new URLSearchParams({
      project: id,
      q,
      model: projectModel,
    });
    if (reasoningEffort) params.set("reasoning", reasoningEffort);
    if (options?.deepResearch) params.set("research", "1");
    router.push(`/chat?${params.toString()}`);
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("projectId", id);
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Upload failed.");
      setData((cur) =>
        cur
          ? {
              ...cur,
              files: [
                {
                  ...d.attachment,
                  knowledge: {
                    documentId: "pending",
                    state: "queued",
                    error: null,
                    pageCount: null,
                    blockCount: 0,
                  },
                },
                ...cur.files,
              ],
            }
          : cur
      );
      refreshKnowledgeAfterUpload();
      toast.success("File added to project.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t upload.");
    } finally {
      setUploading(false);
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
        return { ...cur, files: [d.attachment, ...cleanFiles] };
      });
      toast.success("Project cover image updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t upload cover image.");
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
      toast.success("Cover image removed.");
    } catch {
      toast.error("Couldn’t remove cover image.");
    } finally {
      setUploadingCover(false);
    }
  };



  const deleteFile = async (fileId: string) => {
    const r = await fetch(`/api/attachments/${fileId}`, { method: "DELETE" });
    if (r.ok) {
      setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.id !== fileId) } : cur));
      toast.success("File removed from project.");
    } else {
      toast.error("Couldn’t remove file.");
    }
  };

  const deleteProject = async () => {
    const r = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (r.ok) {
      window.dispatchEvent(new CustomEvent("projects:sync"));
      router.push("/projects");
    }
    else toast.error("Couldn’t delete project.");
  };

  // Quick Action: Star chat
  const togglePin = async (chatId: string, currentPinned: boolean) => {
    const r = await fetch(`/api/conversations/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !currentPinned }),
    });
    if (r.ok) {
      setData((cur) => {
        if (!cur) return null;
        return {
          ...cur,
          conversations: cur.conversations.map((c) =>
            c.id === chatId ? { ...c, pinned: !currentPinned } : c
          ),
        };
      });
      toast.success(currentPinned ? "Chat unstarred." : "Chat starred.");
    } else {
      toast.error("Couldn’t update chat.");
    }
  };

  // Quick Action: Delete chat
  const deleteChat = async (chatId: string) => {
    setChatToDelete(null);
    const r = await fetch(`/api/conversations/${chatId}`, { method: "DELETE" });
    if (r.ok) {
      setData((cur) => {
        if (!cur) return null;
        return {
          ...cur,
          conversations: cur.conversations.filter((c) => c.id !== chatId),
        };
      });
      toast.success("Chat deleted.");
    } else {
      toast.error("Couldn’t delete chat.");
    }
  };

  // Quick Action: Move chat
  const moveChat = async (chatId: string, targetProjectId: string | null) => {
    const r = await fetch(`/api/conversations/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: targetProjectId }),
    });
    if (r.ok) {
      setData((cur) => {
        if (!cur) return null;
        return {
          ...cur,
          conversations: cur.conversations.filter((c) => c.id !== chatId),
        };
      });
      const targetProjectName = targetProjectId
        ? allProjects.find((p) => p.id === targetProjectId)?.name ?? "another project"
        : "no project";
      toast.success(`Chat moved to ${targetProjectName}.`);
    } else {
      toast.error("Couldn’t move chat.");
    }
  };

  // Two terminal states, two tones. A missing project is not a failure the user
  // can retry away — it is an empty destination — while a failed load is, and only
  // the error tone gets the solid destructive fence and role="status".
  //
  // Both sit inside the same <AppPage> frame as the loading and loaded branches,
  // so they take the product's one gutter from `.app-page-content` (16 / 24 / 32,
  // keyed to the column). They used to return a bare <div> with a hand-rolled
  // `px-4`, which meant two of this route's three states indented 16px while the
  // third indented up to 32. The centred, capped treatment is kept through
  // `contentClassName` and an inner `max-w-xl` column.
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
    // Literally the same component the route's own loading.tsx renders, not a
    // second drawing of it — see ProjectPageSkeleton's header for what the two
    // hand-copied versions had drifted into.
    return (
      <AppPage measure="wide" role="status" aria-label="Loading project">
        <ProjectPageSkeleton />
      </AppPage>
    );
  }

  const workspaceFiles = data.files.filter((f) => f.fileName !== "__cover__");
  const instructionsDirty = instructions !== data.project.instructions;
  const instructionLines = instructions ? instructions.split("\n").length : 0;
  const nearInstructionsLimit = instructions.length > INSTRUCTIONS_SOFT_WARN;

  /**
   * Chats and Code sessions are two different kinds of conversation, and the
   * column that says which is `kind`.
   *
   * This page used to decide by searching the TITLE for "code" or "repo". So
   * every real Code session was listed twice — once here, once in the Chats
   * list, which counted it — any chat whose title happened to contain either
   * word was filed as a code session, and the workspace a session actually
   * belongs to, the one fact the Code list exists to show, was not available
   * to show. `kind` has been on the Conversation model the whole time; it is
   * on the wire now (see the GET in api/projects/[id]/route.ts).
   */
  const chats = data.conversations.filter((c) => c.kind !== "code");
  const codeSessions = data.conversations.filter((c) => c.kind === "code");
  const sourceCount = workspaceFiles.length + projectArtifacts.length;

  return (
    <AppPage measure="wide">
        {/* A real link, not router.push on a button: this one is not cmd- or
            middle-clickable and announces itself as a button. Same defect
            AppPageHeader's docblock item 2 exists to kill. */}
        <ProjectWorkspaceHeader
          project={data.project}
          stats={{
            chatCount: chats.length,
            workCount: workRuns.length,
            codeCount: codeSessions.length,
            fileCount: workspaceFiles.length,
            artifactCount: projectArtifacts.length,
          }}
          isStarred={isStarred}
          onToggleStar={toggleProjectStar}
          onEditInstructions={() => setInstructionsOpen(true)}
          onRename={async (name) => {
            await patch({ name });
            // Renamed in place, under the reader's eye; no toast.
            setData({ ...data, project: { ...data.project, name } });
            window.dispatchEvent(new CustomEvent("projects:sync"));
          }}
          onDelete={() => setDeleteOpen(true)}
          /* The cover's home. It was a 96px dashed slab at the head of the
             Overview rail — the first thing the eye met on the page, offering
             the one action here that changes nothing about how the project
             answers. A rare verb belongs with the other rare verbs. */
          menuExtras={
            <>
              <DropdownMenuItem
                disabled={uploadingCover}
                onSelect={() => coverRef.current?.click()}
              >
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
          }
        />

        <Tabs value={tab} onValueChange={selectTab}>
          {/* One count treatment, on every tab that has something to count.
              This row used to spell it three ways at once — "Tasks (3)" only
              above zero, "Sources (0)" always including the literal zero, and
              Code never, whatever it held. Three spellings of one idea in five
              triggers, which is what a reader registers as "assembled" long
              before they could say why.

              The scroller is the narrow-width behaviour: an inline-flex track
              with five triggers in it has nowhere to go under ~30rem, so it was
              compressing the labels. It scrolls now, and `-mx-*`/`px-*` let the
              first and last trigger reach the column's own edge rather than
              sitting inside a second margin. */}
          <div className="-mx-1 mb-6 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {/* Tasks and Code are shown when they hold something, or when a
                  link (`?tab=work`, `?tab=code`) has opened them. Every project
                  used to carry five tabs from its first minute, two of them
                  empty lists, so a new project opened as a form to fill in
                  rather than a place to start; the chat that makes a task or a
                  code session is on Overview, and the tab arrives with the
                  first thing it has to list.

                  "Tasks", not "Work". The value stays `work` because `?tab=work`
                  is a URL somebody can hold; the label says what the tab lists. */}
              {(workRuns.length > 0 || tab === "work") && (
                <TabsTrigger value="work">
                  Tasks
                  <TabCount value={workRuns.length} />
                </TabsTrigger>
              )}
              {(codeSessions.length > 0 || tab === "code") && (
                <TabsTrigger value="code">
                  Code
                  <TabCount value={codeSessions.length} />
                </TabsTrigger>
              )}
              <TabsTrigger value="sources">
                Sources
                <TabCount value={sourceCount} />
              </TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
          </div>

          {/* Both tabs stay mounted (forceMount) so composer drafts and refs survive switching. */}
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
            {/* The split starts at the top, and the composer is INSIDE it.

                It spanned the whole column for one version, which put the
                rail's first eyebrow a composer's height below the field and
                drew the field itself at ~960px wide by ~100px tall — a
                letterbox, and the widest object on the page for a box most
                people type one sentence into. A text field's proportions are
                part of how much it invites you to write in it.

                In the left column it is ~690px at the same height, and the
                rail's top edge is level with the field's, so Instructions and
                Sources are the first things beside what you type rather than
                a scroll below it.

                The composer keeps `frame="inline"` (see composer.tsx), which
                is what makes this position work at all: its dock chrome
                supplies its own `.page-gutter`, so inside an already-guttered
                page column it used to indent a further 16–32px on both edges
                and its left edge never agreed with the eyebrow directly
                beneath it.

                Keyed to the COLUMN, not the window (PREMIUM_AUDIT §2b): the
                sidebar takes 256px of the window until the width where it
                starts floating and then stops taking it, so a `lg:` here —
                which is what this grid used — split the page at a window size
                that says nothing about how much room this page actually
                got. */}
            <div className="grid items-start gap-6 @4xl/page:grid-cols-[minmax(0,1fr)_19rem] @4xl/page:gap-8">
              <div className="min-w-0">
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
                  /* The project's own name in the prompt, where it fits. A
                     composer on a project page asking "How can I help you
                     today?" is the same sentence the account's home composer
                     asks, on a surface whose whole content is that this is not
                     that. Long names fall back rather than filling the field
                     with a title the reader can already see above it. */
                  placeholder={
                    data.project.name.length <= 32
                      ? `Ask anything about ${data.project.name}…`
                      : "Ask anything about this project…"
                  }
                />

                <section className="mt-8">
                  {/* `min-h-7` is the rail's section-header height, so this
                      eyebrow sits on the rail's own header grid. No count
                      beside it: the tab above carries one and the list's own
                      toolbar carries "N of M" 40px below, and three counts of
                      the same thing on one screen is how a page stops being
                      read. */}
                  <div className="mb-3 flex min-h-7 items-center">
                    <CardEyebrow>Chats in this project</CardEyebrow>
                  </div>
                  <ProjectChatList
                    projectId={data.project.id}
                    conversations={chats}
                    allProjects={allProjects}
                    onTogglePin={togglePin}
                    onMoveChat={moveChat}
                    onDeleteChat={(chat) => setChatToDelete({ id: chat.id, title: chat.title })}
                    onNewChat={() => {
                      router.push(`/chat?project=${id}`);
                    }}
                  />
                </section>
              </div>

              <ProjectOverviewRail
                coverUrl={coverUrl}
                onPickCover={() => coverRef.current?.click()}
                onRemoveCover={removeCover}
                uploadingCover={uploadingCover}
                instructions={instructions}
                onEditInstructions={() => setInstructionsOpen(true)}
                files={workspaceFiles}
                fileCount={sourceCount}
                onAddFile={() => fileRef.current?.click()}
                onDeleteFile={deleteFile}
                onViewAllSources={() => selectTab("sources")}
                uploading={uploading}
                memory={projectMemory}
                // Straight to this project's slice of the memory page. With
                // nothing remembered yet there is no slice to open, so the page
                // opens whole rather than on a scope it would fall back from.
                onManageMemory={() =>
                  router.push(
                    projectMemory && (projectMemory.activeCount > 0 || projectMemory.summary)
                      ? `/memory?project=${encodeURIComponent(id)}`
                      : "/memory"
                  )
                }
              />
            </div>
          </TabsContent>

          {/* Work Tab: Delegated Tasks */}
          <TabsContent value="work" forceMount className="data-[state=inactive]:hidden">
            <ProjectWorkList
              projectId={data.project.id}
              workRuns={workRuns}
              onNewWork={() => {
                // A new task starts where every task starts now: the chat
                // composer, with this project already selected. There is no
                // Work composer to send anyone to.
                router.push(`/chat?project=${data.project.id}`);
              }}
            />
          </TabsContent>

          {/* Code Tab: Code Sessions */}
          <TabsContent value="code" forceMount className="data-[state=inactive]:hidden">
            <ProjectCodeList
              projectId={data.project.id}
              sessions={codeSessions.map((c) => ({
                id: c.id,
                title: c.title,
                lastMessageAt: c.lastMessageAt,
                workspaceName: c.codeWorkspaceName ?? undefined,
                workspacePath: c.codeWorkspacePath ?? undefined,
              }))}
              onNewCodeSession={() => {
                // `/code` — the Code composer is the landing now, and
                // `/code/new` only redirects here. The `?project=` this used to
                // append was never read by anything on the other end, so it is
                // dropped rather than carried through a bounce; a project does
                // not name a checkout, which is what that composer asks for.
                router.push("/code");
              }}
            />
          </TabsContent>

          {/* Sources Tab: Files & Artifacts */}
          <TabsContent value="sources" forceMount className="data-[state=inactive]:hidden">
            <ProjectSourcesList
              projectId={data.project.id}
              files={data.files}
              artifacts={projectArtifacts}
              onUploadClick={() => fileRef.current?.click()}
              /* The well has drawn "Drop files here" for as long as it has
                 existed and had nothing to drop onto: `onDropFiles` is what
                 arms the handlers, and no caller passed it, so the label was
                 a promise the page could not keep. Sequential rather than
                 parallel — `uploadFile` owns the one `uploading` flag, and
                 concurrent writes to it would leave the spinner stuck on
                 after the first of them finished. */
              onDropFiles={async (dropped) => {
                for (const file of dropped) await uploadFile(file);
              }}
              onDeleteFile={deleteFile}
              uploading={uploading}
            />
          </TabsContent>

          {/* Settings Tab: Instructions & Assistant Configuration */}
          <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
            <div className="space-y-6">
              {/* Instructions Editor */}
              <Card className="p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/* Eyebrow and one body line, the shape the Tools card
                        beside it uses. There was an h2 between them — "How
                        Juno behaves in this project" — which is the eyebrow's
                        own gloss; the line that carries new information is
                        the one saying where the text is injected. */}
                    <CardEyebrow>System instructions</CardEyebrow>
                    <p className="mt-1 text-body text-muted-foreground">
                      Prepended to every chat, work run, and code session in this project.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInstructionsOpen(true)}
                    >
                      <Maximize2 className="size-3.5" />
                      Full editor
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveInstructions}
                      disabled={!instructionsDirty || savingInstructions}
                    >
                      {savingInstructions && <Loader2 className="size-3.5 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>

                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="How should Juno behave? (role, tone, constraints…)"
                  spellCheck={false}
                  aria-label="Project instructions"
                  className="min-h-[16rem] font-mono text-body leading-relaxed"
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 font-mono text-caption">
                  <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                    {instructions.length.toLocaleString()} chars
                    {nearInstructionsLimit ? " · large prompt (context window is the limit)" : ""}
                  </span>
                  <span className="text-muted-foreground">Updated {timeAgo(data.project.updatedAt)}</span>
                </div>
              </Card>

              {/* Assistant Configuration. `@4xl/page`, not `lg:` — the split
                  has to happen when this COLUMN is wide enough to hold two
                  cards, and the window width says nothing about that while
                  the sidebar is taking 256px of it (PREMIUM_AUDIT §2b). */}
              <div className="grid items-start gap-6 @4xl/page:grid-cols-2">
                <Card className="p-5">
                  {/* The same two-line head the card beside it and the
                      instructions card above it open with: eyebrow, then one
                      line saying what the controls under it do. This card had
                      the eyebrow alone, so of the three cards on the tab, two
                      explained themselves and one did not. */}
                  <div className="min-h-9">
                    <CardEyebrow>Identity and model</CardEyebrow>
                    <p className="mt-1 text-body text-muted-foreground">
                      What Juno is called here, and which model answers by default.
                    </p>
                  </div>
                  <div className="mt-4 space-y-4">
                    <label className="block space-y-2">
                      <span className="text-body font-medium text-foreground">Persona name</span>
                      <Input
                        value={workspace.personaName ?? ""}
                        onChange={(event) =>
                          setWorkspace((current) => ({
                            ...current,
                            personaName: event.target.value || undefined,
                          }))
                        }
                        placeholder={data.project.name}
                      />
                    </label>
                    <label className="block space-y-2">
                      <span className="text-body font-medium text-foreground">Preferred model</span>
                      <Select
                        value={workspace.preferredModelId ?? "account-default"}
                        onValueChange={(value) =>
                          setWorkspace((current) => ({
                            ...current,
                            preferredModelId: value === "account-default" ? undefined : value,
                          }))
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
                    </label>
                    <div className="pt-2">
                      {/* "Save", like the other two on this tab. Each card is
                          plainly labelled and each button sits inside the card
                          it saves, so "Save assistant defaults" was naming its
                          own container — and naming it differently from the
                          two buttons doing the identical job beside it. */}
                      <Button onClick={saveWorkspace} disabled={savingWorkspace} size="sm" className="gap-2">
                        {savingWorkspace && <Loader2 className="size-3.5 animate-spin" />}
                        Save
                      </Button>
                    </div>
                  </div>
                </Card>

                <Card className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    {/* `min-h-9` on both cards' heads, and the same two rungs
                        of type in the same order, so the first control in each
                        card starts on the same line when they sit side by
                        side. The body line here was `font-medium
                        text-foreground` against the other card's muted
                        description — one of the two was a second title. */}
                    <div className="min-h-9 min-w-0">
                      <CardEyebrow>Tools</CardEyebrow>
                      <p className="mt-1 text-body text-muted-foreground">
                        Narrow what Juno may reach for while answering here.
                      </p>
                    </div>
                    <Switch
                      checked={workspace.allowedTools !== undefined}
                      onCheckedChange={(checked) =>
                        setWorkspace((current) => ({
                          ...current,
                          allowedTools: checked ? [...WORKSPACE_TOOLS] : undefined,
                        }))
                      }
                      aria-label="Restrict assistant tools"
                      className="mt-0.5 shrink-0"
                    />
                  </div>
                  {/* The list unfolds under the switch and folds back the
                      same way when it is switched off (ICONS_AND_MOTION §2.2
                      rule 6), where it used to vanish in a frame. The wrapper
                      goes `inert` with the switch, so a row still on screen
                      while the fold plays cannot be toggled — a press there
                      would put the restriction back — and Collapse unmounts
                      the rows after. The gutter (`-mx-1` out, `px-1` back in)
                      keeps the switches' focus outlines inside the fold's clip. */}
                  <div className="contents" inert={workspace.allowedTools === undefined}>
                    <Collapse
                      open={workspace.allowedTools !== undefined}
                      className="-mx-1"
                      innerClassName="px-1 pt-4"
                    >
                      <div className="divide-y divide-border/70 border-y border-border/70">
                        {WORKSPACE_TOOLS.map((tool) => (
                          <label key={tool} className="flex min-h-11 items-center justify-between gap-4 py-2">
                            <span className="text-body text-foreground">{WORKSPACE_TOOL_LABELS[tool]}</span>
                            <Switch
                              checked={workspace.allowedTools?.includes(tool) ?? false}
                              onCheckedChange={(checked) => setWorkspaceTool(tool, checked)}
                              aria-label={WORKSPACE_TOOL_LABELS[tool]}
                            />
                          </label>
                        ))}
                      </div>
                      {/* Under the list, and only when there IS one. With the
                          switch off there is no restriction to qualify, and the
                          card's own description two lines up already says what the
                          switch does — so this was a third sentence explaining the
                          same control to a reader who had not used it yet. It
                          folds with the list it qualifies. */}
                      <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
                        Restrictions narrow what is available while Juno generates in this project.
                        They do not disconnect anything.
                      </p>
                    </Collapse>
                  </div>
                </Card>
              </div>

              {/* Full width rather than a third cell in the grid above: this is
                  the only card here whose rows are a list that grows with the
                  account's connected apps, and a two-column cell would set it
                  in a column half the width of the list it has to show. */}
              <ProjectWorkDefaults
                value={workDefaults}
                onChange={setWorkDefaults}
                onSave={() => void saveWorkDefaults()}
                saving={savingWorkDefaults}
                dirty={
                  JSON.stringify(serializeWorkDefaults(workDefaults)) !==
                  JSON.stringify(serializeWorkDefaults(savedWorkDefaults))
                }
              />
            </div>
          </TabsContent>
        </Tabs>

      {/* The two hidden pickers, at page level rather than inside a tab panel:
          the source picker is opened from the Overview rail, the Sources tab
          and the rail's empty state, and the cover picker from the header's
          actions menu and from the cover itself. A picker owned by one of
          those places would stop working the moment that place was not the one
          asking. */}
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadFile(f);
          e.target.value = "";
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

      {/* Delete Project Confirm Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this project?</DialogTitle>
            <DialogDescription>
              Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={deleteProject}>Delete project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Chat Confirm Dialog — replaces window.confirm(), which was the only
          native-modal holdout on the page. */}
      <Dialog open={chatToDelete !== null} onOpenChange={(open) => !open && setChatToDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this chat?</DialogTitle>
            <DialogDescription>
              “{chatToDelete?.title}” and its messages are removed for good. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setChatToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => chatToDelete && deleteChat(chatToDelete.id)}>
              Delete chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project instructions — a real editing surface. People paste multi-hundred-line
          system prompts here, so the dialog owns a fixed tall frame (clamped by
          DialogContent's max-h) and the textarea takes every pixel left between the
          header and the status bar. */}
      <Dialog open={instructionsOpen} onOpenChange={(open) => (open ? setInstructionsOpen(true) : requestCloseInstructions())}>
        <DialogContent
          // `overflow-hidden` evicts DialogContent's own overflow-y-auto (twMerge) —
          // the textarea, not the dialog, must be the scroll container.
          className="flex h-[46rem] max-w-3xl flex-col gap-0 overflow-hidden p-0"
          // Backdrop clicks are ignored outright while dirty — an accidental click
          // shouldn't even cost a confirm. Escape and X are deliberate, so they
          // route through the confirm instead of being swallowed (a dead Escape
          // key reads as a broken dialog).
          onInteractOutside={(e) => {
            if (instructionsDirty) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!instructionsDirty) return;
            e.preventDefault();
            setConfirmDiscard(true);
          }}
        >
          <DialogHeader className="shrink-0 space-y-0 border-b border-border/60 px-6 py-5 pr-14 text-left">
            <CardEyebrow>Project instructions</CardEyebrow>
            <DialogTitle className="mt-2 text-title">
              How Juno behaves in this project
            </DialogTitle>
            {/* `text-body` is the prose rung this description wanted; DialogDescription
                itself only sets `text-ui`. It could not be passed until utils.ts
                registered the fontSize keys — twMerge read it as a colour and evicted the
                component's own text-muted-foreground. Both survive the merge now. */}
            <DialogDescription className="mt-1.5 text-body">
              Prepended to every chat here. Juno reads this before your first message, alongside the
              referenced files.
            </DialogDescription>
          </DialogHeader>

          {/* The arithmetic this comment used to state — "panel radius 28 − p-5
              (20) = 8" — no longer describes anything: the dialog is rounded-panel
              (18) since the ladder landed, so 18 − 20 leaves no concentric
              constraint at all and the well simply takes Textarea's own
              rounded-field. */}
          <div className="flex min-h-0 flex-1 flex-col p-5">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void saveInstructionsAndClose();
                }
              }}
              placeholder={"How should Juno behave? (role, tone, constraints…)\n\nPaste a full system prompt. Headings, bullets and code fences all keep their shape."}
              spellCheck={false}
              autoFocus
              aria-label="Project instructions"
              // Monospace: this is a prompt, so alignment and indentation carry meaning.
              className="min-h-0 flex-1 resize-none px-4 py-3.5 font-mono text-body leading-relaxed"
            />
          </div>

          {/* bg-secondary, not bg-muted/30. The dialog is an overlay-glass panel at
              the popover rung, so 30% of a 9.5% token over 13% landed the footer a
              point DARKER than the panel — a recess nobody asked for and nobody
              could see. Inside a floating layer the recessed rung is --secondary. */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-secondary px-6 py-4">
            <div className="flex items-center gap-3 font-mono text-caption">
              <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                {instructions.length.toLocaleString()} chars
              </span>
              <span aria-hidden className="text-border">|</span>
              <span className="text-muted-foreground">{plural(instructionLines, "line")}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* bg-accent, not bg-background: a key cap has to read as RAISED, and
                  --background inside a floating dialog is pure black on dark — 13
                  points below the panel, i.e. a hole in the footer rather than a
                  key sitting on it. */}
              <kbd className="hidden rounded-xs border border-border/60 bg-accent px-1.5 py-0.5 font-mono text-caption text-muted-foreground sm:inline-block">
                ⌘↵
              </kbd>
              <Button variant="ghost" size="sm" onClick={requestCloseInstructions}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={saveInstructionsAndClose}
                disabled={!instructionsDirty || savingInstructions}
              >
                {savingInstructions && <Loader2 className="size-3.5 animate-spin" />}
                Save instructions
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Sibling, not nested: two live focus traps fight each other, and this must
          be able to take focus while the instructions dialog is still open behind it. */}
      <Dialog open={confirmDiscard} onOpenChange={(open) => !open && setConfirmDiscard(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              These instructions haven’t been saved. Closing now loses what you wrote.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={discardInstructions}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * How many things are behind a tab, said the same way on every tab that has
 * an answer.
 *
 * Quieter than the label it trails and never bracketed: a count is metadata
 * about the tab, not part of its name, and parentheses inside a control's
 * label read as an aside rather than as a number. Withheld at zero on every
 * tab, so "Sources" with nothing in it and "Code" with nothing in it look
 * alike — which they are.
 */
function TabCount({ value }: { value: number }) {
  if (!value) return null;
  return (
    <span className="font-mono text-caption tabular-nums text-muted-foreground">
      {value.toLocaleString()}
    </span>
  );
}


