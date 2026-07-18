"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUp,
  ChevronDown,
  Cloud,
  FileText,
  FileUp,
  ImagePlus,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { JunoMark } from "@/components/brand/logo";
import {
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { resolveModel, DEFAULT_MODEL, type ModelId } from "@/lib/models";
import { reasoningOptions, defaultReasoning } from "@/lib/model-metrics";
import { supportsFastMode } from "@/lib/pricing";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientAttachment, ClientConversation, ReasoningEffort } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";

/** Cloud task-dispatch failures surfaced inline under the composer (503/502). */
type CloudStartError = "not_configured" | "dispatch_failed" | null;

// Code-flavoured greetings — deterministic index during SSR (stable hydration),
// then a random pick once mounted so it varies per visit (same idiom as the chat
// EmptyGreeting).
const CODE_GREETINGS = [
  "What are we building",
  "What's the task",
  "What's next",
  "Where do we start",
  "What should Juno Code do",
  "Ready when you are",
];

function CodeGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => setIdx(Math.floor(Math.random() * CODE_GREETINGS.length)), []);
  const [popping, setPopping] = React.useState(false);
  const phrase = CODE_GREETINGS[idx];

  return (
    <div className="flex flex-col items-center text-center">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80 [animation-fill-mode:backwards] motion-safe:animate-fade-in">
        Juno Code
      </p>
      {/* Text alone defines the page center; the mark hangs left of that box. */}
      <h1
        className="relative font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]"
        suppressHydrationWarning
      >
        <button
          type="button"
          aria-label="Juno"
          onClick={() => setPopping(true)}
          onAnimationEnd={() => setPopping(false)}
          className={cn(
            "absolute right-full top-1/2 mr-[0.38em] -translate-y-1/2 shrink-0 outline-none",
            "[animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in",
            popping && "juno-mark-popping",
          )}
        >
          <JunoMark
            className={cn(
              "block h-[0.78em] w-[0.78em]",
              "transition-transform duration-base ease-spring motion-reduce:transition-none",
              !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110",
            )}
          />
        </button>
        <span className="inline-block [animation-delay:60ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
          {phrase}
          {firstName ? "," : "?"}
        </span>
        {firstName ? (
          <>
            {" "}
            <span className="inline-block font-medium italic text-primary [animation-delay:180ms] [animation-fill-mode:backwards] motion-safe:animate-rise-in">
              {firstName}?
            </span>
          </>
        ) : null}
      </h1>
    </div>
  );
}

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { settings, upsertConversation, composerPrefs, setComposerPrefs, features } = useApp();

  // —— Target (Device ⇄ Cloud), restored after mount (SSR renders "device") ——
  const [target, setTarget] = React.useState<Target>("device");
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, []);
  const switchTarget = React.useCallback((next: Target) => {
    setTarget(next);
    setCloudStartError(null);
    try {
      localStorage.setItem(TARGET_KEY, next);
    } catch {}
  }, []);

  // —— Selection state (kept per target so toggling never loses a pick) ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");

  // —— Prompt + model + thinking (visible BEFORE the first send) ——
  const [prompt, setPrompt] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const [dictating, setDictating] = React.useState(false);
  const [model, setModel] = React.useState<ModelId>(
    () => resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL,
  );
  const reasoningEffort = composerPrefs.reasoningEffort;
  const fastMode = composerPrefs.fastMode;
  const setReasoningEffort = React.useCallback(
    (e: ReasoningEffort | null) => setComposerPrefs({ reasoningEffort: e }),
    [setComposerPrefs],
  );
  const setFastMode = React.useCallback(
    (enabled: boolean) => setComposerPrefs({ fastMode: enabled }),
    [setComposerPrefs],
  );
  const resolved = resolveModel(model);
  const effortOptions = React.useMemo(() => (resolved ? reasoningOptions(resolved) : []), [resolved]);
  const canFastMode = !!resolved && supportsFastMode(resolved);
  const canAttach = features.storage;
  const { supported: speechSupported } = useSpeechRecognition();
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(null);

  // Switching models drops a thinking tier the new model can't do — same guard
  // the chat composer uses, so we never show (or persist) an unsupported effort.
  const changeModel = React.useCallback(
    (m: ModelId) => {
      setModel(m);
      const next = resolveModel(m);
      if (next) {
        const opts = reasoningOptions(next);
        if (!opts.some((o) => o.value === reasoningEffort)) setReasoningEffort(defaultReasoning(next));
      }
    },
    [reasoningEffort, setReasoningEffort],
  );

  // —— Submission ——
  const [submitting, setSubmitting] = React.useState(false);
  const [cloudStartError, setCloudStartError] = React.useState<CloudStartError>(null);
  // Reuse one cloud conversation across retries so a transient dispatch failure
  // doesn't leak an empty session on every attempt.
  const cloudConversationId = React.useRef<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [prompt, autoresize]);
  React.useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const removeUpload = React.useCallback(
    (localId: string) => {
      setRemovingIds((prev) => [...prev, localId]);
      window.setTimeout(() => {
        remove(localId);
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
      }, 180);
    },
    [remove],
  );

  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  const hasPayload = prompt.trim().length > 0 || readyAttachments.length > 0;
  const canSubmit = hasTarget && hasPayload && !submitting && !isUploading;

  const startDevice = React.useCallback(
    async (w: Workspace, text: string, attachments: ClientAttachment[]) => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "code",
          codeWorkspaceName: w.name,
          codeWorkspacePath: w.path,
          // Stable identity when the mirror has one — sessions then follow the
          // workspace even if the folder moves on disk.
          codeWorkspaceKey: w.key ?? undefined,
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      // Hand the first prompt (+ attachments) off to the session view, which
      // dispatches once the Mac is reachable (create contract stays prompt-free).
      setPendingCodePrompt(conversation.id, text, attachments);
      // Carry the chosen model into the client-side session record.
      upsertConversation({ ...conversation, model });
      router.push(`/chat/${conversation.id}`);
    },
    [model, router, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null, attachments: ClientAttachment[]) => {
      // 1) Ensure a kind:"code" session to stream the run into. The repo is the
      //    cloud "workspace": name for display, owner/name as the path.
      let conversation: ClientConversation | null = null;
      if (!cloudConversationId.current) {
        const cRes = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "code",
            codeWorkspaceName: repo.name,
            codeWorkspacePath: `${repo.owner}/${repo.name}`,
          }),
        });
        if (!cRes.ok) throw new Error("conversation");
        conversation = ((await cRes.json()) as { conversation: ClientConversation }).conversation;
        cloudConversationId.current = conversation.id;
      }
      const conversationId = cloudConversationId.current;
      const attachmentIds = attachments.map((a) => a.id);
      const titleFallback =
        text.slice(0, 60) ||
        (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);

      // 2) Dispatch the cloud task against the selected repo.
      const tRes = await fetch("/api/code/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "cloud",
          repo: { owner: repo.owner, name: repo.name },
          baseRef: ref ?? undefined,
          prompt: text,
          title: titleFallback,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
          conversationId,
        }),
      });

      if (tRes.ok) {
        if (conversation) {
          upsertConversation({
            ...conversation,
            title: titleFallback.slice(0, 48),
            titleSource: "manual",
            model,
          });
        }
        clear();
        router.push(`/chat/${conversationId}`);
        return;
      }

      const err = ((await tRes.json().catch(() => ({}))) as { error?: string }).error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        setCloudStartError("not_configured");
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        setCloudStartError("dispatch_failed");
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
      } else {
        toast.error("Could not start the cloud run. Check your connection and try again.");
      }
    },
    [clear, model, router, upsertConversation],
  );

  const submit = React.useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? prompt).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || submitting || isUploading) return;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return;

      setSubmitting(true);
      setCloudStartError(null);
      try {
        if (target === "device" && selectedWorkspace) {
          await startDevice(selectedWorkspace, text, attachments);
        } else if (target === "cloud" && selectedRepo) {
          await startCloud(selectedRepo, text, baseRef.trim() || null, attachments);
        }
      } catch {
        toast.error("Could not start the session. Check your connection and try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [
      prompt,
      readyAttachments,
      submitting,
      isUploading,
      target,
      selectedWorkspace,
      selectedRepo,
      baseRef,
      startDevice,
      startCloud,
    ],
  );

  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [prompt.trim(), transcript.trim()].filter(Boolean).join(" ");
      if (!sendNow) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      if (!merged && readyAttachments.length === 0) {
        setPrompt("");
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      // Gate the same way the send button does — if target is missing, park the
      // words in the field so the user can finish setup without losing them.
      if (!(target === "device" ? selectedWorkspace : selectedRepo)) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      void submit(merged);
    },
    [autoresize, prompt, readyAttachments.length, selectedRepo, selectedWorkspace, submit, target],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) void submit();
    }
  };

  const gateHint =
    !hasTarget
      ? target === "device"
        ? "Pick a project to start"
        : "Pick a repository to start"
      : null;

  return (
    <div className="relative flex h-full min-h-full w-full flex-col overflow-y-auto">
      {/* Greeting + composer, centered as one calm group and free to scroll on
          short viewports. py accounts for the floating back button so a short
          viewport never tucks the greeting under it. */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-14 sm:px-6">
        <div className="flex w-full max-w-[44rem] flex-col items-center gap-7 sm:gap-9">
          <CodeGreeting />

          <div className="w-full">
            <div
              className={cn(
                "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-spring motion-reduce:transition-none",
                dictating ? "min-h-[170px]" : "min-h-[68px]",
              )}
            >
              <div
                className={cn(
                  "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
                  dictating
                    ? "translate-y-0 scale-100 opacity-100"
                    : "pointer-events-none translate-y-1 scale-95 opacity-0",
                )}
              >
                {dictating && (
                  <ComposerDictation
                    onCancel={() => setDictating(false)}
                    onStop={(t) => closeDictation(t, false)}
                    onSend={(t) => closeDictation(t, true)}
                  />
                )}
              </div>

            <div
              onDragOver={(e) => {
                if (!canAttach || submitting || dictating) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (canAttach && !submitting && !dictating && e.dataTransfer.files.length) {
                  addFiles(e.dataTransfer.files);
                }
              }}
              className={cn(
                "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-[22px] border bg-card/95 backdrop-blur sm:rounded-[24px]",
                "transition-[opacity,transform,border-color,box-shadow] duration-base ease-spring motion-reduce:transition-none",
                dictating
                  ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0"
                  : "translate-y-0 scale-100 opacity-100",
                "border-border/65 focus-within:border-foreground/15",
                dragging && "border-primary/55 ring-2 ring-primary/20",
              )}
            >
              {dragging && (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[inherit] border-2 border-dashed border-primary/45 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in">
                  <FileUp className="h-6 w-6 text-primary" />
                  <span className="font-mono text-label uppercase text-primary">Drop to attach</span>
                </div>
              )}

              {/* Chip row — where this session runs. */}
              <div className="flex flex-wrap items-center gap-1.5 px-3 pb-0 pt-3 sm:px-3.5 sm:pt-3.5">
                <CodeTargetPicker
                  target={target}
                  onTargetChange={switchTarget}
                  selectedWorkspace={selectedWorkspace}
                  onSelectWorkspace={(w) => {
                    setSelectedWorkspace(w);
                    setCloudStartError(null);
                  }}
                  selectedRepo={selectedRepo}
                  onSelectRepo={(r) => {
                    setSelectedRepo(r);
                    setBaseRef("");
                    setCloudStartError(null);
                  }}
                  baseRef={baseRef}
                  onBaseRefChange={setBaseRef}
                  disabled={submitting}
                />
              </div>

              {canAttach && (
                <div
                  className={cn(
                    "grid transition-[grid-template-rows] duration-base ease-out-soft",
                    uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="flex flex-wrap gap-2 px-3 pb-0 pt-2.5 sm:px-3.5">
                      {uploads.map((u) => (
                        <div
                          key={u.localId}
                          className={cn(
                            "group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft",
                            removingIds.includes(u.localId)
                              ? "pointer-events-none motion-safe:animate-pop-out"
                              : "motion-safe:animate-rise-in",
                          )}
                        >
                          {u.attachment?.kind === "IMAGE" ? (
                            <Image
                              src={u.attachment.url}
                              alt={u.fileName}
                              width={32}
                              height={32}
                              className="h-8 w-8 rounded object-cover"
                            />
                          ) : (
                            <FileText className="h-5 w-5 text-muted-foreground" />
                          )}
                          <div className="max-w-[140px]">
                            <p className="truncate font-medium">{u.fileName}</p>
                            <p className="text-muted-foreground">
                              {u.status === "uploading"
                                ? `${u.progress}%`
                                : u.status === "error"
                                  ? "Failed"
                                  : formatBytes(u.size)}
                            </p>
                          </div>
                          {u.status === "uploading" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <button
                            type="button"
                            onClick={() => removeUpload(u.localId)}
                            className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                            aria-label="Remove attachment"
                          >
                            <X className="h-3 w-3 coarse:h-4 coarse:w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={submitting}
                placeholder="Describe a task or ask a question"
                aria-label="Describe the task for this Juno Code session"
                className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]"
              />

              {/* Toolbar — + attach, model + thinking, send. Matches home
                  composer radius / padding / primary action language. */}
              <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-2 pt-0.5 sm:px-2.5 sm:pb-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  {canAttach && (
                    <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Add"
                          disabled={submitting}
                          className={cn(
                            "composer-add-button group shrink-0 rounded-[11px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
                            plusOpen && "bg-accent",
                          )}
                        >
                          <Plus
                            aria-hidden="true"
                            strokeWidth={1.75}
                            className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                          />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                        <DropdownMenuLabel className="font-mono text-label uppercase">Add</DropdownMenuLabel>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Paperclip className="text-muted-foreground" />
                            <span className="flex-1">Attach</span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-52">
                            <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}>
                              <ImagePlus className="text-muted-foreground" />
                              <span className="flex-1">Photos</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                              <FileUp className="text-muted-foreground" />
                              <span className="flex-1">Files</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                              <Library className="text-muted-foreground" />
                              <span className="flex-1">From your library</span>
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}

                  <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border/60 min-[420px]:block" aria-hidden="true" />

                  <div
                    className={cn(
                      "min-w-0 flex-1 sm:flex-none",
                      submitting && "pointer-events-none opacity-60",
                    )}
                  >
                    <ModelSelector
                      value={model}
                      onChange={changeModel}
                      reasoningEffort={reasoningEffort}
                      onReasoningChange={setReasoningEffort}
                    />
                  </div>

                  {effortOptions.length > 0 && (() => {
                    const currentEffort = effortOptions.find((e) => e.value === reasoningEffort) ?? effortOptions[0];
                    const compactEffortLabel = currentEffort.label === "Extra high" ? "X-high" : currentEffort.label;
                    const atTopTier =
                      effortOptions.length > 1 && currentEffort.value === effortOptions[effortOptions.length - 1].value;
                    return (
                      <>
                        <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block" aria-hidden="true" />
                        <Tooltip>
                          <Popover>
                            <PopoverTrigger asChild>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={submitting}
                                  aria-label={`Thinking effort: ${currentEffort.label}${canFastMode ? `; Flash mode ${fastMode ? "on" : "off"}` : ""}`}
                                  className={cn(
                                    "group h-8 w-[4.75rem] shrink-0 justify-between gap-1 rounded-[10px] px-2 font-mono text-[12px] tracking-tight hover:text-foreground focus-visible:bg-accent focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:bg-accent data-[state=open]:text-foreground min-[360px]:w-[5.5rem] min-[480px]:w-[6.5rem] min-[480px]:text-[13px]",
                                    atTopTier ? "text-ultra" : "text-foreground/80",
                                  )}
                                >
                                  <span className="min-w-0 flex-1 truncate text-center min-[480px]:hidden">
                                    {compactEffortLabel}
                                  </span>
                                  <span className="hidden min-w-0 flex-1 truncate text-center min-[480px]:inline">
                                    {currentEffort.label}
                                  </span>
                                  <ChevronDown className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                                </Button>
                              </TooltipTrigger>
                            </PopoverTrigger>
                            <PopoverContent align="start" sideOffset={10} className="w-[264px] origin-popper p-3">
                              <ReasoningSlider
                                options={effortOptions}
                                value={reasoningEffort}
                                onChange={setReasoningEffort}
                                disabled={submitting}
                                fastMode={fastMode}
                                onFastModeChange={canFastMode ? setFastMode : undefined}
                              />
                            </PopoverContent>
                          </Popover>
                          <TooltipContent>Thinking effort</TooltipContent>
                        </Tooltip>
                      </>
                    );
                  })()}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {speechSupported && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setDictating(true)}
                            disabled={submitting || dictating}
                            aria-label="Dictate"
                            aria-pressed={dictating}
                            className="composer-mic-button rounded-[11px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                          >
                            <Mic className="composer-mic-icon h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Dictate</TooltipContent>
                      </Tooltip>
                      <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border/60 min-[420px]:block" aria-hidden="true" />
                    </>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        onClick={() => void submit()}
                        disabled={!canSubmit}
                        aria-label={
                          !hasTarget
                            ? gateHint ?? "Select where to run first"
                            : target === "cloud"
                              ? "Start a cloud run"
                              : "Start the session"
                        }
                        className="composer-primary-action h-9 w-9 rounded-[13px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                      >
                        {submitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <ArrowUp className="composer-send-icon h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{target === "cloud" ? "Start cloud run" : "Start session"}</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <input
                ref={imageInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {canAttach && (
                <LibraryPicker
                  open={libraryOpen}
                  onOpenChange={setLibraryOpen}
                  onAttach={addAttachments}
                  existingCount={uploads.length}
                />
              )}
            </div>
            </div>

            {/* Inline task-dispatch failures (cloud only). */}
            {cloudStartError === "not_configured" && (
              <p
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-sm text-warning-foreground motion-safe:animate-rise-in"
              >
                <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  Cloud runs aren’t enabled on this server yet. Ask an admin to configure the cloud runner, or switch to{" "}
                  <button type="button" onClick={() => switchTarget("device")} className="font-medium underline underline-offset-2 hover:text-foreground">
                    Device
                  </button>{" "}
                  to run on your Mac.
                </span>
              </p>
            )}
            {cloudStartError === "dispatch_failed" && (
              <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive motion-safe:animate-rise-in">
                <span>Couldn’t start the cloud run — this is usually temporary.</span>
                <Button variant="outline" size="sm" onClick={() => void submit()} disabled={submitting} className="shrink-0 gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive">
                  Try again
                </Button>
              </div>
            )}

            {/* Quiet, honest footer — the gate hint (when send is blocked) then
                what happens on send, per target. Calm, never a nag. */}
            <p className="mt-3 text-center text-caption text-muted-foreground">
              {gateHint && !cloudStartError ? (
                <span className="text-foreground/70">{gateHint}. </span>
              ) : null}
              {target === "cloud"
                ? "Runs on a fresh cloud machine and opens a pull request to review."
                : "Runs with Juno Code on your Mac and streams the work here."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
