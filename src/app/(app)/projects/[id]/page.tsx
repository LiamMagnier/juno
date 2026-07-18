"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileCode,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Table,
  Trash2,
  TriangleAlert,
  Pin,
  MoreVertical,
  FolderClosed,
  FolderInput,
  X,
  NotebookPen,
  FileUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { formatBytes, formatTokens, cn } from "@/lib/utils";
import { useApp } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import type { ReasoningEffort } from "@/types/chat";

// Soft UI only — no save rejection. Warn when the draft is very large.
const INSTRUCTIONS_SOFT_WARN = 50_000;

interface Detail {
  project: { id: string; name: string; instructions: string; starred: boolean; updatedAt: string };
  conversations: { id: string; title: string; lastMessageAt: string; pinned: boolean }[];
  files: { id: string; fileName: string; mimeType: string; size: number; url: string; kind: string }[];
}

export default function ProjectDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { settings } = useApp();
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<"notfound" | "error" | null>(null);
  const [instructions, setInstructions] = React.useState("");
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  /** Guards an unsaved instructions draft against Escape / X / backdrop. */
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const coverRef = React.useRef<HTMLInputElement>(null);

  // Workspace tab state
  const [tab, setTab] = React.useState("overview");
  const [savingInstructions, setSavingInstructions] = React.useState(false);
  // Attachment ids uploaded this session — drive the cosmetic extraction progress bar.
  const [freshIds, setFreshIds] = React.useState<Set<string>>(new Set());
  const [dragging, setDragging] = React.useState(false);
  const dragDepth = React.useRef(0);

  // Server-backed project star (Project.starred), toggled optimistically.
  const [isStarred, setIsStarred] = React.useState(false);
  // User memories state
  const [memories, setMemories] = React.useState<{ id: string; content: string }[]>([]);
  // Store all projects for moving chats
  const [allProjects, setAllProjects] = React.useState<{ id: string; name: string }[]>([]);
  // Chat pending deletion — a real dialog, matching the project-delete confirm.
  const [chatToDelete, setChatToDelete] = React.useState<{ id: string; title: string } | null>(null);

  // Composer states. `null` model = not chosen yet → fall back to account default
  // without overwriting a pick the user already made (that overwrite was sending
  // every project chat to defaultModel / Kimi).
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort | null>("high");
  const [canvasEnabled, setCanvasEnabled] = React.useState(true);
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const projectModel = selectedModel ?? settings?.defaultModel ?? "anthropic:claude-sonnet-5";

  // Deep-link: /projects/{id}?tab=workspace
  React.useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "workspace") setTab("workspace");
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
    } catch {
      setError("error");
    }
  }, [id]);

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

  const clearFresh = React.useCallback((fileId: string) => {
    setFreshIds((cur) => {
      if (!cur.has(fileId)) return cur;
      const next = new Set(cur);
      next.delete(fileId);
      return next;
    });
  }, []);

  const saveName = () => {
    const name = nameDraft.trim();
    setEditingName(false);
    if (data && name && name !== data.project.name) {
      patch({ name });
      setData({ ...data, project: { ...data.project, name } });
      toast.success("Project renamed.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
    }
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
      setData((cur) => (cur ? { ...cur, files: [d.attachment, ...cur.files] } : cur));
      if (d.attachment?.id) setFreshIds((cur) => new Set(cur).add(d.attachment.id));
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

  // Drag-and-drop upload over the workspace files card.
  const onFilesDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onFilesDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  };
  const onFilesDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onFilesDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    for (const f of Array.from(e.dataTransfer.files)) await uploadFile(f);
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

  if (error === "notfound") {
    return <Centered title="Project not found" body="It may have been deleted." onBack={() => router.push("/projects")} />;
  }
  if (error === "error") {
    return <Centered title="Couldn’t load this project" body="Something went wrong." retry={load} onBack={() => router.push("/projects")} />;
  }
  if (!data) {
    // Mirrors the real header rhythm (eyebrow · title · meta) so the page doesn't
    // reflow when data lands.
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="skeleton mb-8 h-8 w-28 rounded-xl" />
        <div className="skeleton mb-3 h-3 w-20 rounded-sm" />
        <div className="skeleton mb-3 h-10 w-72 rounded-md" />
        <div className="skeleton mb-8 h-3 w-56 rounded-sm" />
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:gap-8">
          <div className="skeleton h-40 w-full rounded-lg" />
          <div className="skeleton h-64 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  const workspaceFiles = data.files.filter((f) => f.fileName !== "__cover__");
  const instructionsDirty = instructions !== data.project.instructions;
  const instructionLines = instructions ? instructions.split("\n").length : 0;
  const nearInstructionsLimit = instructions.length > INSTRUCTIONS_SOFT_WARN;
  const totalTokenEstimate = workspaceFiles.reduce(
    (sum, f) => sum + (isTextExtractable(f.mimeType) ? Math.round(f.size / 4) : 0),
    0
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/projects")}
          className="-ml-3 mb-6 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> All projects
        </Button>

        {/* Header — eyebrow · serif hero · mono meta. The old single 22px title had no
            supporting hierarchy, so it read as a form label on a 1152px page. */}
        <header className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <CardEyebrow>Project</CardEyebrow>
            {/* Type scale lives on the wrapper so the rename input inherits the hero
                metrics verbatim (text-[length:inherit]). Passing `text-display` into
                Input would be silently dead: twMerge reads custom type tokens as colour
                classes and keeps Input's `text-sm`, which wins on alphabetical order. */}
            <div className="mt-2 flex items-center gap-2 font-serif text-display">
              {editingName ? (
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  autoFocus
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  aria-label="Project name"
                  className="h-auto max-w-xl rounded-md px-2 py-0.5 text-[length:inherit]"
                />
              ) : (
                <>
                  <h1 className="truncate">{data.project.name}</h1>
                  <button
                    onClick={() => { setNameDraft(data.project.name); setEditingName(true); }}
                    className="pressable shrink-0 rounded-md p-1.5 text-base text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Rename project"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
            <p className="mt-2 font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground">
              {plural(data.conversations.length, "chat")} · {plural(workspaceFiles.length, "file")} · Updated{" "}
              {timeAgo(data.project.updatedAt)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleProjectStar}
              className="text-muted-foreground hover:text-foreground"
              aria-label={isStarred ? "Unpin project" : "Pin project"}
              aria-pressed={isStarred}
            >
              <Pin className={cn("h-4 w-4", isStarred && "fill-primary text-primary")} />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Project actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => { setNameDraft(data.project.name); setEditingName(true); }}>
                  <Pencil className="mr-2 h-4 w-4" />
                  <span>Rename project</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setInstructionsOpen(true)}>
                  <NotebookPen className="mr-2 h-4 w-4" />
                  <span>Edit instructions</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-destructive focus:bg-destructive focus:text-destructive-foreground">
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete project</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <Tabs value={tab} onValueChange={setTab}>
          {/* Radius/padding left to the primitive — its 14px track / 10px trigger pair is
              already concentric; the old rounded-2xl + rounded-xl override broke that. */}
          <TabsList className="mb-6">
            <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
            <TabsTrigger value="workspace" className="px-4">Workspace</TabsTrigger>
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

                {/* Conversations list */}
                <section>
                  <CardEyebrow className="mb-3 block">Chats in this project</CardEyebrow>
                  {data.conversations.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-12 text-center motion-safe:animate-rise-in">
                      <p className="font-serif text-heading">No chats yet</p>
                      <p className="mx-auto mt-1.5 max-w-sm text-body text-muted-foreground">
                        Ask a question in the composer above to start a conversation.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {data.conversations.map((c) => (
                        // relative + hover:z-10 — without it the next row's opaque bg-card
                        // paints straight over this row's lift shadow.
                        <li
                          key={c.id}
                          className="group relative flex items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 transition-[transform,border-color,box-shadow] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none"
                        >
                          <Link href={`/chat/${c.id}`} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md">
                            <span className="truncate text-body font-medium text-foreground">{c.title}</span>
                            <span className="font-mono text-caption text-muted-foreground">
                              Last message {timeAgo(c.lastMessageAt)}
                            </span>
                          </Link>

                          {/* opacity-0 alone leaves invisible-but-clickable controls in the
                              row; pointer-events follows visibility. Focus still reaches them. */}
                          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-fast pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 coarse:pointer-events-auto coarse:opacity-100 motion-reduce:transition-none">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => togglePin(c.id, c.pinned)}
                              aria-label={c.pinned ? "Unpin chat" : "Pin chat"}
                              aria-pressed={c.pinned}
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            >
                              <Pin className={cn("h-4 w-4", c.pinned && "fill-primary text-primary")} />
                            </Button>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Move chat to another project"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                >
                                  <FolderInput className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <p className="px-2 py-1.5 font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground">
                                  Move to project
                                </p>
                                <DropdownMenuSeparator />
                                {allProjects.filter((p) => p.id !== data.project.id).map((p) => (
                                  <DropdownMenuItem key={p.id} onSelect={() => moveChat(c.id, p.id)}>
                                    <FolderClosed className="mr-2 h-4 w-4" />
                                    <span className="truncate">{p.name}</span>
                                  </DropdownMenuItem>
                                ))}
                                <DropdownMenuItem onSelect={() => moveChat(c.id, null)}>
                                  <X className="mr-2 h-4 w-4" />
                                  <span>Remove from project</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>

                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setChatToDelete({ id: c.id, title: c.title })}
                              aria-label="Delete chat"
                              className="h-7 w-7 text-muted-foreground danger-hover"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              {/* Unified Project Sidebar (Right Column).
                  Card radius 24 − p-4 (16) = 8 → every inner surface is rounded-md. */}
              <div>
                <Card className="overflow-hidden">
                  {coverUrl ? (
                    <div className="group/cover relative h-32 w-full overflow-hidden border-b bg-muted">
                      <img src={coverUrl} className="h-full w-full object-cover" alt="" />
                      <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity duration-base ease-out-soft focus-within:opacity-100 group-hover/cover:opacity-100 motion-reduce:transition-none">
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
                      className="group flex h-24 w-full flex-col items-center justify-center border-b border-dashed bg-muted/20 transition-colors duration-fast ease-out-soft hover:bg-muted/40 motion-reduce:transition-none"
                    >
                      <Plus className="mb-1 h-5 w-5 text-muted-foreground/60 transition-transform duration-base ease-out-soft group-hover:scale-110 motion-reduce:transition-none" />
                      <span className="font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground">
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
                          <NotebookPen className="h-3.5 w-3.5 text-muted-foreground" />
                          <CardEyebrow>Memory</CardEyebrow>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground">
                            Only you
                          </span>
                          <button
                            onClick={() => router.push("/memory")}
                            className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label="Manage memories"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {memories.length === 0 ? (
                        <p className="text-caption leading-relaxed text-muted-foreground">
                          No memories saved yet. Juno builds memories across conversations.
                        </p>
                      ) : (
                        <ul className="max-h-[7.5rem] list-disc space-y-1.5 overflow-y-auto pl-4 pr-1 marker:text-muted-foreground/50">
                          {memories.slice(0, 3).map((m) => (
                            // truncate lives on the span: `overflow:hidden` on the li itself
                            // would clip the outside list marker away.
                            <li key={m.id} className="text-caption leading-relaxed text-muted-foreground">
                              <span className="block truncate">{m.content}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2.5 font-mono text-caption text-muted-foreground/70">Automatically updated</p>
                    </section>

                    {/* Instructions */}
                    <section className="py-5">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <CardEyebrow>Instructions</CardEyebrow>
                        <button
                          onClick={() => setInstructionsOpen(true)}
                          className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label="Edit project instructions"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {instructions ? (
                        <button
                          type="button"
                          onClick={() => setInstructionsOpen(true)}
                          className="block w-full rounded-md border border-border/60 bg-muted/30 p-2.5 text-left transition-[border-color,background-color] duration-fast ease-out-soft hover:border-border hover:bg-muted/50 motion-reduce:transition-none"
                        >
                          {/* Mono preview — it's a prompt, and the structure is the point. */}
                          <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted-foreground">
                            {instructions}
                          </p>
                          <p className="mt-2 font-mono text-caption text-muted-foreground/70">
                            {instructions.length.toLocaleString()} chars · {plural(instructionLines, "line")}
                          </p>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setInstructionsOpen(true)}
                          className="w-full rounded-md border border-dashed border-border/60 bg-muted/10 p-4 text-center transition-[border-color,background-color] duration-fast ease-out-soft hover:border-border hover:bg-muted/20 motion-reduce:transition-none"
                        >
                          <p className="text-caption leading-relaxed text-muted-foreground">
                            No instructions yet — add a prompt Juno follows in every chat here.
                          </p>
                        </button>
                      )}
                    </section>

                    {/* Files */}
                    <section className="pt-5">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <CardEyebrow>Files</CardEyebrow>
                        <button
                          onClick={() => fileRef.current?.click()}
                          disabled={uploading}
                          className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                          aria-label="Add file"
                        >
                          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
                        </button>
                      </div>
                      {workspaceFiles.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => fileRef.current?.click()}
                          className="w-full rounded-md border border-dashed border-border/60 bg-muted/10 p-5 text-center transition-[border-color,background-color] duration-fast ease-out-soft hover:border-border hover:bg-muted/20 motion-reduce:transition-none"
                        >
                          <FileUp className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
                          <p className="text-caption leading-relaxed text-muted-foreground">
                            Add PDFs, documents, or other text to reference in this project.
                          </p>
                        </button>
                      ) : (
                        // -m-1 p-1: the scroll box clips at its padding box, so the inset
                        // gives each row's lift shadow room instead of shearing it flat.
                        <ul className="-m-1 max-h-[15rem] space-y-1.5 overflow-y-auto p-1">
                          {workspaceFiles.map((f) => (
                            <li
                              key={f.id}
                              className="group/file relative flex items-center gap-2 rounded-md border border-border/60 bg-background/40 p-2 transition-[transform,border-color,box-shadow] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-soft motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none"
                            >
                              <a
                                href={f.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm"
                              >
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                                className="danger-hover h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-fast pointer-events-none group-hover/file:pointer-events-auto group-hover/file:opacity-100 group-focus-within/file:pointer-events-auto group-focus-within/file:opacity-100 coarse:pointer-events-auto coarse:opacity-100 motion-reduce:transition-none"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
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

          <TabsContent value="workspace" forceMount className="data-[state=inactive]:hidden">
            <div className="grid items-start gap-6 lg:grid-cols-2 lg:gap-8">
              {/* System instructions — inline editor */}
              <Card className="p-4">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardEyebrow>System instructions</CardEyebrow>
                    <h2 className="mt-1.5 font-serif text-heading">How Juno behaves in this project</h2>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInstructionsOpen(true)}
                    className="shrink-0 gap-1.5"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Full editor
                  </Button>
                </div>

                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="How should Juno behave? (role, tone, constraints…)"
                  spellCheck={false}
                  aria-label="Project instructions"
                  className="min-h-[18rem] rounded-md font-mono text-[13px] leading-relaxed"
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 font-mono text-caption">
                  {/* Colour set on a bare span: cn() would treat `text-caption` as a colour
                      class and drop it next to text-warning/text-muted-foreground. */}
                  <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                    {instructions.length.toLocaleString()} chars
                    {nearInstructionsLimit ? " · large prompt (context window is the limit)" : ""}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground/80">Updated {timeAgo(data.project.updatedAt)}</span>
                    <Button
                      size="sm"
                      onClick={saveInstructions}
                      disabled={!instructionsDirty || savingInstructions}
                      className="gap-1.5"
                    >
                      {savingInstructions && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/40 p-3 text-caption leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  <p>
                    These instructions are prepended to every chat in this project — Juno reads them
                    before your first message, alongside the referenced files.
                  </p>
                </div>
              </Card>

              {/* Referenced files — upload, extraction status, token estimates */}
              <Card
                className={cn(
                  "p-4 transition-[transform,border-color,background-color,box-shadow] duration-base ease-out-soft",
                  // Coral is the active/selected voice — a live drop target qualifies.
                  dragging && "border-primary/60 ring-2 ring-primary/20"
                )}
                onDragEnter={onFilesDragEnter}
                onDragOver={onFilesDragOver}
                onDragLeave={onFilesDragLeave}
                onDrop={onFilesDrop}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardEyebrow>Referenced files</CardEyebrow>
                    <p className="mt-1.5 font-mono text-caption text-muted-foreground">
                      ~{formatTokens(totalTokenEstimate)} tokens · {plural(workspaceFiles.length, "file")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="shrink-0 gap-1.5"
                  >
                    {uploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileUp className="h-3.5 w-3.5" />
                    )}
                    Add file
                  </Button>
                </div>

                {workspaceFiles.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="w-full rounded-md border border-dashed border-border/60 bg-muted/10 p-10 text-center transition-[border-color,background-color] duration-fast ease-out-soft hover:border-border hover:bg-muted/20 motion-safe:animate-rise-in motion-reduce:transition-none"
                  >
                    <FileUp className="mx-auto h-6 w-6 text-muted-foreground/50" />
                    <p className="mt-3 font-serif text-heading">No files yet</p>
                    <p className="mx-auto mt-1.5 max-w-xs text-body text-muted-foreground">
                      Drop files here or click to browse — Juno references them in every chat.
                    </p>
                  </button>
                ) : (
                  <ul className="space-y-2">
                    {workspaceFiles.map((f, i) => (
                      <WorkspaceFileRow
                        key={f.id}
                        file={f}
                        index={i}
                        fresh={freshIds.has(f.id)}
                        onDelete={() => deleteFile(f.id)}
                        onExtracted={clearFresh}
                      />
                    ))}
                  </ul>
                )}

                <p className="mt-3 font-mono text-caption text-muted-foreground/70">
                  Drag &amp; drop anywhere on this card to add files.
                </p>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

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
            <DialogTitle className="font-serif text-heading">Delete this project?</DialogTitle>
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
            <DialogTitle className="font-serif text-heading">Delete this chat?</DialogTitle>
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
            <DialogTitle className="mt-2 font-serif text-title">
              How Juno behaves in this project
            </DialogTitle>
            {/* No type token here: twMerge would read `text-body` as a colour and evict
                DialogDescription's own text-muted-foreground. */}
            <DialogDescription className="mt-1.5">
              Prepended to every chat here — Juno reads this before your first message, alongside the
              referenced files.
            </DialogDescription>
          </DialogHeader>

          {/* Panel radius 28 − p-5 (20) = 8 → the editor well is rounded-md. */}
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
              className="min-h-0 flex-1 resize-none rounded-md px-4 py-3.5 font-mono text-[13px] leading-relaxed"
            />
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-6 py-4">
            <div className="flex items-center gap-3 font-mono text-caption">
              <span className={nearInstructionsLimit ? "text-warning" : "text-muted-foreground"}>
                {instructions.length.toLocaleString()} chars
              </span>
              <span aria-hidden className="text-border">|</span>
              <span className="text-muted-foreground">{plural(instructionLines, "line")}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="hidden rounded-sm border border-border/60 bg-background px-1.5 py-0.5 font-mono text-caption text-muted-foreground sm:inline-block">
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
                {savingInstructions && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
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
    </div>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

// Mirrors the upload route's extraction rules: text-likes are inlined as tokens,
// PDFs are skipped (no text extraction), images are passed to the model as vision.
const CODE_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-yaml",
  "application/x-sh",
]);
const SHEET_MIMES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function isTextExtractable(mime: string): boolean {
  return mime.startsWith("text/") || CODE_MIMES.has(mime);
}

function fileIconFor(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (SHEET_MIMES.has(mime)) return Table;
  if (CODE_MIMES.has(mime) || mime === "text/markdown" || mime.startsWith("text/x-")) return FileCode;
  return FileText;
}

function WorkspaceFileRow({
  file,
  index,
  fresh,
  onDelete,
  onExtracted,
}: {
  file: Detail["files"][number];
  index: number;
  fresh: boolean;
  onDelete: () => void;
  onExtracted: (id: string) => void;
}) {
  const [extracting, setExtracting] = React.useState(fresh);
  const [barFull, setBarFull] = React.useState(false);

  // Cosmetic extraction pass on fresh uploads: bar fills over ~1.8s, then flips to the status pill.
  React.useEffect(() => {
    if (!fresh) return;
    const start = setTimeout(() => setBarFull(true), 50);
    const done = setTimeout(() => {
      setExtracting(false);
      onExtracted(file.id);
    }, 1900);
    return () => {
      clearTimeout(start);
      clearTimeout(done);
    };
  }, [fresh, file.id, onExtracted]);

  const isImage = file.mimeType.startsWith("image/");
  const extractable = isTextExtractable(file.mimeType);
  const Icon = fileIconFor(file.mimeType);

  return (
    <li
      className="group relative flex items-center gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2.5 transition-[transform,border-color,box-shadow] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-safe:animate-rise-in motion-reduce:transition-none [animation-fill-mode:backwards]"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <Icon className={cn("h-4 w-4 shrink-0", isImage ? "text-source" : "text-muted-foreground")} />

      <div className="min-w-0 flex-1">
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate rounded-sm text-body font-medium text-foreground"
        >
          {file.fileName}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-caption">
          <span className="text-muted-foreground">{formatBytes(file.size)}</span>
          {!extracting &&
            (extractable ? (
              <span className="inline-flex items-center rounded-full border bg-background/60 px-2 py-0.5 font-medium text-muted-foreground">
                ~{formatTokens(Math.round(file.size / 4))} tokens
              </span>
            ) : isImage ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-source/30 bg-background/60 px-2 py-0.5 font-medium text-source">
                <ImageIcon className="h-3 w-3" /> Visual
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-background/60 px-2 py-0.5 font-medium text-warning">
                <TriangleAlert className="h-3 w-3" /> No text extracted
              </span>
            ))}
        </div>
      </div>

      {extracting ? (
        <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted" aria-label="Extracting text">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[1800ms] ease-out-soft motion-reduce:transition-none"
            style={{ width: barFull ? "100%" : "0%" }}
          />
        </div>
      ) : extractable ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 px-2 py-0.5 font-mono text-caption font-medium text-success">
          <span className="size-1.5 rounded-full bg-success" /> Extracted
        </span>
      ) : isImage ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-source/30 px-2 py-0.5 font-mono text-caption font-medium text-source">
          <span className="size-1.5 rounded-full bg-source" /> Visual
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 px-2 py-0.5 font-mono text-caption font-medium text-warning">
          <span className="size-1.5 rounded-full bg-warning" /> Skipped
        </span>
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDelete}
        aria-label={`Remove ${file.fileName}`}
        className="danger-hover h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-fast pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 coarse:h-11 coarse:w-11 coarse:pointer-events-auto coarse:opacity-100 motion-reduce:transition-none"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function Centered({ title, body, onBack, retry }: { title: string; body: string; onBack: () => void; retry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center motion-safe:animate-rise-in">
      <p className="font-serif text-heading">{title}</p>
      <p className="text-body text-muted-foreground">{body}</p>
      <div className="mt-1 flex gap-2">
        {retry && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}
        <Button size="sm" onClick={onBack}>Back to projects</Button>
      </div>
    </div>
  );
}
