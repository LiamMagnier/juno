"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AudioLines, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerChipClass,
  composerFieldClass,
  composerIconButtonClass,
  useComposerAutosize,
} from "@/components/ui/composer-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import {
  CodeEnvironmentChip,
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
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { CodeIcons } from "@/lib/app-icons";
import { CODE_PERMISSIONS } from "@/lib/code-environment";
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

/**
 * WHAT THIS RUN MAY DO WITHOUT ASKING — a chip on the controls row, and
 * deliberately NOT a dropdown.
 *
 * docs/design/TWO_PRODUCTS.md §3 puts a permission mode here, and this is the
 * honest version of it. The mode is real: a device run pauses for approval, a
 * cloud run has the whole sandbox and is read as a pull request afterwards.
 * What does not exist is a way to CHOOSE a different one — `CodeTask` has no
 * column for a permission mode and neither runner reads one — so a picker here
 * would offer four options that decide nothing, which is the precise defect the
 * `model` / `reasoningEffort` columns were added to end (prisma/schema.prisma:
 * "Four visible controls decided nothing"). The mode IS chosen, by the
 * environment chip one row up; this states the consequence of that choice where
 * it is read before send rather than discovered after it.
 *
 * It replaces a caption that used to sit under the field saying the same thing
 * in two sentences. On a composer pinned to the bottom of the page, prose under
 * the field is the first thing to go.
 *
 * Two words on the chip, the sentence one press down — and that is a width
 * constraint as much as an editorial one; see the note on `CodePermission.mode`
 * for what a long label does to this cluster on a phone.
 */
function PermissionChip({ target }: { target: Target }) {
  const permission = CODE_PERMISSIONS[target];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // The visible words are in the accessible name (WCAG 2.5.3), and the
          // rest says what pressing it gets you, since the chip explains rather
          // than changes.
          aria-label={`${permission.mode}. What this run may do without asking`}
          className={cn(composerChipClass, "max-w-full")}
        >
          <CodeIcons.permission className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{permission.mode}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} collisionPadding={12} className="w-72 p-3">
        <p className="text-ui leading-relaxed text-muted-foreground">
          {permission.detail}{" "}
          <span className="text-foreground">Change it by changing where this runs.</span>
        </p>
      </PopoverContent>
    </Popover>
  );
}

/*
 * THE CODE COMPOSER — the whole of what `/code` is, under the greeting.
 *
 * It used to be page-local JSX inside `/code/new`: the field, the target
 * picker, the model chip, the effort control and both submit paths written
 * straight into a route, so nothing else in the product could mount them. That
 * mattered the moment Code stopped having a list page to land on
 * (docs/design/TWO_PRODUCTS.md §3) — the landing needs this box, and a route
 * cannot be rendered inside another route.
 *
 * THE SHAPE, and where each part of it comes from:
 *
 *   above     the two facts a run needs before it can start — which machine,
 *             which checkout — as chips on their own row, plus the staged
 *             attachments under them
 *   field     "Describe a task or ask a question"
 *   leading   `+` · dictate · voice · the permission chip
 *   trailing  the model chip, with thinking effort inside its popover
 *   action    send ⇄ busy — the one circle, and the run's status while it
 *             starts
 *
 * Effort is inside the model popover rather than beside it because FLAT_UI.md
 * §4 says so and because every other composer in the product already puts it
 * there; a row that shows every option at once reads as a settings panel and
 * the field above it stops being the point.
 *
 * WHAT IS NOT HERE. The seed-prompt chips are gone with the list page that
 * offered them — on a composer pinned to the bottom of the column there is no
 * room under the field for a second set of things to press, and the greeting
 * above it is the invitation. The footer caption that spelled out where a run
 * happens is gone too: the chips say it, and the permission chip says what it
 * means. One line survives under the field, and only when there is something
 * true to say — a cloud runner this server does not have, or the pick that is
 * still missing.
 */
export function CodeComposer({ className }: { className?: string }) {
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
          // This composer's model picker and thinking control, reaching the run.
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
        // created server-side, so the conversation this composer made is an
        // orphan.
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
          "Couldn’t start the cloud run. Check your connection and try again.";
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
        toast.error("Couldn’t start the session. Check your connection and try again.");
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

  return (
    <div className={cn("relative isolate w-full", className)}>
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
            above={
              <>
                {/* The context row. `px-2.5` is the controls row's inset, so the
                    first chip's left edge lands on the `+` below it and the two
                    rows read as one column hanging just outside the text. */}
                <div className="flex flex-wrap items-center gap-1 px-2.5 pb-0.5 pt-2">
                  <CodeEnvironmentChip target={target} onTargetChange={switchTarget} disabled={submitting} />
                  <CodeTargetPicker
                    target={target}
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
                </div>
                {canAttach && <ComposerAttachmentTray uploads={uploads} onRemove={remove} />}
              </>
            }
            field={
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={submitting}
                // The placeholder is the accessible name, as it is on the chat
                // composer. It used to carry `aria-label="Describe the task for
                // this Juno Code session"` as well, which won — leaving a field
                // whose visible words appeared nowhere in its accessible name,
                // i.e. the WCAG 2.5.3 label-in-name failure the base-branch
                // input in code-target-picker.tsx was already fixed for, and a
                // field no voice user could address by the words inside it.
                placeholder="Describe a task or ask a question…"
                className={composerFieldClass}
              />
            }
            leading={
              <>
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

                <PermissionChip target={target} />
              </>
            }
            trailing={
              <div className={cn("min-w-0", submitting && "pointer-events-none")}>
                <ModelSelector
                  value={model}
                  onChange={changeModel}
                  disabled={submitting}
                  thinking={thinkingControl}
                />
              </div>
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

      {/*
        NOTHING UNDER THE FIELD UNLESS THE SERVER HAS NEWS.

        Three paragraphs used to live here: a permanent sentence naming where
        the run happens, a permanent one naming what it may do, and a gate hint
        reading "Pick a project to start". The first two are the chips above and
        the permission chip below. The third was the same words a third time —
        the repository chip's own empty label IS "Pick a project", in muted ink,
        directly above the field — and on a composer pinned to the bottom of the
        page it also made the box hop up twenty pixels the moment you picked
        one, which is a layout shift charged to the reader for reading a
        sentence they had already read.

        What is left is the one thing no chip can say: this server has no cloud
        runner. Said quietly, in muted ink, rather than as an alert — the reader
        can still run on their Mac, and the sentence names the way there.
      */}
      {cloudBlocked && (
        <p role="status" className="mt-2.5 flex items-start justify-center gap-2 px-1 text-caption text-muted-foreground">
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
    </div>
  );
}
