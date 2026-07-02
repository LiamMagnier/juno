"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  FileCode,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  Pencil,
  Plus,
  Table,
  Trash2,
  TriangleAlert,
  Star,
  MoreVertical,
  FolderClosed,
  FolderInput,
  X,
  Brain,
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

interface Detail {
  project: { id: string; name: string; instructions: string; updatedAt: string };
  conversations: { id: string; title: string; lastMessageAt: string; pinned: boolean }[];
  files: { id: string; fileName: string; mimeType: string; size: number; url: string; kind: string }[];
}

export default function ProjectDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { settings, setSettings, features } = useApp();
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<"notfound" | "error" | null>(null);
  const [instructions, setInstructions] = React.useState("");
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
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

  // Mocks / client-side project star
  const [isStarred, setIsStarred] = React.useState(false);
  // User memories state
  const [memories, setMemories] = React.useState<{ id: string; content: string }[]>([]);
  // Store all projects for moving chats
  const [allProjects, setAllProjects] = React.useState<{ id: string; name: string }[]>([]);

  // Composer states
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort | null>("high");
  const [canvasEnabled, setCanvasEnabled] = React.useState(true);
  const [selectedModel, setSelectedModel] = React.useState<string>("claude-opus-4-8");

  React.useEffect(() => {
    if (settings?.defaultModel) {
      setSelectedModel(settings.defaultModel);
    }
  }, [settings?.defaultModel]);

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
    if (data?.project.id) {
      const starred = JSON.parse(localStorage.getItem("starredProjects") || "[]");
      setIsStarred(starred.includes(data.project.id));
    }
  }, [data?.project.id]);

  const toggleProjectStar = () => {
    if (!data?.project.id) return;
    const starred = JSON.parse(localStorage.getItem("starredProjects") || "[]");
    let nextStarred;
    if (starred.includes(data.project.id)) {
      nextStarred = starred.filter((pId: string) => pId !== data.project.id);
      setIsStarred(false);
      toast.success("Project unstarred.");
    } else {
      nextStarred = [...starred, data.project.id];
      setIsStarred(true);
      toast.success("Project starred!");
    }
    localStorage.setItem("starredProjects", JSON.stringify(nextStarred));
    window.dispatchEvent(new CustomEvent("starred:sync"));
  };

  const patch = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) toast.error("Could not save.");
  };

  const saveInstructions = () => {
    if (data && instructions !== data.project.instructions) {
      patch({ instructions });
      setData({ ...data, project: { ...data.project, instructions } });
      toast.success("Project instructions saved.");
    }
  };

  const saveInstructionsInline = async () => {
    if (!data || instructions === data.project.instructions || savingInstructions) return;
    setSavingInstructions(true);
    try {
      await patch({ instructions });
      setData({ ...data, project: { ...data.project, instructions, updatedAt: new Date().toISOString() } });
      toast.success("Project instructions saved.");
    } finally {
      setSavingInstructions(false);
    }
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

  const handleSend = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const reasoning = reasoningEffort ? `&reasoning=${reasoningEffort}` : "";
    router.push(`/chat?project=${id}&q=${encodeURIComponent(q)}${reasoning}`);
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
      const starred = JSON.parse(localStorage.getItem("starredProjects") || "[]");
      const nextStarred = starred.filter((pId: string) => pId !== id);
      localStorage.setItem("starredProjects", JSON.stringify(nextStarred));
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
    if (!confirm("Are you sure you want to delete this chat?")) return;
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
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <div className="skeleton mb-4 h-8 w-48 rounded-lg" />
        <div className="skeleton h-40 w-full rounded-lg" />
      </div>
    );
  }

  const workspaceFiles = data.files.filter((f) => f.fileName !== "__cover__");
  const instructionsDirty = instructions !== data.project.instructions;
  const totalTokenEstimate = workspaceFiles.reduce(
    (sum, f) => sum + (isTextExtractable(f.mimeType) ? Math.round(f.size / 4) : 0),
    0
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/projects")} className="mb-4 gap-1.5 text-muted-foreground hover:bg-accent/40">
          <ArrowLeft className="h-4 w-4" /> All projects
        </Button>

        {/* Title / Action bar */}
        <div className="mb-6 flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
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
                      className="max-w-md font-serif text-title focus-visible:ring-1"
                    />
                  ) : (
                    <h1 className="font-serif text-title font-medium truncate">{data.project.name}</h1>
                  )}
                  {!editingName && (
                    <button
                      onClick={() => { setNameDraft(data.project.name); setEditingName(true); }}
                      className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Rename project"
                      title="Rename project"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* Project star */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleProjectStar}
                  className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                  title={isStarred ? "Unstar project" : "Star project"}
                >
                  <Star className={cn("h-4 w-4", isStarred ? "fill-primary text-primary" : "")} />
                </Button>

                {/* Project actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                      title="Project actions"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => { setNameDraft(data.project.name); setEditingName(true); }}>
                      <Pencil className="h-4 w-4 mr-2" />
                      <span>Rename project</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-destructive focus:bg-destructive focus:text-destructive-foreground">
                      <Trash2 className="h-4 w-4 mr-2" />
                      <span>Delete project</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-6 rounded-2xl bg-muted/70 p-1">
            <TabsTrigger value="overview" className="rounded-xl px-4">Overview</TabsTrigger>
            <TabsTrigger value="workspace" className="rounded-xl px-4">Workspace</TabsTrigger>
          </TabsList>

          {/* Both tabs stay mounted (forceMount) so composer drafts and refs survive switching. */}
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          {/* Main workspace (Left Column) */}
          <div className="min-w-0">
            {/* Premium Composer */}
            <div className="mb-8">
              <Composer
                conversationId={null}
                model={selectedModel as any}
                onModelChange={(m) => setSelectedModel(m)}
                onSend={(text) => handleSend(text)}
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
            <div>
              <CardEyebrow className="mb-3 block text-muted-foreground/80 tracking-widest font-mono text-[10px] uppercase">
                Chats in this project
              </CardEyebrow>
              {data.conversations.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center motion-safe:animate-rise-in">
                  <p className="font-serif text-heading">No chats yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ask a question in the composer above to start a conversation.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {data.conversations.map((c) => (
                    <div
                      key={c.id}
                      className="group relative flex items-center justify-between rounded-xl hover:bg-accent transition-colors duration-fast"
                    >
                      <Link href={`/chat/${c.id}`} className="flex flex-1 flex-col gap-0.5 px-3 py-2.5 pr-28">
                        <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                          {c.title}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Last message {timeAgo(c.lastMessageAt)}
                        </span>
                      </Link>

                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100 transition-opacity duration-fast">
                        {/* Star/Pin */}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => togglePin(c.id, c.pinned)}
                          title={c.pinned ? "Unstar chat" : "Star chat"}
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                        >
                          <Star className={cn("h-4 w-4", c.pinned ? "fill-primary text-primary" : "")} />
                        </Button>

                        {/* Move Project */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Move chat"
                              className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                            >
                              <FolderInput className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <span className="block px-2 py-1.5 text-xs font-semibold text-muted-foreground/80">Move to project:</span>
                            <DropdownMenuSeparator />
                            {allProjects.filter((p) => p.id !== data.project.id).map((p) => (
                              <DropdownMenuItem key={p.id} onSelect={() => moveChat(c.id, p.id)}>
                                <FolderClosed className="h-4 w-4 mr-2" />
                                <span className="truncate">{p.name}</span>
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onSelect={() => moveChat(c.id, null)}>
                              <X className="h-4 w-4 mr-2" />
                              <span>Remove from project</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Delete Chat */}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteChat(c.id)}
                          title="Delete chat"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Unified Project Sidebar (Right Column) */}
          <div className="space-y-4">
            <Card className="bg-card border shadow-soft overflow-hidden">
              {/* Cover Image Banner */}
              {coverUrl ? (
                <div className="relative h-32 w-full group/cover overflow-hidden bg-muted border-b">
                  <img src={coverUrl} className="h-full w-full object-cover" alt="Cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/cover:opacity-100 focus-within:opacity-100 transition-opacity duration-base ease-out-soft flex items-center justify-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2.5 text-xs rounded-md"
                      onClick={() => coverRef.current?.click()}
                    >
                      Change
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7 px-2.5 text-xs rounded-md"
                      onClick={removeCover}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => coverRef.current?.click()}
                  className="group relative h-24 w-full bg-muted/20 border-b border-dashed flex flex-col items-center justify-center cursor-pointer hover:bg-muted/30 transition-colors duration-fast ease-out-soft"
                >
                  <Plus className="h-5 w-5 text-muted-foreground/60 mb-1 group-hover:scale-110 transition-transform duration-base ease-out-soft" />
                  <span className="text-[10px] text-muted-foreground/80 font-medium">Add project image</span>
                </div>
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

              <div className="p-4 divide-y divide-border/40">
                {/* Memory Section */}
                <div className="pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Brain className="h-4 w-4 text-primary" />
                      <span className="font-serif text-sm font-semibold">Memory</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase font-mono tracking-wider">Only you</span>
                      <button
                        onClick={() => router.push("/memory")}
                        className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Manage memories"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {memories.length === 0 ? (
                    <p className="text-xs text-muted-foreground/80 leading-relaxed italic">
                      No memories saved yet. Juno builds memories across conversations.
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-[120px] overflow-y-auto pr-1">
                      {memories.slice(0, 3).map((m) => (
                        <p key={m.id} className="text-xs text-muted-foreground/90 leading-relaxed truncate">
                          • {m.content}
                        </p>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[10px] text-muted-foreground/60">Automatically updated</p>
                </div>

                {/* Instructions Section */}
                <div className="py-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-serif text-sm font-semibold">Instructions</span>
                    <button
                      onClick={() => setInstructionsOpen(true)}
                      className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Edit instructions"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {instructions ? (
                    <p className="text-xs text-muted-foreground/90 leading-relaxed line-clamp-4 italic bg-muted/30 border border-border/40 rounded-lg p-2">
                      {instructions}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 leading-relaxed italic">
                      No instructions set. Injected into every chat here.
                    </p>
                  )}
                </div>

                {/* Files Section */}
                <div className="pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-serif text-sm font-semibold">Files</span>
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="pressable rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Add file"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </button>
                  </div>
                  {data.files.filter((f) => f.fileName !== "__cover__").length === 0 ? (
                    <div
                      className="rounded-2xl border border-dashed border-border/60 bg-muted/10 p-5 text-center transition-colors duration-fast ease-out-soft hover:bg-muted/20 cursor-pointer"
                      onClick={() => fileRef.current?.click()}
                    >
                      <FileUp className="mx-auto h-6 w-6 text-muted-foreground/60 mb-2" />
                      <p className="text-xs text-muted-foreground leading-normal">
                        Add PDFs, documents, or other text to reference in this project.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
                      {data.files.filter((f) => f.fileName !== "__cover__").map((f) => (
                        <li key={f.id} className="group/file flex items-center justify-between gap-2 rounded-xl border bg-card p-2 hover:bg-accent transition-colors duration-fast ease-out-soft">
                          <a
                            href={f.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex flex-1 items-center gap-2 min-w-0"
                          >
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-foreground">{f.fileName}</p>
                              <p className="text-[10px] text-muted-foreground">{formatBytes(f.size)}</p>
                            </div>
                          </a>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => deleteFile(f.id)}
                            className="h-6 w-6 rounded-md text-muted-foreground hover:text-destructive opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 coarse:opacity-100 transition-opacity duration-fast"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          </div>
        </div>
          </TabsContent>

          <TabsContent value="workspace" forceMount className="data-[state=inactive]:hidden">
            <div className="grid items-start gap-6 lg:grid-cols-2">
              {/* System instructions — inline editor */}
              <Card className="p-6">
                <CardEyebrow className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                  System instructions
                </CardEyebrow>
                <h2 className="mt-1.5 font-serif text-heading">How Juno behaves in this project</h2>

                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="How should Juno behave? (role, tone, constraints…)"
                  maxLength={20_000}
                  className="mt-4 min-h-40 rounded-xl text-sm"
                />
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
                  <span
                    className={cn(
                      "font-mono text-caption",
                      instructions.length > 18_000 ? "text-warning" : "text-muted-foreground"
                    )}
                  >
                    {instructions.length.toLocaleString()} / 20,000
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-caption text-muted-foreground/80">
                      Updated {timeAgo(data.project.updatedAt)}
                    </span>
                    <Button
                      size="sm"
                      onClick={saveInstructionsInline}
                      disabled={!instructionsDirty || savingInstructions}
                      className="gap-1.5 rounded-xl"
                    >
                      {savingInstructions && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-xl bg-muted/40 p-3.5 text-caption text-muted-foreground leading-relaxed">
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
                  "p-6 transition-all duration-base ease-out-soft",
                  dragging && "border-primary/60 ring-2 ring-primary/20"
                )}
                onDragEnter={onFilesDragEnter}
                onDragOver={onFilesDragOver}
                onDragLeave={onFilesDragLeave}
                onDrop={onFilesDrop}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardEyebrow className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      Referenced files
                    </CardEyebrow>
                    <p className="mt-1.5 font-mono text-caption text-muted-foreground">
                      ~{formatTokens(totalTokenEstimate)} tokens · {workspaceFiles.length}{" "}
                      {workspaceFiles.length === 1 ? "file" : "files"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="shrink-0 gap-1.5 rounded-xl"
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
                  <div
                    className="cursor-pointer rounded-lg border border-dashed border-border/60 bg-muted/10 p-10 text-center transition-colors duration-fast ease-out-soft hover:bg-muted/20 motion-safe:animate-rise-in"
                    onClick={() => fileRef.current?.click()}
                  >
                    <FileUp className="mx-auto h-6 w-6 text-muted-foreground/50" />
                    <p className="mt-3 font-serif text-heading">No files yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Drop files here or click to browse — Juno references them in every chat.
                    </p>
                  </div>
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

                <p className="mt-3 text-caption text-muted-foreground/70">
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
            <DialogTitle className="font-serif">Delete this project?</DialogTitle>
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

      {/* Edit Instructions Dialog */}
      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-heading">Project instructions</DialogTitle>
            <DialogDescription>
              How should Juno behave in this project? These instructions are automatically injected into all chats.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="How should Juno behave? (role, tone, constraints…)"
            className="min-h-[200px] text-sm rounded-md mt-2"
            maxLength={20_000}
          />
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setInstructionsOpen(false)}>Cancel</Button>
            <Button onClick={() => { saveInstructions(); setInstructionsOpen(false); }}>Save instructions</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
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
      className="group flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 transition-colors duration-fast hover:bg-accent/40 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <Icon className={cn("h-4 w-4 shrink-0", isImage ? "text-source" : "text-muted-foreground")} />

      <div className="min-w-0 flex-1">
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-sm font-medium text-foreground transition-colors hover:text-primary"
        >
          {file.fileName}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-caption text-muted-foreground">{formatBytes(file.size)}</span>
          {!extracting &&
            (extractable ? (
              <span className="inline-flex items-center rounded-full border bg-background/60 px-2 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                ~{formatTokens(Math.round(file.size / 4))} tokens
              </span>
            ) : isImage ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-source/30 bg-background/60 px-2 py-0.5 text-[10px] font-medium text-source">
                <ImageIcon className="h-3 w-3" /> Visual
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-background/60 px-2 py-0.5 text-[10px] font-medium text-warning">
                <TriangleAlert className="h-3 w-3" /> No text extracted
              </span>
            ))}
        </div>
      </div>

      {extracting ? (
        <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted" aria-label="Extracting text">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[1800ms] ease-out-soft"
            style={{ width: barFull ? "100%" : "0%" }}
          />
        </div>
      ) : extractable ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 px-2 py-0.5 text-caption font-medium text-success">
          <span className="size-1.5 rounded-full bg-success" /> Extracted
        </span>
      ) : isImage ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-source/30 px-2 py-0.5 text-caption font-medium text-source">
          <span className="size-1.5 rounded-full bg-source" /> Visual
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 px-2 py-0.5 text-caption font-medium text-warning">
          <span className="size-1.5 rounded-full bg-warning" /> Skipped
        </span>
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDelete}
        title="Remove file"
        className="h-7 w-7 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-within:opacity-100 group-hover:opacity-100 coarse:h-11 coarse:w-11 coarse:opacity-100"
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
      <p className="text-sm text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        {retry && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}
        <Button size="sm" onClick={onBack}>Back to projects</Button>
      </div>
    </div>
  );
}
