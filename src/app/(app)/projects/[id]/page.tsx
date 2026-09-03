"use client";

import { AppPage } from "@/components/app/app-page";
import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  FileText,
  FolderClosed,
  Loader2,
  Maximize2,
  Plus,
  NotebookPen,
  FileUp,
} from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardEyebrow } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { formatBytes } from "@/lib/utils";
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
import { ProjectWorkspaceHeader } from "@/components/projects/project-workspace-header";
import { ProjectChatList } from "@/components/projects/project-chat-list";
import { ProjectWorkList, type ProjectWorkItem } from "@/components/projects/project-work-list";
import { ProjectCodeList } from "@/components/projects/project-code-list";
import { ProjectSourcesList, type ProjectArtifactItem } from "@/components/projects/project-sources-list";

// Soft UI only — no save rejection. Warn when the draft is very large.
const INSTRUCTIONS_SOFT_WARN = 50_000;

interface Detail {
  project: { id: string; name: string; instructions: string; starred: boolean; updatedAt: string };
  conversations: { id: string; title: string; lastMessageAt: string; pinned: boolean }[];
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
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const coverRef = React.useRef<HTMLInputElement>(null);

  // Workspace tab state
  const [tab, setTab] = React.useState("overview");
  const [savingInstructions, setSavingInstructions] = React.useState(false);

  // Server-backed project star (Project.starred), toggled optimistically.
  const [isStarred, setIsStarred] = React.useState(false);
  // User memories state
  const [memories, setMemories] = React.useState<{ id: string; content: string }[]>([]);
  // Store all projects for moving chats
  const [allProjects, setAllProjects] = React.useState<{ id: string; name: string }[]>([]);
  // Chat pending deletion — a real dialog, matching the project-delete confirm.
  const [chatToDelete, setChatToDelete] = React.useState<{ id: string; title: string } | null>(null);
  const [workspace, setWorkspace] = React.useState<WorkspaceConfig>({});
  const [savingWorkspace, setSavingWorkspace] = React.useState(false);
  const [workRuns, setWorkRuns] = React.useState<ProjectWorkItem[]>([]);
  const [projectArtifacts, setProjectArtifacts] = React.useState<ProjectArtifactItem[]>([]);

  // Composer states. `null` model = not chosen yet → fall back to account default
  // without overwriting a pick the user already made (that overwrite was sending
  // every project chat to defaultModel / Kimi).
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort | null>("high");
  const [canvasEnabled, setCanvasEnabled] = React.useState(true);
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const projectModel = selectedModel ?? workspace.preferredModelId
    ?? settings?.defaultModel ?? "anthropic:claude-sonnet-5";

  // Deep-link: /projects/{id}?tab=workspace
  React.useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "workspace" || t === "assistant" || t === "work" || t === "code" || t === "sources" || t === "settings") {
      setTab(t === "workspace" || t === "assistant" ? "settings" : t);
    }
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

    // Fetch user memories
    fetch("/api/memory")
      .then((res) => res.json())
      .then((m) => {
        if (Array.isArray(m)) setMemories(m);
      })
      .catch(() => {});

    // Fetch all projects
    fetch("/api/projects")
      .then((res) => res.json())
      .then((p) => {
        if (p && Array.isArray(p.projects)) setAllProjects(p.projects);
      })
      .catch(() => {});

    // Fetch work runs
    fetch("/api/work?limit=50")
      .then((res) => res.json())
      .then((res) => {
        if (res && Array.isArray(res.sessions)) {
          const matching = res.sessions
            .filter((s: Record<string, unknown>) => s.projectId === id)
            .map((s: Record<string, unknown>) => ({
              id: String(s.id),
              title: String(s.title || ""),
              goal: String(s.goal || ""),
              status: s.status,
              updatedAt: String(s.updatedAt || ""),
              createdAt: String(s.createdAt || ""),
            }));
          setWorkRuns(matching);
        }
      })
      .catch(() => {});

    // Fetch artifacts
    fetch("/api/artifacts")
      .then((res) => res.json())
      .then((res) => {
        if (res && Array.isArray(res.artifacts)) {
          setProjectArtifacts(
            res.artifacts.map((a: Record<string, unknown>) => ({
              id: String(a.id),
              identifier: String(a.identifier || a.id),
              title: String(a.title || "Untitled Artifact"),
              type: String(a.type || "document"),
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
      toast.error("Could not update the project.");
      return;
    }
    setData((cur) => (cur ? { ...cur, project: { ...cur.project, starred: next } } : cur));
    toast.success(next ? "Project starred!" : "Project unstarred.");
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
      toast.error("Could not save the assistant settings.");
      return;
    }
    toast.success("Assistant settings synced.");
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
      toast.error("Couldn’t save — your text is still here. Check your connection and try again.");
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
      toast.error(err instanceof Error ? err.message : "Could not upload.");
    } finally {
      setUploading(false);
    }
  };

  const uploadCover = async (file: File) => {
    setUploading(true);
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
      toast.error(err instanceof Error ? err.message : "Could not upload cover image.");
    } finally {
      setUploading(false);
    }
  };

  const removeCover = async () => {
    const existingCover = data?.files.find((f) => f.fileName === "__cover__");
    if (!existingCover) return;
    setUploading(true);
    try {
      await fetch(`/api/attachments/${existingCover.id}`, { method: "DELETE" });
      setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.id !== existingCover.id) } : cur));
      toast.success("Cover image removed.");
    } catch {
      toast.error("Could not remove cover image.");
    } finally {
      setUploading(false);
    }
  };



  const deleteFile = async (fileId: string) => {
    const r = await fetch(`/api/attachments/${fileId}`, { method: "DELETE" });
    if (r.ok) {
      setData((cur) => (cur ? { ...cur, files: cur.files.filter((f) => f.id !== fileId) } : cur));
      toast.success("File removed from project.");
    } else {
      toast.error("Could not remove file.");
    }
  };

  const deleteProject = async () => {
    const r = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (r.ok) {
      window.dispatchEvent(new CustomEvent("projects:sync"));
      router.push("/projects");
    }
    else toast.error("Could not delete project.");
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
      toast.success(currentPinned ? "Chat unstarred." : "Chat starred!");
    } else {
      toast.error("Could not update chat.");
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
      toast.error("Could not delete chat.");
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
      toast.error("Could not move chat.");
    }
  };

  // Two terminal states, two tones. A missing project is not a failure the user
  // can retry away — it is an empty destination — while a failed load is, and only
  // the error tone gets the solid destructive fence and role="status".
  if (error === "notfound") {
    return (
      <div className="mx-auto flex size-full max-w-xl items-center px-4">
        <EmptyState
          className="w-full motion-safe:animate-rise-in"
          icon={FolderClosed}
          title="Project not found"
          description="It may have been deleted."
          action={
            <Button size="sm" asChild>
              <Link href="/projects">Back to projects</Link>
            </Button>
          }
        />
      </div>
    );
  }
  if (error === "error") {
    return (
      <div className="mx-auto flex size-full max-w-xl items-center px-4">
        <EmptyState
          tone="error"
          className="w-full motion-safe:animate-rise-in"
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
    );
  }
  if (!data) {
    // Mirrors the real header rhythm (eyebrow · title · meta) so the page doesn't
    // reflow when data lands.
    return (
      <AppPage measure="wide">
        <div className="skeleton mb-8 h-8 w-28 rounded-field" />
        <div className="skeleton mb-3 h-3 w-20 rounded-sm" />
        <div className="skeleton mb-3 h-10 w-72 rounded-md" />
        <div className="skeleton mb-8 h-3 w-56 rounded-sm" />
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:gap-8">
          <div className="skeleton h-40 w-full rounded-card" />
          <div className="skeleton h-64 w-full rounded-card" />
        </div>
      </AppPage>
    );
  }

  const workspaceFiles = data.files.filter((f) => f.fileName !== "__cover__");
  const instructionsDirty = instructions !== data.project.instructions;
  const instructionLines = instructions ? instructions.split("\n").length : 0;
  const nearInstructionsLimit = instructions.length > INSTRUCTIONS_SOFT_WARN;

  return (
    <AppPage measure="wide">
        {/* A real link, not router.push on a button: this one is not cmd- or
            middle-clickable and announces itself as a button. Same defect
            AppPageHeader's docblock item 2 exists to kill. */}
        <ProjectWorkspaceHeader
          project={data.project}
          stats={{
            chatCount: data.conversations.length,
            workCount: workRuns.length,
            codeCount: 0,
            fileCount: workspaceFiles.length,
            artifactCount: projectArtifacts.length,
          }}
          isStarred={isStarred}
          onToggleStar={toggleProjectStar}
          onEditInstructions={() => setInstructionsOpen(true)}
          onRename={async (name) => {
            await patch({ name });
            setData({ ...data, project: { ...data.project, name } });
            toast.success("Project renamed.");
            window.dispatchEvent(new CustomEvent("projects:sync"));
          }}
          onDelete={() => setDeleteOpen(true)}
        />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
            <TabsTrigger value="work" className="px-4">
              Work {workRuns.length > 0 && `(${workRuns.length})`}
            </TabsTrigger>
            <TabsTrigger value="code" className="px-4">
              Code
            </TabsTrigger>
            <TabsTrigger value="sources" className="px-4">
              Sources ({workspaceFiles.length + projectArtifacts.length})
            </TabsTrigger>
            <TabsTrigger value="settings" className="px-4">
              Settings
            </TabsTrigger>
          </TabsList>

          {/* Both tabs stay mounted (forceMount) so composer drafts and refs survive switching. */}
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
            <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:gap-8">
              {/* Main workspace (Left Column) */}
              <div className="min-w-0">
                <div className="mb-8">
                  <Composer
                    conversationId={null}
                    model={projectModel}
                    onModelChange={(m) => setSelectedModel(m)}
                    onSend={(text, _attachments, options) => handleSend(text, options)}
                    isBusy={false}
                    status="idle"
                    onStop={() => {}}
                    canvasEnabled={canvasEnabled}
                    onToggleCanvas={setCanvasEnabled}
                    reasoningEffort={reasoningEffort}
                    onReasoningChange={setReasoningEffort}
                    placeholder="How can I help you today?"
                  />
                </div>

                {/* Chats List in Project */}
                <section>
                  <CardEyebrow className="mb-3 block">Chats in this project</CardEyebrow>
                  <ProjectChatList
                    projectId={data.project.id}
                    conversations={data.conversations}
                    allProjects={allProjects}
                    onTogglePin={togglePin}
                    onMoveChat={moveChat}
                    onNewChat={() => {
                      router.push(`/chat?project=${id}`);
                    }}
                  />
                </section>
              </div>

              {/* Unified Project Sidebar (Right Column) */}
              <div>
                <Card className="overflow-hidden">
                  {coverUrl ? (
                    <div className="group/cover relative h-32 w-full overflow-hidden border-b bg-muted">
                      <img src={coverUrl} className="size-full object-cover" alt="" />
                      <div className="absolute inset-0 flex items-center justify-center gap-2 bg-scrim opacity-0 transition-opacity duration-base ease-out-soft focus-within:opacity-100 group-hover/cover:opacity-100 motion-reduce:transition-none coarse:opacity-100">
                        <Button variant="secondary" size="sm" onClick={() => coverRef.current?.click()}>
                          Change
                        </Button>
                        <Button variant="destructive" size="sm" onClick={removeCover}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => coverRef.current?.click()}
                      className="group flex h-24 w-full flex-col items-center justify-center border-b border-dashed bg-secondary transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                    >
                      <Plus className="mb-1 size-5 text-muted-foreground/60 transition-transform duration-base ease-out-soft group-hover:scale-110 motion-reduce:transition-none" />
                      <span className="font-mono text-caption text-muted-foreground">
                        Add project image
                      </span>
                    </button>
                  )}
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

                  <div className="divide-y divide-border/60 p-4">
                    {/* Memory */}
                    <section className="pb-5">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <NotebookPen className="size-3.5 text-muted-foreground" />
                          <CardEyebrow>Memory</CardEyebrow>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-caption text-muted-foreground">
                            Only you
                          </span>
                          <Pressable
                            kind="icon"
                            size="sm"
                            onClick={() => router.push("/memory")}
                            aria-label="Manage memories"
                          >
                            <ActionIcons.edit className="size-3.5" />
                          </Pressable>
                        </div>
                      </div>
                      {memories.length === 0 ? (
                        <p className="text-caption leading-relaxed text-muted-foreground">
                          No memories saved yet. Juno builds memories across conversations.
                        </p>
                      ) : (
                        <ul className="max-h-[7.5rem] list-disc space-y-1.5 overflow-y-auto pl-4 pr-1 marker:text-muted-foreground/50">
                          {memories.slice(0, 3).map((m) => (
                            <li key={m.id} className="text-caption leading-relaxed text-muted-foreground">
                              <span className="block truncate">{m.content}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2.5 font-mono text-caption text-muted-foreground/70">Automatically updated</p>
                    </section>

                    {/* Instructions Preview */}
                    <section className="py-5">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <CardEyebrow>Instructions</CardEyebrow>
                        <Pressable
                          kind="icon"
                          size="sm"
                          onClick={() => setInstructionsOpen(true)}
                          aria-label="Edit project instructions"
                        >
                          <ActionIcons.edit className="size-3.5" />
                        </Pressable>
                      </div>
                      {instructions ? (
                        <button
                          type="button"
                          onClick={() => setInstructionsOpen(true)}
                          className="block w-full rounded-field border border-border/60 bg-secondary p-2.5 text-left transition-[border-color,background-color] duration-fast ease-out-soft hover:border-border hover:bg-accent motion-reduce:transition-none"
                        >
                          <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted-foreground">
                            {instructions}
                          </p>
                          <p className="mt-2 font-mono text-caption text-muted-foreground/70">
                            {instructions.length.toLocaleString()} chars · {plural(instructionLines, "line")}
                          </p>
                        </button>
                      ) : (
                        <EmptyState
                          size="panel"
                          title="No instructions yet"
                          description="Add a prompt Juno follows in every chat in this project."
                          action={
                            <Button variant="outline" size="sm" onClick={() => setInstructionsOpen(true)}>
                              Add instructions
                            </Button>
                          }
                        />
                      )}
                    </section>

                    {/* Quick Files */}
                    <section className="pt-5">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <CardEyebrow>Sources</CardEyebrow>
                        <Pressable
                          kind="icon"
                          size="sm"
                          onClick={() => fileRef.current?.click()}
                          disabled={uploading}
                          aria-label="Add file"
                        >
                          {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-4" />}
                        </Pressable>
                      </div>
                      {workspaceFiles.length === 0 ? (
                        <EmptyState
                          size="panel"
                          icon={FileUp}
                          title="No files yet"
                          description="Add PDFs, documents, or data to ground answers."
                          action={
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => fileRef.current?.click()}
                              disabled={uploading}
                            >
                              Add file
                            </Button>
                          }
                        />
                      ) : (
                        <ul className="-m-1 max-h-[15rem] space-y-1.5 overflow-y-auto p-1">
                          {workspaceFiles.slice(0, 5).map((f) => (
                            <li
                              key={f.id}
                              className="group/file relative flex items-center gap-2 rounded-field border border-border/60 bg-secondary p-2 transition-[transform,border-color,box-shadow] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-soft motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none"
                            >
                              <a
                                href={f.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-xs"
                              >
                                <FileText className="size-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-caption font-medium text-foreground">{f.fileName}</p>
                                  <p className="font-mono text-caption text-muted-foreground">{formatBytes(f.size)}</p>
                                </div>
                              </a>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => deleteFile(f.id)}
                                aria-label={`Remove ${f.fileName}`}
                                className="danger-hover size-6 shrink-0 text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-fast pointer-events-none group-hover/file:pointer-events-auto group-hover/file:opacity-100 group-focus-within/file:pointer-events-auto group-focus-within/file:opacity-100 coarse:pointer-events-auto coarse:opacity-100 motion-reduce:transition-none"
                              >
                                <ActionIcons.delete className="size-3.5" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </div>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* Work Tab: Delegated Tasks */}
          <TabsContent value="work" forceMount className="data-[state=inactive]:hidden">
            <ProjectWorkList
              projectId={data.project.id}
              workRuns={workRuns}
              onNewWork={() => {
                router.push(`/work?project=${data.project.id}`);
              }}
            />
          </TabsContent>

          {/* Code Tab: Code Sessions */}
          <TabsContent value="code" forceMount className="data-[state=inactive]:hidden">
            <ProjectCodeList
              projectId={data.project.id}
              sessions={data.conversations
                .filter((c) => c.title.toLowerCase().includes("code") || c.title.toLowerCase().includes("repo"))
                .map((c) => ({
                  id: c.id,
                  title: c.title,
                  lastMessageAt: c.lastMessageAt,
                }))}
              onNewCodeSession={() => {
                router.push(`/code/new?project=${data.project.id}`);
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
                    <CardEyebrow>System instructions</CardEyebrow>
                    <h2 className="mt-1 font-serif text-heading text-foreground">How Juno behaves in this project</h2>
                    <p className="mt-1 text-body text-muted-foreground">
                      Prepended to every chat, work run, and code session in this project.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInstructionsOpen(true)}
                      className="gap-1.5"
                    >
                      <Maximize2 className="size-3.5" />
                      Full editor
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveInstructions}
                      disabled={!instructionsDirty || savingInstructions}
                      className="gap-1.5"
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
                  className="min-h-[16rem] font-mono text-sm leading-relaxed"
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 font-mono text-caption">
                  <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                    {instructions.length.toLocaleString()} chars
                    {nearInstructionsLimit ? " · large prompt (context window is the limit)" : ""}
                  </span>
                  <span className="text-muted-foreground/80">Updated {timeAgo(data.project.updatedAt)}</span>
                </div>
              </Card>

              {/* Assistant Configuration */}
              <div className="grid items-start gap-6 lg:grid-cols-2">
                <Card className="p-5">
                  <CardEyebrow>Identity & Model</CardEyebrow>
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
                      <Button onClick={saveWorkspace} disabled={savingWorkspace} size="sm" className="gap-2">
                        {savingWorkspace && <Loader2 className="size-3.5 animate-spin" />}
                        Save assistant defaults
                      </Button>
                    </div>
                  </div>
                </Card>

                <Card className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <CardEyebrow>Tools</CardEyebrow>
                      <p className="mt-1 text-body font-medium text-foreground">Restrict tools in this project</p>
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
                    />
                  </div>
                  {workspace.allowedTools !== undefined && (
                    <div className="mt-4 divide-y divide-border/70 border-y border-border/70">
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
                  )}
                  <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
                    Restrictions only narrow tools available during generation in this project context.
                  </p>
                </Card>
              </div>
            </div>
          </TabsContent>
        </Tabs>

      {/* Shared hidden file input — used by both tabs */}
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
            <DialogTitle className="mt-2 text-xl">
              How Juno behaves in this project
            </DialogTitle>
            {/* `text-body` is the prose rung this description wanted; DialogDescription
                itself only sets `text-sm`. It could not be passed until utils.ts
                registered the fontSize keys — twMerge read it as a colour and evicted the
                component's own text-muted-foreground. Both survive the merge now. */}
            <DialogDescription className="mt-1.5 text-body">
              Prepended to every chat here — Juno reads this before your first message, alongside the
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
              placeholder={"How should Juno behave? (role, tone, constraints…)\n\nPaste a full system prompt — headings, bullets and code fences all keep their shape."}
              spellCheck={false}
              autoFocus
              aria-label="Project instructions"
              // Monospace: this is a prompt, so alignment and indentation carry meaning.
              className="min-h-0 flex-1 resize-none px-4 py-3.5 font-mono text-sm leading-relaxed"
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
                className="gap-1.5"
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


