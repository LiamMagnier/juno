"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AudioLines, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerFieldClass,
  composerIconButtonClass,
  useComposerAutosize,
} from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
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
import { CodeSeedPrompts } from "@/components/code/code-presets";
import { CodeSurfaceNav } from "@/components/code/code-surface-nav";
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { AppIcons, CodeIcons } from "@/lib/app-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import { defaultReasoning, reasoningOptions, type ReasoningEffort } from "@/lib/model-metrics";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { cn } from "@/lib/utils";
import type { ClientAttachment, ClientConversation } from "@/types/chat";

const TARGET_KEY = "juno:code:new:target";
const MODEL_KEY = "juno:code:model";
const EFFORT_KEY = "juno:code:reasoning";

/**
 * What `GET /api/code/cloud-runner` says. `null` while unasked or in flight;
 * a not-ready answer carries the sentence the server wants shown.
 */
type CloudReadiness = { ready: true } | { ready: false; message: string } | null;

/** What the run may do without asking — said in the caption under the composer. */
function PermissionFact({ target }: { target: Target }) {
  const cloud = target === "cloud";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          {cloud ? "Full access, reviewed as a PR" : "Asks before changes"}
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

/*
 * `/code/new` — the first of the three Code views, drawn like the other two.
 *
 * It used to be a sticky tab strip over a marketing hero ("What are we
 * building today, Liam?" at display size) over the composer, while `/code`
 * and `/code/pulls` were `AppPage` + `AppPageHeader` + the view switcher. The
 * tab strip sat in a different place on each tab of one surface, and the
 * loading skeleton drew a header the page never had, so the column shifted
 * on every entry. This is the same frame as the other two, byte for byte,
 * with the composer in a centred column under it and the seed prompts the
 * run list's empty state already offers — one set of seeds, not two.
 *
 * It no longer mounts `useCodeRuns` for a "Latest run" link: that hook polls
 * the whole run list and the device list every six seconds, and this page
 * has nothing to do with either. The Runs tab is one press away.
 */
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
      if (next !== "cloud") discardOrphanCloudSession();
      try {
        localStorage.setItem(TARGET_KEY, next);
      } catch {}
    },
    [discardOrphanCloudSession],
  );

  /*
   * WHETHER A CLOUD RUN CAN START, asked once the Cloud target is chosen.
   *
   * The server probes for its runner workflow before it creates any task, and
   * a missing one used to surface only as a 503 on the submit. Asking here
   * puts the same sentence under the composer before the reader has written
   * anything — a quiet note, not a modal, because the Device target one chip
   * away still works.
   */
  const [cloudReadiness, setCloudReadiness] = React.useState<CloudReadiness>(null);
  React.useEffect(() => {
    if (target !== "cloud" || cloudReadiness) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/code/cloud-runner", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { ready?: boolean; message?: string };
        if (cancelled) return;
        setCloudReadiness(
          data.ready
            ? { ready: true }
            : { ready: false, message: data.message ?? "Cloud runs aren’t enabled on this server yet." },
        );
      } catch {
        // Unknown stays unknown; the submit path says what the server says.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, cloudReadiness]);
  const cloudBlocked = target === "cloud" && cloudReadiness?.ready === false ? cloudReadiness : null;

  // —— Workspace / Repository Selection ——
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<Workspace | null>(null);
  const [selectedRepo, setSelectedRepo] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");

  // —— Model ——
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

  // —— Thinking effort (inside the model chip) ——
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
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  // The shared composer growth: one line at rest, eight before it scrolls.
  const autoresize = useComposerAutosize(textareaRef, prompt);

  React.useEffect(() => {
    try {
      const seed = new URLSearchParams(window.location.search).get("seed");
      if (seed?.trim()) setPrompt((current) => (current.trim() ? current : seed));
    } catch {}
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const hasTarget = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  const hasPayload = prompt.trim().length > 0 || readyAttachments.length > 0;
  const canSubmit = hasTarget && hasPayload && !submitting && !isUploading && !cloudBlocked;

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
        }),
      });
      if (!res.ok) throw new Error("conversation");
      const { conversation } = (await res.json()) as { conversation: ClientConversation };
      setPendingCodePrompt(conversation.id, text, attachments);
      upsertConversation({ ...conversation, model });
      router.push(`/chat/${conversation.id}`);
      return true;
    },
    [model, router, upsertConversation],
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
          // The page's own model picker and thinking control, reaching the run.
          model,
          reasoningEffort: reasoningEffort ?? undefined,
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
        return true;
      }

      const payload = (await tRes.json().catch(() => ({}))) as { error?: string; message?: string };
      const err = payload.error;
      if (tRes.status === 503 && err === "cloud_runner_not_configured") {
        // The server says why, in a sentence written to be shown. Nothing was
        // created server-side, so the conversation this page made is an orphan.
        setCloudReadiness({
          ready: false,
          message: payload.message ?? "Cloud runs aren’t enabled on this server yet.",
        });
        discardOrphanCloudSession();
      } else if (tRes.status === 502 && err === "cloud_dispatch_failed") {
        /*
         * The task and the user's turn exist and are marked failed, and the
         * conversation shows them. Take the reader there rather than keeping an
         * orphan here with a "Try again" that would stack a second failed task
         * into the same conversation.
         */
        toast.error(payload.message ?? "Couldn’t start the cloud run — this is usually temporary.");
        if (conversation) upsertConversation({ ...conversation, title: titleFallback.slice(0, 48), titleSource: "manual", model });
        cloudConversationId.current = null;
        clear();
        router.push(`/chat/${conversationId}`);
      } else if (tRes.status === 400 && err === "github_not_connected") {
        toast.error("Connect GitHub in Connections before starting a cloud run.");
        discardOrphanCloudSession();
      } else if (tRes.status === 409 && err === "attachment_claim_failed") {
        toast.error("One of the attached files is no longer available. Remove it and try again.");
        discardOrphanCloudSession();
      } else {
        /*
         * Anything else: say what the SERVER said, when it said something.
         * The quota refusals arrive as prose in `error` — anything with a
         * space in it is a sentence meant to be read, not a code.
         */
        const sentence =
          payload.message?.trim() ||
          (err && /\s/.test(err) ? err : "") ||
          "Could not start the cloud run. Check your connection and try again.";
        toast.error(sentence);
        discardOrphanCloudSession();
      }
      return false;
    },
    [clear, discardOrphanCloudSession, model, reasoningEffort, router, upsertConversation],
  );

  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const text = (overrideText ?? prompt).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || submitting || isUploading) return false;
      if (target === "device" ? !selectedWorkspace : !selectedRepo) return false;
      if (cloudBlocked) return false;

      setSubmitting(true);
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
      cloudBlocked,
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
      if (!(target === "device" ? selectedWorkspace : selectedRepo) || cloudBlocked) {
        setPrompt(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      void submit(merged);
    },
    [autoresize, cloudBlocked, prompt, readyAttachments.length, selectedRepo, selectedWorkspace, submit, target],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSubmit) void submit();
    }
  };

  const gateHint = !hasTarget
    ? target === "device"
      ? "Pick a project to start"
      : "Pick a repository to start"
    : null;

  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "new",
      target,
      place: target === "device" ? (selectedWorkspace?.name ?? null) : (selectedRepo?.fullName ?? null),
      baseRef: target === "cloud" ? ((baseRef.trim() || selectedRepo?.defaultBranch) ?? null) : null,
      turns: [],
      blocked: cloudBlocked?.message ?? gateHint,
    }),
    [baseRef, cloudBlocked, gateHint, selectedRepo, selectedWorkspace, target],
  );

  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "start",
      blockedReason: cloudBlocked
        ? cloudBlocked.message
        : gateHint
          ? `${gateHint} — then these words can start it.`
          : null,
      sending: submitting,
      endsCall: true,
      onSend: (text: string) => submit([prompt.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [cloudBlocked, gateHint, prompt, submit, submitting],
  );

  const effortOptions = React.useMemo(() => (modelInfo ? reasoningOptions(modelInfo) : []), [modelInfo]);
  const isAuto = isAutoModelId(model);
  // Effort lives inside the model chip's popover, as every composer mounts it.
  const thinkingControl =
    isAuto || !modelInfo || effortOptions.length < 2 ? null : (
      <ReasoningSlider
        options={effortOptions}
        value={reasoningEffort}
        onChange={changeReasoning}
        disabled={submitting}
      />
    );

  const onSelectSeed = React.useCallback(
    (seed: string) => {
      setPrompt(seed);
      requestAnimationFrame(() => {
        autoresize();
        textareaRef.current?.focus();
      });
    },
    [autoresize],
  );

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Code"
        heading="New session"
        icon={AppIcons.code}
        lede="Describe a task. It runs with Juno Code on your Mac, or on a fresh cloud machine that opens a pull request."
      />
      <CodeSurfaceNav active="new" />

      <div className="mx-auto w-full max-w-[44rem] pt-6">
        <div className="relative isolate w-full">
          {codeVoice.open && (
            <CodeVoicePanel briefing={voiceBriefing} send={voiceSend} onClose={codeVoice.close} />
          )}

          <DictationSwap active={dictating} onCancel={() => setDictating(false)} onClose={closeDictation}>
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
              className="relative w-full"
            >
              <ComposerShell
                className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
                dimmed={submitting}
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
                    className={composerFieldClass}
                  />
                }
                leading={
                  canAttach && (
                    <ComposerAddMenu
                      open={plusOpen}
                      onOpenChange={setPlusOpen}
                      disabled={submitting}
                      onPickPhotos={() => imageInputRef.current?.click()}
                      onPickFiles={() => fileInputRef.current?.click()}
                      onPickLibrary={() => setLibraryOpen(true)}
                    />
                  )
                }
                trailing={
                  <>
                    {/* Where it runs — a context chip on the right, ahead of
                        the model chip, never a second strip. */}
                    <CodeTargetPicker
                      target={target}
                      onTargetChange={switchTarget}
                      selectedWorkspace={selectedWorkspace}
                      onSelectWorkspace={setSelectedWorkspace}
                      selectedRepo={selectedRepo}
                      onSelectRepo={(r) => {
                        setSelectedRepo(r);
                        setBaseRef("");
                        if (r.fullName !== selectedRepo?.fullName) discardOrphanCloudSession();
                      }}
                      baseRef={baseRef}
                      onBaseRefChange={setBaseRef}
                      disabled={submitting}
                    />

                    <div className={cn("min-w-0", submitting && "pointer-events-none")}>
                      <ModelSelector
                        value={model}
                        onChange={changeModel}
                        disabled={submitting}
                        thinking={thinkingControl}
                      />
                    </div>

                    {speechSupported && (
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
                            className={composerIconButtonClass}
                          >
                            <Mic className="size-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Dictate</TooltipContent>
                      </Tooltip>
                    )}

                    {codeVoice.onOpenVoiceMode && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={codeVoice.onOpenVoiceMode}
                            disabled={submitting || dictating || codeVoice.open}
                            aria-label="Talk this through with Juno"
                            className={composerIconButtonClass}
                          >
                            <AudioLines className="size-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Voice conversation</TooltipContent>
                      </Tooltip>
                    )}
                  </>
                }
                action={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ComposerPrimaryAction
                        face={submitting ? "busy" : "send"}
                        onClick={() => void submit()}
                        disabled={!canSubmit}
                        aria-label={
                          cloudBlocked
                            ? cloudBlocked.message
                            : !hasTarget
                              ? (gateHint ?? "Select where to run first")
                              : target === "cloud"
                                ? "Start a cloud run"
                                : "Start the session"
                        }
                      />
                    </TooltipTrigger>
                    <TooltipContent>{target === "cloud" ? "Start cloud run" : "Start session"}</TooltipContent>
                  </Tooltip>
                }
              />

              {dragging && <ComposerDropOverlay />}

              <ComposerFileInputs imageInputRef={imageInputRef} fileInputRef={fileInputRef} onFiles={addFiles} />
              {canAttach && (
                <LibraryPicker
                  open={libraryOpen}
                  onOpenChange={setLibraryOpen}
                  onAttach={addAttachments}
                  existingCount={uploads.length}
                />
              )}
            </div>
          </DictationSwap>
        </div>

        {/*
          THE CLOUD RUNNER IS NOT THERE, said quietly. A note in the muted ink
          under the field rather than an alert or a modal: the reader can still
          run on their Mac, and the sentence names the way there.
        */}
        {cloudBlocked && (
          <p role="status" className="mt-2.5 flex items-start gap-2 px-1 text-caption text-muted-foreground">
            <CodeIcons.cloud className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {cloudBlocked.message}{" "}
              <button
                type="button"
                onClick={() => switchTarget("device")}
                className="rounded-xs font-medium text-foreground underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-primary motion-reduce:transition-none"
              >
                Run on your Mac instead
              </button>
              .
            </span>
          </p>
        )}

        <p className="mt-3 text-center text-caption text-muted-foreground">
          {gateHint && !cloudBlocked ? <span className="text-foreground/70">{gateHint}. </span> : null}
          {target === "cloud"
            ? "Runs on a fresh cloud runner and opens a pull request to review. "
            : "Runs with Juno Code on your Mac and streams the output directly. "}
          <PermissionFact target={target} />
        </p>

        <CodeSeedPrompts onSelect={onSelectSeed} className="mt-6" />
      </div>
    </AppPage>
  );
}
