"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  AudioLines,
  Blocks,
  Box,
  Brain,
  Check,
  FileText,
  FileUp,
  Globe,
  LayoutTemplate,
  Library,
  Loader2,
  Mic,
  Plug,
  Plus,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelSelector } from "@/components/chat/model-selector";
import { LibraryPicker } from "@/components/chat/library-picker";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { PLANS } from "@/lib/plans";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useApp } from "@/components/app/app-provider";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { formatBytes, cn } from "@/lib/utils";
import type { ModelId } from "@/lib/models";
import type { ClientAttachment, GenerationStatus, ReasoningEffort } from "@/types/chat";

interface ComposerProps {
  conversationId: string | null;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
  onSend: (text: string, attachments: ClientAttachment[]) => void;
  isBusy: boolean;
  status: GenerationStatus;
  onStop: () => void;
  onOpenVoiceMode?: () => void;
  quotaReached?: boolean;
  canvasEnabled: boolean;
  onToggleCanvas: (v: boolean) => void;
  webSearchEnabled?: boolean;
  onToggleWebSearch?: (v: boolean) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningChange: (e: ReasoningEffort | null) => void;
  connectorsEnabled?: string[];
  onToggleConnector?: (id: string) => void;
  placeholder?: string;
  privateMode?: boolean;
  hideDisclaimer?: boolean;
  // The project this chat is filed under. For a brand-new chat (no conversation
  // yet) this is the project the next message will be created in.
  selectedProjectId?: string | null;
  onPickProject?: (projectId: string | null) => void;
}

const EFFORTS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Instant" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

// Slash commands typed into the composer (e.g. "/model", "/projects", "/artifact").
type SlashCommand = { id: string; label: string; hint: string; run?: () => void };
type SlashItem = ModelInfo | SlashCommand;
type SlashState = { kind: "model"; items: ModelInfo[] } | { kind: "command"; items: SlashCommand[] } | null;


export function Composer({
  conversationId,
  model,
  onModelChange,
  onSend,
  isBusy,
  status,
  onStop,
  onOpenVoiceMode,
  quotaReached,
  canvasEnabled,
  onToggleCanvas,
  webSearchEnabled = false,
  onToggleWebSearch,
  reasoningEffort,
  onReasoningChange,
  connectorsEnabled = [],
  onToggleConnector,
  placeholder: customPlaceholder,
  privateMode = false,
  hideDisclaimer = false,
  selectedProjectId = null,
  onPickProject,
}: ComposerProps) {
  const { features, settings, setSettings, quota, models } = useApp();
  const resolved = resolveModel(model);
  const supportsReasoning = resolved?.reasoning ?? false;
  const modality = resolved?.modality ?? "chat";
  // Native web search (Gemini grounding, Claude/Grok tools) — gated by plan +
  // model capability; no third-party key required.
  const canWebSearch = !!onToggleWebSearch && PLANS[quota.plan].webSearch && modality === "chat" && (resolved?.webSearch ?? false);
  const placeholder = customPlaceholder ?? (
    modality === "image" ? "Describe an image to generate…" : modality === "video" ? "Describe a video to generate…" : "Message Juno…"
  );
  const [text, setText] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<{ id: string; name: string; conversationCount: number }[]>([]);
  const [loadingProjects, setLoadingProjects] = React.useState(false);
  const [connectors, setConnectors] = React.useState<{ id: string; label: string; connected: boolean }[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(privateMode ? null : conversationId);
  const sendAttachments = privateMode ? [] : readyAttachments;
  const uploading = privateMode ? false : isUploading;

  const speech = useSpeechRecognition({
    onFinal: (t) => setText((prev) => (prev ? `${prev} ${t}` : t)),
  });

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  React.useEffect(() => {
    autoresize();
  }, [text, autoresize]);

  React.useEffect(() => {
    if (privateMode) {
      clear();
      setDragging(false);
    }
  }, [clear, privateMode]);

  const canSend = (text.trim().length > 0 || sendAttachments.length > 0) && !isBusy && !uploading && !quotaReached;
  const longText = text.trim().length > 1500 || text.split("\n").length > 30;
  const activeLabel =
    status === "stopping"
      ? "Stopping..."
      : status === "writing"
        ? "Writing..."
        : status === "thinking" || status === "submitting"
          ? "Thinking..."
          : null;

  const attachAsFile = () => {
    const content = text;
    if (!content.trim()) return;
    const file = new File([content], "prompt.txt", { type: "text/plain" });
    addFiles([file]);
    setText("");
    requestAnimationFrame(autoresize);
  };

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), sendAttachments);
    setText("");
    clear();
    if (speech.listening) speech.stop();
    requestAnimationFrame(autoresize);
  };

  // ——— Slash commands (type "/" then a command, e.g. "/model", "/projects") ———
  const router = useRouter();
  const commands = React.useMemo<SlashCommand[]>(
    () => [
      { id: "model", label: "/model", hint: "Switch the AI model" },
      { id: "artifact", label: "/artifact", hint: "Start a canvas / artifact" },
      {
        id: "search",
        label: "/search",
        hint: webSearchEnabled ? "Turn web search off" : "Turn web search on",
        run: () => onToggleWebSearch?.(!webSearchEnabled),
      },
      { id: "projects", label: "/projects", hint: "Open your projects", run: () => router.push("/projects") },
      { id: "library", label: "/library", hint: "Open your library", run: () => router.push("/library") },
      { id: "memory", label: "/memory", hint: "Open memory", run: () => router.push("/memory") },
      ...(onOpenVoiceMode ? [{ id: "voice", label: "/voice", hint: "Start voice mode", run: onOpenVoiceMode }] : []),
      {
        id: "new",
        label: "/new",
        hint: "Start a new chat",
        run: () => {
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
          router.push("/chat");
        },
      },
    ],
    [webSearchEnabled, onToggleWebSearch, onOpenVoiceMode, router]
  );

  const slash = React.useMemo((): SlashState => {
    if (!text.startsWith("/")) return null;
    const modelMatch = text.match(/^\/model(?:\s+(.*))?$/i);
    if (modelMatch) {
      const q = (modelMatch[1] ?? "").toLowerCase().trim();
      const items = models
        .filter((m) => !q || m.name.toLowerCase().includes(q) || (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q))
        .slice(0, 8);
      return { kind: "model", items };
    }
    const cmdMatch = text.match(/^\/([\w-]*)$/);
    if (cmdMatch) {
      const c = cmdMatch[1].toLowerCase();
      const items = commands.filter((cmd) => cmd.id.startsWith(c));
      return items.length ? { kind: "command", items } : null;
    }
    return null;
  }, [text, models, commands]);

  const [slashIndex, setSlashIndex] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const slashOpen = !!slash && !slashDismissed && slash.items.length > 0;

  React.useEffect(() => setSlashIndex(0), [text]);
  React.useEffect(() => {
    if (!text.startsWith("/")) setSlashDismissed(false);
  }, [text]);

  const applySlash = (item: SlashItem) => {
    if ("providerModel" in item) {
      onModelChange(item.id);
      setText("");
      requestAnimationFrame(autoresize);
      return;
    }
    if (item.id === "model") {
      setText("/model ");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (item.id === "artifact") {
      onToggleCanvas(true);
      setText("Create an artifact that ");
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return;
    }
    item.run?.();
    setText("");
    requestAnimationFrame(autoresize);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slash) {
      const n = slash.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + n) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        applySlash(slash.items[Math.min(slashIndex, n - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length && features.storage && !privateMode) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const startCanvas = () => {
    onToggleCanvas(true);
    setText((prev) => (prev.trim() ? prev : "Create an artifact that "));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  };

  const toggleMemory = (v: boolean) => {
    setSettings({ memoryEnabled: v });
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: v }),
    }).catch(() => {});
  };

  // Load the project list when the menu opens (so the flyout is ready), and also
  // when a project is already selected but we don't have its name yet (for the chip).
  const loadProjects = React.useCallback(() => {
    setLoadingProjects(true);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProjects(d?.projects ?? []))
      .catch(() => {})
      .finally(() => setLoadingProjects(false));
  }, []);

  React.useEffect(() => {
    if (plusOpen && !privateMode) loadProjects();
  }, [plusOpen, privateMode, loadProjects]);

  // Load the user's connected tools when the menu opens so they can be toggled.
  React.useEffect(() => {
    if (plusOpen && !privateMode && onToggleConnector) {
      fetch("/api/connectors")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setConnectors(((d?.connectors ?? []) as { id: string; label: string; connected: boolean }[]).filter((c) => c.connected)))
        .catch(() => {});
    }
  }, [plusOpen, privateMode, onToggleConnector]);

  React.useEffect(() => {
    if (selectedProjectId && projects.length === 0 && !privateMode) loadProjects();
  }, [selectedProjectId, projects.length, privateMode, loadProjects]);

  const pickProject = (projectId: string | null) => {
    onPickProject?.(projectId);
    setPlusOpen(false);
  };

  const selectedProject = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) ?? null : null;

  return (
    <div
      className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4"
    >
      {quotaReached && (
        <div role="status" className="mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center text-sm text-foreground">
          You&apos;ve reached your monthly limit.{" "}
          <a href="/upgrade" className="font-medium text-primary underline-offset-2 hover:underline">
            Upgrade to keep chatting
          </a>
        </div>
      )}

      {selectedProject && !privateMode && (
        <div className="mb-2 flex">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-2.5 py-1 text-caption text-muted-foreground shadow-soft">
            <Box className="h-3 w-3 text-primary" />
            <span>
              {conversationId ? "In " : "New chat in "}
              <span className="font-medium text-foreground">{selectedProject.name}</span>
            </span>
            <button
              type="button"
              onClick={() => pickProject(null)}
              aria-label="Remove from project"
              className="ml-0.5 rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      <div
        onDragOver={(e) => {
          if (!features.storage || privateMode) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (features.storage && !privateMode && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "relative rounded-[20px] border bg-card/90 shadow-soft backdrop-blur transition-[border-color,box-shadow] duration-base ease-out-soft",
          privateMode ? "border-dashed border-black/25 dark:border-white/30" : "border-border/70",
          dragging && "border-primary/60 ring-2 ring-primary/30"
        )}
      >
        {dragging && !privateMode && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[20px] border-2 border-dashed border-primary/50 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in">
            <FileUp className="h-6 w-6 text-primary" />
            <span className="font-mono text-label uppercase text-primary">Drop to attach</span>
          </div>
        )}

        {!privateMode && uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 pb-0">
            {uploads.map((u) => (
              <div key={u.localId} className="group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft motion-safe:animate-rise-in">
                {u.attachment?.kind === "IMAGE" ? (
                  <Image src={u.attachment.url} alt={u.fileName} width={32} height={32} className="h-8 w-8 rounded object-cover" />
                ) : (
                  <FileText className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="max-w-[140px]">
                  <p className="truncate font-medium">{u.fileName}</p>
                  <p className="text-muted-foreground">
                    {u.status === "uploading" ? `${u.progress}%` : u.status === "error" ? "Failed" : formatBytes(u.size)}
                  </p>
                </div>
                {u.status === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <button
                  type="button"
                  onClick={() => remove(u.localId)}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {longText && features.storage && !privateMode && (
          <div className="flex items-center justify-between gap-3 px-4 pt-3">
            <span className="text-caption text-muted-foreground">
              That’s a long one — attach it as a file to keep the chat tidy?
            </span>
            <Button type="button" variant="outline" size="sm" onClick={attachAsFile} className="h-7 shrink-0 gap-1.5">
              <FileUp className="h-3.5 w-3.5" /> Attach as file
            </Button>
          </div>
        )}

        {slashOpen && slash && (
          <div className="absolute bottom-full left-2 right-2 z-30 mb-2 overflow-hidden rounded-xl border bg-popover/95 shadow-float backdrop-blur">
            <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {slash.kind === "model" ? "Switch model" : "Commands"}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {slash.kind === "model"
                ? slash.items.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseEnter={() => setSlashIndex(i)}
                      onClick={() => applySlash(m)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                        i === slashIndex ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <ProviderLogo provider={m.provider} className="h-5 w-5" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{PROVIDERS[m.provider].label.split(" · ")[0]}</span>
                      {m.id === model && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  ))
                : slash.items.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      onMouseEnter={() => setSlashIndex(i)}
                      onClick={() => applySlash(c)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                        i === slashIndex ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <span className="font-mono text-sm text-primary">{c.label}</span>
                      <span className="text-xs text-muted-foreground">{c.hint}</span>
                    </button>
                  ))}
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={speech.listening && speech.interim ? `${text} ${speech.interim}`.trim() : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={placeholder}
          className="max-h-[200px] min-h-[86px] w-full resize-none bg-transparent px-3.5 py-3.5 text-body-lg leading-relaxed outline-none placeholder:text-muted-foreground sm:px-4"
        />

        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          {/* Left: + menu and model selector */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Add" className={cn("rounded-[20px] coarse:h-11 coarse:w-11", plusOpen && "bg-accent")}>
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64">
                <DropdownMenuItem
                  disabled={!features.storage || privateMode}
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <FileUp className="text-muted-foreground" />
                  <span className="flex-1">Upload files</span>
                  {(privateMode || !features.storage) && (
                    <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!features.storage || privateMode}
                  onSelect={() => setLibraryOpen(true)}
                >
                  <Library className="text-muted-foreground" />
                  <span className="flex-1">Add from library</span>
                  {(privateMode || !features.storage) && (
                    <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={privateMode} onSelect={() => startCanvas()}>
                  <SquarePen className="text-muted-foreground" />
                  <span className="flex-1">Create a canvas</span>
                </DropdownMenuItem>

                {/* Add to project — portaled submenu (frosted blur composes correctly).
                    Works before chatting: the project is applied when the chat is created. */}
                {privateMode ? (
                  <DropdownMenuItem disabled>
                    <Box className="text-muted-foreground" />
                    <span className="flex-1">Add to project</span>
                    <span className="text-caption text-muted-foreground/60">private</span>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Box className="text-muted-foreground" />
                      <span className="flex-1">Add to project</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                      {loadingProjects && projects.length === 0 ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : projects.length === 0 ? (
                        <div className="px-2 py-4 text-center">
                          <p className="text-caption text-muted-foreground">No projects yet.</p>
                          <a href="/projects" className="mt-1 inline-block text-caption text-primary hover:underline">
                            Create one →
                          </a>
                        </div>
                      ) : (
                        projects.map((p) => {
                          const active = selectedProjectId === p.id;
                          return (
                            <DropdownMenuItem key={p.id} onSelect={() => pickProject(active ? null : p.id)}>
                              <Box className={cn(active ? "text-primary" : "text-muted-foreground")} />
                              <span className="flex-1 truncate">{p.name}</span>
                              {active ? (
                                <Check className="!size-3.5 text-primary" />
                              ) : (
                                <span className="font-mono text-[10px] text-muted-foreground/60">{p.conversationCount}</span>
                              )}
                            </DropdownMenuItem>
                          );
                        })
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em]">
                  <Blocks className="h-3.5 w-3.5" />
                  Plugins
                </DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={privateMode}
                  onSelect={(e) => {
                    e.preventDefault();
                    onToggleCanvas(!canvasEnabled);
                  }}
                >
                  <LayoutTemplate className="text-muted-foreground" />
                  <span className="flex-1">Canvas &amp; artifacts</span>
                  <Switch checked={!privateMode && canvasEnabled} className="pointer-events-none" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleMemory(!settings.memoryEnabled);
                  }}
                >
                  <Brain className="text-muted-foreground" />
                  <span className="flex-1">Memory</span>
                  <Switch checked={settings.memoryEnabled} className="pointer-events-none" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canWebSearch}
                  onSelect={(e) => {
                    e.preventDefault();
                    onToggleWebSearch?.(!webSearchEnabled);
                  }}
                >
                  <Globe className="text-muted-foreground" />
                  <span className="flex-1">Web search</span>
                  {canWebSearch ? (
                    <Switch checked={webSearchEnabled} className="pointer-events-none" />
                  ) : (
                    <span className="text-caption text-muted-foreground/60">{modality === "chat" ? "not on this model" : "chat only"}</span>
                  )}
                </DropdownMenuItem>

                {onToggleConnector && !privateMode && modality === "chat" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em]">
                      <Plug className="h-3.5 w-3.5" />
                      Connectors
                    </DropdownMenuLabel>
                    {connectors.length === 0 ? (
                      <DropdownMenuItem onSelect={() => router.push("/connections")}>
                        <Plug className="text-muted-foreground" />
                        <span className="flex-1">Connect GitHub or Figma</span>
                        <span className="text-caption text-muted-foreground/60">set up</span>
                      </DropdownMenuItem>
                    ) : (
                      connectors.map((c) => (
                        <DropdownMenuItem
                          key={c.id}
                          onSelect={(e) => {
                            e.preventDefault();
                            onToggleConnector(c.id);
                          }}
                        >
                          <Plug className="text-muted-foreground" />
                          <span className="flex-1">{c.label}</span>
                          <Switch checked={connectorsEnabled.includes(c.id)} className="pointer-events-none" />
                        </DropdownMenuItem>
                      ))
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <ModelSelector value={model} onChange={onModelChange} reasoningEffort={reasoningEffort} onReasoningChange={onReasoningChange} />

            {supportsReasoning && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("h-7 gap-1.5 px-2 font-mono text-[13px]", reasoningEffort ? "text-primary" : "text-muted-foreground")}
                  >
                    <Brain className="h-3.5 w-3.5" />
                    {EFFORTS.find((e) => e.value === reasoningEffort)?.label ?? "Instant"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {EFFORTS.map((e) => (
                    <DropdownMenuItem key={e.label} onSelect={() => onReasoningChange(e.value)}>
                      <Brain className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1">{e.label}</span>
                      {reasoningEffort === e.value && <Check className="h-4 w-4 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

          </div>

          {/* Right: voice mode, dictation mic, send */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {activeLabel && (
              <span role="status" className="mr-1 hidden items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground sm:inline-flex">
                <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
                {activeLabel}
              </span>
            )}

            {onOpenVoiceMode && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenVoiceMode} aria-label="Voice mode" className="coarse:h-11 coarse:w-11">
                    <AudioLines className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Voice conversation</TooltipContent>
              </Tooltip>
            )}

            {speech.supported && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => (speech.listening ? speech.stop() : speech.start())}
                    aria-label={speech.listening ? "Stop dictation" : "Dictate"}
                    aria-pressed={speech.listening}
                    className={cn("coarse:h-11 coarse:w-11", speech.listening && "text-primary")}
                  >
                    <Mic className={cn("h-4 w-4", speech.listening && "animate-pulse")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{speech.listening ? "Stop dictation" : "Dictate"}</TooltipContent>
              </Tooltip>
            )}

            {/* Send ⇄ Stop morph in place (one button, icon crossfades). */}
            <Button
              type="button"
              size="icon"
              onClick={isBusy ? onStop : submit}
              disabled={isBusy ? status === "stopping" : !canSend}
              aria-label={isBusy ? (status === "stopping" ? "Stopping generation" : "Stop generating") : "Send message"}
              className={cn(
                "coarse:h-11 coarse:w-11",
                isBusy ? "w-12 rounded-[14px] shadow-soft ring-2 ring-primary/20" : "rounded-full"
              )}
            >
              {isBusy ? (
                <Square key="stop" className="h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
              ) : (
                <ArrowUp key="send" className="h-4 w-4 motion-safe:animate-fade-in" />
              )}
            </Button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => {
            if (!privateMode && e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {!privateMode && features.storage && (
          <LibraryPicker open={libraryOpen} onOpenChange={setLibraryOpen} onAttach={addAttachments} existingCount={uploads.length} />
        )}
      </div>
      {!hideDisclaimer && (
        <p className="mt-2 text-center text-caption text-muted-foreground">
          {privateMode ? "Incognito chats are not saved or added to memory." : "Juno can be wrong — worth a second look on anything that matters."}
        </p>
      )}
    </div>
  );
}
