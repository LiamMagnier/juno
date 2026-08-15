"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Clock,
  Loader2,
  Mic,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import {
  CodeTargetPicker,
  type CloudRepo,
  type Target,
  type Workspace,
} from "@/components/code/code-target-picker";
import {
  ComposerAddMenu,
  ComposerAttachmentTray,
  ComposerDropOverlay,
  ComposerFileInputs,
} from "@/components/code/code-composer-parts";
import { CodeConnectorsMenu } from "@/components/code/code-connectors-menu";
import { CodePresetsGrid, type CodePreset } from "@/components/code/code-presets";
import { CodeSurfaceNav } from "@/components/code/code-surface-nav";
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useCodeRuns } from "@/components/code/use-code-runs";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import {
  clampReasoningEffort,
  defaultReasoning,
  reasoningOptions,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { cn } from "@/lib/utils";
import type { ClientAttachment, ClientConversation } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";
const MODEL_KEY = "juno:code:model";
const EFFORT_KEY = "juno:code:reasoning";
const CONNECTORS_KEY = "juno:code:connectors";

const COMPOSER_DIVIDER = "mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block";

type CloudStartError = "not_configured" | "dispatch_failed" | null;

function CodeGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];

  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1 className="text-center font-serif text-3xl font-normal tracking-tight text-foreground sm:text-4xl">
        What are we building today{firstName ? `, ${firstName}` : ""}?
      </h1>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
        Autonomous coding tasks in your workspace or on an isolated cloud runner with GitHub review.
      </p>
    </div>
  );
}

function PermissionFact({ target }: { target: Target }) {
  const cloud = target === "cloud";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 cursor-help items-center gap-1.5 font-mono text-ui text-muted-foreground hover:text-foreground transition-colors">
          <CodeIcons.permission className="size-3 shrink-0 text-primary/80" aria-hidden="true" />
          <span className="min-w-0 truncate">{cloud ? "Full access (PR review)" : "Ask before changes"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {cloud
          ? "A cloud runner executes in a sandboxed CI environment and opens a pull request for you to review."
          : "Your Mac pauses and prompts for approval before applying high-impact changes or terminal commands."}
      </TooltipContent>
    </Tooltip>
  );
}

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { settings, upsertConversation, removeConversation, features } = useApp();

  // —— Target (Device ⇄ Cloud) ——
  const [target, setTarget] = React.useState<Target>("device");
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved === "cloud" || saved === "device") setTarget(saved);
    } catch {}
  }, []);

  const cloudConversationId = React.useRef<string | null>(null);

  const discardOrphanCloudSession = React.useCallback(() => {
    const id = cloudConversationId.current;
    if (!id) return;
    cloudConversationId.current = null;
    removeConversation(id);
    void fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  }, [removeConversation]);

  const switchTarget = React.useCallback(
    (next: Target) => {
      setTarget(next);
      setCloudStartError(null);
      if (next !== "cloud") discardOrphanCloudSession();
      try {
        localStorage.setItem(TARGET_KEY, next);
      } catch {}
    },
    [discardOrphanCloudSession],
  );

  // —— Workspace / Repository Selection ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");

  // —— Model Selector State ——
  const [model, setModel] = React.useState<string>(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY);
      if (saved) return saved;
    } catch {}
    return resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL;
  });

  const changeModel = React.useCallback((next: string) => {
    setModel(next);
    try {
      localStorage.setItem(MODEL_KEY, next);
    } catch {}
  }, []);

  const modelInfo = React.useMemo(() => resolveModel(model), [model]);

  // —— Thinking Slider / Reasoning Effort State ——
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort>(() => {
    try {
      const saved = localStorage.getItem(EFFORT_KEY);
      if (saved) return saved as ReasoningEffort;
    } catch {}
    return modelInfo ? defaultReasoning(modelInfo) : null;
  });

  const changeReasoning = React.useCallback((next: ReasoningEffort) => {
    setReasoningEffort(next);
    try {
      if (next) localStorage.setItem(EFFORT_KEY, next);
      else localStorage.removeItem(EFFORT_KEY);
    } catch {}
  }, []);

  const [fastMode, setFastMode] = React.useState(false);
  const [proMode, setProMode] = React.useState(false);

  // —— Connectors State ——
  const [enabledConnectors, setEnabledConnectors] = React.useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(CONNECTORS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return ["github", "terminal", "web-search"];
  });

  const toggleConnector = React.useCallback((id: string) => {
    setEnabledConnectors((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      try {
        localStorage.setItem(CONNECTORS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // —— Prompt & Uploads ——
  const [prompt, setPrompt] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [dictating, setDictating] = React.useState(false);
  const canAttach = features.storage;

  const { supported: speechSupported } = useSpeechRecognition();
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(null);

  // —— Submission & Status ——
  const [submitting, setSubmitting] = React.useState(false);
  const [cloudStartError, setCloudStartError] = React.useState<CloudStartError>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  const { runs } = useCodeRuns();
  const recentRun = runs[0] ?? null;

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  React.useEffect(() => {
    autoresize();
  }, [prompt, autoresize]);

  React.useEffect(() => {
    try {
      const seed = new URLSearchParams(window.location.search).get("seed");
      if (seed?.trim()) setPrompt((current) => (current.trim() ? current : seed));
    } catch {}
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  const hasPayload = prompt.trim().length > 0 || readyAttachments.length > 0;
  const canSubmit = hasTarget && hasPayload && !submitting && !isUploading;

  const codeVoice = useCodeVoice({ disabled: submitting || dictating });

  const startDevice = React.useCallback(
    async (w: Workspace, text: string, attachments: ClientAttachment[]): Promise<boolean> => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "code",
          codeWorkspaceName: w.name,
          codeWorkspacePath: w.path,
          codeWorkspaceKey: w.key ?? undefined,
          model,
          activeConnectors: enabledConnectors,
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      setPendingCodePrompt(conversation.id, text, attachments);
      upsertConversation({ ...conversation, model, activeConnectors: enabledConnectors });
      router.push(`/chat/${conversation.id}`);
      return true;
    },
    [enabledConnectors, model, router, upsertConversation],
  );

  const startCloud = React.useCallback(
    async (repo: CloudRepo, text: string, ref: string | null, attachments: ClientAttachment[]): Promise<boolean> => {
      let conversation: ClientConversation | null = null;
      if (!cloudConversationId.current) {
        const cRes = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "code",
            codeWorkspaceName: repo.name,
            codeWorkspacePath: `${repo.owner}/${repo.name}`,
            model,
            activeConnectors: enabledConnectors,
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
            activeConnectors: enabledConnectors,
          });
        }
        clear();
        router.push(`/chat/${conversationId}`);
        return true;
      }

      const err = ((await tRes.json().catch(() => ({}))) as { error?: string }).error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        setCloudStartError("not_configured");
        discardOrphanCloudSession();
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        setCloudStartError("dispatch_failed");
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
        discardOrphanCloudSession();
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
        discardOrphanCloudSession();
      } else {
        toast.error("Could not start the cloud run. Check your connection and try again.");
        discardOrphanCloudSession();
      }
      return false;
    },
    [clear, discardOrphanCloudSession, enabledConnectors, model, router, upsertConversation],
  );

  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const text = (overrideText ?? prompt).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || submitting || isUploading) return false;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return false;

      setSubmitting(true);
      setCloudStartError(null);
      try {
        if (target === "device" && selectedWorkspace) {
          return await startDevice(selectedWorkspace, text, attachments);
        }
        if (target === "cloud" && selectedRepo) {
          return await startCloud(selectedRepo, text, baseRef.trim() || null, attachments);
        }
        return false;
      } catch {
        toast.error("Could not start the session. Check your connection and try again.");
        return false;
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

  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "new",
      target,
      place: target === "device" ? (selectedWorkspace?.name ?? null) : (selectedRepo?.fullName ?? null),
      baseRef: target === "cloud" ? (baseRef.trim() || selectedRepo?.defaultBranch) ?? null : null,
      turns: [],
      blocked: gateHint,
    }),
    [baseRef, gateHint, selectedRepo, selectedWorkspace, target],
  );

  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "start",
      blockedReason: gateHint ? `${gateHint} — then these words can start it.` : null,
      sending: submitting,
      endsCall: true,
      onSend: (text: string) => submit([prompt.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [gateHint, prompt, submit, submitting],
  );

  const showVoiceButton = !submitting && !hasPayload && !!codeVoice.onOpenVoiceMode;

  const effortOptions = React.useMemo(
    () => (modelInfo ? reasoningOptions(modelInfo) : []),
    [modelInfo],
  );
  const isAuto = isAutoModelId(model);

  const onSelectPreset = React.useCallback((preset: CodePreset) => {
    setPrompt(preset.prompt);
    requestAnimationFrame(() => {
      autoresize();
      textareaRef.current?.focus();
    });
  }, [autoresize]);

  return (
    <div className="relative flex h-full min-h-full w-full flex-col overflow-y-auto overflow-x-clip">
      {/* Top Nav Bar for quick switching between New session, Runs, and PRs */}
      <div className="sticky top-0 z-20 flex w-full items-center justify-between border-b border-border/40 bg-background/80 px-4 py-2.5 backdrop-blur-md sm:px-6">
        <CodeSurfaceNav active="new" className="mb-0" />
        {recentRun && (
          <Link
            href="/code"
            className="hidden items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors md:flex"
          >
            <Clock className="size-3.5" />
            <span>Latest run: {recentRun.title.slice(0, 30)}…</span>
            <ArrowRight className="size-3" />
          </Link>
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-start px-4 py-8 sm:px-6 md:py-12">
        <div className="relative flex w-full max-w-[44rem] flex-col items-center gap-6 sm:gap-7">
          <CodeGreeting />

          {/* The Main Composer */}
          <div className="w-full">
            <div className="relative w-full">
              {codeVoice.open && (
                <CodeVoicePanel briefing={voiceBriefing} send={voiceSend} onClose={codeVoice.close} />
              )}

              <div
                className={cn(
                  "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
                  dictating ? "min-h-[170px]" : "min-h-[68px]",
                )}
              >
                <div
                  className={cn(
                    "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
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
                    "col-start-1 row-start-1 relative w-full origin-center",
                    "transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
                    dictating
                      ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0"
                      : "translate-y-0 scale-100 opacity-100",
                  )}
                >
                  <ComposerShell
                    className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
                    utilityLabel="Where this session runs"
                    above={canAttach && <ComposerAttachmentTray uploads={uploads} onRemove={remove} />}
                    field={
                      <textarea
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={onKeyDown}
                        rows={1}
                        disabled={submitting}
                        placeholder="Describe what to build, test, refactor, or fix…"
                        aria-label="Describe the task for this Juno Code session"
                        className="max-h-[240px] min-h-[68px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 motion-reduce:transition-none sm:px-[18px] sm:pt-[17px]"
                      />
                    }
                    controls={
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar">
                          {/* Attach Button */}
                          {canAttach && (
                            <ComposerAddMenu
                              open={plusOpen}
                              onOpenChange={setPlusOpen}
                              disabled={submitting}
                              onPickPhotos={() => imageInputRef.current?.click()}
                              onPickFiles={() => fileInputRef.current?.click()}
                              onPickLibrary={() => setLibraryOpen(true)}
                            />
                          )}

                          {/* Connectors / Tools Selector */}
                          <CodeConnectorsMenu
                            enabledConnectors={enabledConnectors}
                            onToggleConnector={toggleConnector}
                            disabled={submitting}
                          />

                          <span className={COMPOSER_DIVIDER} aria-hidden="true" />

                          {/* Model Selector */}
                          <div className="min-w-0 shrink-0">
                            <ModelSelector
                              value={model}
                              onChange={changeModel}
                              reasoningEffort={reasoningEffort}
                              onReasoningChange={changeReasoning}
                            />
                          </div>

                          {/* Thinking Slider / Reasoning Depth Control */}
                          {isAuto && (
                            <>
                              <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-disabled
                                    className="h-8 w-[4.75rem] shrink-0 cursor-default justify-center gap-1 rounded-composer-control px-2 font-mono text-label tracking-tight text-muted-foreground opacity-70 hover:bg-transparent"
                                  >
                                    <Sparkles className="size-3 text-primary/70" />
                                    <span>Auto</span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
                              </Tooltip>
                            </>
                          )}

                          {!isAuto && effortOptions.length > 0 && (() => {
                            const clamped = modelInfo ? clampReasoningEffort(modelInfo, reasoningEffort) : reasoningEffort;
                            const current = effortOptions.find((e) => e.value === clamped) ?? effortOptions[0];
                            const label = current.label === "Extra high" ? "X-high" : current.label;
                            const atTop = effortOptions.length > 1 && current.value === effortOptions[effortOptions.length - 1].value;

                            return (
                              <>
                                <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                                <Tooltip>
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <TooltipTrigger asChild>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          disabled={submitting}
                                          aria-label={`Thinking effort: ${current.label}`}
                                          className={cn(
                                            "composer-chip group h-8 shrink-0 items-center justify-between gap-1.5 rounded-composer-control px-2.5 font-mono text-ui tracking-tight coarse:h-11 min-[360px]:w-[5.25rem] min-[480px]:w-[6.25rem]",
                                            atTop ? "text-primary" : "text-foreground"
                                          )}
                                        >
                                          <span className="min-w-0 flex-1 truncate text-center">{label}</span>
                                          <ChevronDown className="size-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                                        </Button>
                                      </TooltipTrigger>
                                    </PopoverTrigger>
                                    <PopoverContent
                                      align="start"
                                      sideOffset={10}
                                      className="w-[300px] origin-popper rounded-2xl border border-border/80 bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#161618]/95"
                                    >
                                      <ReasoningSlider
                                        options={effortOptions}
                                        value={reasoningEffort}
                                        onChange={changeReasoning}
                                        disabled={submitting}
                                        fastMode={fastMode}
                                        onFastModeChange={setFastMode}
                                        proMode={proMode}
                                        onProModeChange={setProMode}
                                      />
                                    </PopoverContent>
                                  </Popover>
                                  <TooltipContent>Thinking effort & depth</TooltipContent>
                                </Tooltip>
                              </>
                            );
                          })()}
                        </div>

                        {/* Right: Mic Dictation + Send Button */}
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
                                    disabled={submitting || dictating || codeVoice.open}
                                    aria-label="Dictate"
                                    aria-pressed={dictating}
                                    className="composer-mic-button rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                                  >
                                    <Mic className="composer-mic-icon h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Dictate</TooltipContent>
                              </Tooltip>
                              <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                            </>
                          )}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                onClick={
                                  showVoiceButton && codeVoice.onOpenVoiceMode
                                    ? codeVoice.onOpenVoiceMode
                                    : () => void submit()
                                }
                                disabled={showVoiceButton ? false : !canSubmit}
                                aria-label={
                                  showVoiceButton
                                    ? "Talk this through with Juno"
                                    : !hasTarget
                                      ? gateHint ?? "Select where to run first"
                                      : target === "cloud"
                                        ? "Start a cloud run"
                                        : "Start the session"
                                }
                                className="composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[color,background-color,border-color,box-shadow,transform] duration-base ease-out-strong"
                              >
                                {submitting ? (
                                  <Loader2 key="starting" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" aria-hidden="true" />
                                ) : showVoiceButton ? (
                                  <span key="voice" className="composer-voice-wave motion-safe:animate-fade-in" aria-hidden="true">
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                    <span />
                                  </span>
                                ) : (
                                  <ArrowUp key="send" className="composer-send-icon h-4 w-4 motion-safe:animate-fade-in" aria-hidden="true" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {showVoiceButton
                                ? "Voice conversation"
                                : target === "cloud"
                                  ? "Start cloud run"
                                  : "Start session"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </>
                    }
                    utility={
                      <div className="flex w-full min-w-0 items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
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
                              if (r.fullName !== selectedRepo?.fullName) discardOrphanCloudSession();
                            }}
                            baseRef={baseRef}
                            onBaseRefChange={setBaseRef}
                            disabled={submitting}
                            className="h-7"
                          />

                          {target === "cloud" && selectedRepo && (
                            <>
                              <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                              <span className="hidden min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground sm:flex">
                                <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                                <span className="sr-only">Base branch </span>
                                <span className="min-w-0 truncate">
                                  {baseRef.trim() || selectedRepo.defaultBranch}
                                </span>
                              </span>
                            </>
                          )}
                        </div>

                        <PermissionFact target={target} />
                      </div>
                    }
                  />

                  {dragging && <ComposerDropOverlay />}

                  <ComposerFileInputs
                    imageInputRef={imageInputRef}
                    fileInputRef={fileInputRef}
                    onFiles={addFiles}
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
            </div>

            {/* Error notifications */}
            {cloudStartError === "not_configured" && (
              <p
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-warning-foreground motion-safe:animate-rise-in"
              >
                <StatusIcons.warning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  Cloud runs aren’t enabled on this server yet. Ask an admin to configure the cloud runner, or switch to{" "}
                  <button
                    type="button"
                    onClick={() => switchTarget("device")}
                    className="rounded-xs font-medium underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground"
                  >
                    Device
                  </button>{" "}
                  to run on your Mac.
                </span>
              </p>
            )}

            {cloudStartError === "dispatch_failed" && (
              <div
                role="alert"
                className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-field border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive motion-safe:animate-rise-in"
              >
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Couldn’t start the cloud run — this is usually temporary.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/20 hover:text-destructive coarse:h-11"
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CodeIcons.refresh className="size-3.5" aria-hidden="true" />
                  )}
                  Try again
                </Button>
              </div>
            )}

            <p className="mt-3 text-center text-caption text-muted-foreground">
              {gateHint && !cloudStartError ? (
                <span className="text-foreground/70">{gateHint}. </span>
              ) : null}
              {target === "cloud"
                ? "Runs on a fresh cloud runner and opens a pull request to review."
                : "Runs with Juno Code on your Mac and streams the output directly."}
            </p>
          </div>

          {/* Workflow Prompt Presets */}
          <CodePresetsGrid onSelectPreset={onSelectPreset} />
        </div>
      </div>
    </div>
  );
}
