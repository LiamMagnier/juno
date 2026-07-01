"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Trash2,
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
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { formatBytes, cn } from "@/lib/utils";
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/projects")} className="mb-4 gap-1.5 text-muted-foreground hover:bg-accent/40">
          <ArrowLeft className="h-4 w-4" /> All projects
        </Button>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          {/* Main workspace (Left Column) */}
          <div className="min-w-0">
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
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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
                <div className="rounded-xl border-2 border-dashed border-border/60 bg-muted/5 px-6 py-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    No chats yet. Ask a question in the composer above to start a conversation.
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

                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
            <Card className="rounded-[24px] bg-card border shadow-soft overflow-hidden">
              {/* Cover Image Banner */}
              {coverUrl ? (
                <div className="relative h-32 w-full group/cover overflow-hidden bg-muted border-b">
                  <img src={coverUrl} className="h-full w-full object-cover" alt="Cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/cover:opacity-100 transition-opacity flex items-center justify-center gap-2">
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
                  className="group relative h-24 w-full bg-muted/20 border-b border-dashed flex flex-col items-center justify-center cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  <Plus className="h-5 w-5 text-muted-foreground/60 mb-1 group-hover:scale-110 transition-transform" />
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
                        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Add file"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </button>
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
                  </div>
                  {data.files.filter((f) => f.fileName !== "__cover__").length === 0 ? (
                    <div 
                      className="rounded-xl border-2 border-dashed border-border/60 bg-muted/10 p-5 text-center transition-colors hover:bg-muted/20 cursor-pointer" 
                      onClick={() => fileRef.current?.click()}
                    >
                      <FileUp className="mx-auto h-6 w-6 text-muted-foreground/75 mb-2 animate-bounce" style={{ animationDuration: "2.5s" }} />
                      <p className="text-xs text-muted-foreground leading-normal">
                        Add PDFs, documents, or other text to reference in this project.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
                      {data.files.filter((f) => f.fileName !== "__cover__").map((f) => (
                        <li key={f.id} className="group/file flex items-center justify-between gap-2 rounded-lg border bg-card p-2 hover:bg-accent transition-colors">
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
                            className="h-6 w-6 rounded-md text-muted-foreground hover:text-destructive opacity-0 group-hover/file:opacity-100 transition-opacity"
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
      </div>

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

function Centered({ title, body, onBack, retry }: { title: string; body: string; onBack: () => void; retry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-serif text-heading">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        {retry && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}
        <Button size="sm" onClick={onBack}>Back to projects</Button>
      </div>
    </div>
  );
}
