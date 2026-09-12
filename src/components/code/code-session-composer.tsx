"use client";

import * as React from "react";
import { AudioLines, Loader2, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerFieldClass,
  composerIconButtonClass,
  type ComposerPrimaryFace,
} from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { AppIcons, CodeIcons } from "@/lib/app-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import { reasoningOptions, type ReasoningEffort } from "@/lib/model-metrics";
import { cn } from "@/lib/utils";
import type { ClientAttachment } from "@/types/chat";
import type { PendingUpload } from "@/hooks/use-uploads";
import type { CodeSessionStatus } from "@/hooks/use-code-session";
import type { PresenceState } from "@/components/code/code-session-meta";
import {
  ComposerAddMenu,
  ComposerAttachmentTray,
  ComposerDropOverlay,
  ComposerFileInputs,
} from "@/components/code/code-composer-parts";

export interface CodeSessionComposerProps {
  above: React.ReactNode;
  voicePanel: React.ReactNode;

  resolving: boolean;
  isCloud: boolean;
  workspaceName: string;
  workspacePath: string | null;
  cloudRepoFull: string | null;
  baseRef: string | null;
  presenceState: PresenceState;

  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;

  blockedReason: string | null;
  canSend: boolean;
  onSubmit: () => void;

  status: CodeSessionStatus;
  isBusy: boolean;
  onCancel: () => void;

  /**
   * Mid-run steering. `canSteer` is the session's own answer (a run that is
   * running, or a device run waiting on an approval — a cloud run reads its
   * controls between agent steps, so it takes one too); `steerReady` narrows it to
   * "there is text to send and nothing staged that a steer cannot carry".
   * While `canSteer` the field stays live and the primary action's send face
   * reads "Send to running task"; Stop is what the circle shows when the
   * field is empty, because that is the other thing left to press.
   */
  canSteer: boolean;
  steerReady: boolean;
  onSteer: () => void;

  // Model & thinking. Effort lives inside the model chip's popover (the
  // `thinking` footer slot), never as a chip of its own on the row.
  model?: string;
  onModelChange?: (model: string) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;

  attachments: {
    enabled: boolean;
    uploads: PendingUpload[];
    onRemove: (localId: string) => void;
    onAddFiles: (files: FileList) => void;
    onAddAttachments: (attachments: ClientAttachment[]) => void;
  };

  dictation: {
    supported: boolean;
    active: boolean;
    onStart: () => void;
    onCancel: () => void;
    onStop: (transcript: string) => void;
    onSend: (transcript: string) => void;
  };

  voice: {
    open: boolean;
    onOpen: (() => void) | undefined;
  };
}

/**
 * The composer at the bottom of a Code session: the shared single surface.
 *
 * One row, in the shell's order — `+` on the left; on the right the run
 * context as a quiet chip, the model chip (with thinking effort inside it),
 * the dictate and voice icon buttons, then the primary action. Nothing on the
 * row is a permanent badge: the "Auto" tag, the effort chip and the
 * connectors chip that used to sit here are gone, because a row that shows
 * every option at once reads as a settings panel (docs/design/FLAT_UI.md §4).
 *
 * The field does not go dark while a device run is going. It used to — the
 * only verb left was Stop — so a reader who watched the agent head the wrong
 * way had to kill the run and start over. Now typed text goes INTO the run as
 * its next instruction (see `useCodeSession.steer`), and the send circle
 * names that verb.
 */
export function CodeSessionComposer({
  above,
  voicePanel,
  resolving,
  isCloud,
  workspaceName,
  workspacePath,
  cloudRepoFull,
  baseRef,
  presenceState,
  draft,
  onDraftChange,
  textareaRef,
  blockedReason,
  canSend,
  onSubmit,
  status,
  isBusy,
  onCancel,
  canSteer,
  steerReady,
  onSteer,
  model = DEFAULT_MODEL,
  onModelChange,
  reasoningEffort = null,
  onReasoningChange,
  attachments,
  dictation,
  voice,
}: CodeSessionComposerProps) {
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const blockedId = React.useId();

  // Locked means "nothing can be typed": submitting, stopping, or queued —
  // including a cloud task whose runner has not claimed it yet, which has no
  // process to read an instruction. A steerable run leaves the field open.
  const locked = isBusy && !canSteer;
  const settling = status === "stopping" || status === "submitting";
  const dropEnabled = attachments.enabled && !isBusy && !dictation.active;

  const modelInfo = React.useMemo(() => resolveModel(model), [model]);
  const effortOptions = React.useMemo(() => (modelInfo ? reasoningOptions(modelInfo) : []), [modelInfo]);
  const isAuto = isAutoModelId(model);

  // The effort control rides INSIDE the model chip, as the chat composer
  // mounts it — one chip for one decision. Absent for Auto (the model picks
  // its own depth) and for models with a single tier.
  const thinkingControl =
    isAuto || !modelInfo || effortOptions.length < 2 || !onReasoningChange ? null : (
      <ReasoningSlider
        options={effortOptions}
        value={reasoningEffort}
        onChange={onReasoningChange}
        disabled={locked}
      />
    );

  /*
   * Which face the circle wears, and what pressing it does.
   *
   *   settling             busy      (disabled — a stop or a start is in flight)
   *   steerable + text     send      "Send to running task"
   *   busy otherwise       stop
   *   idle                 send
   *
   * `voice` is never one of them: voice is its own icon button beside the
   * mic, because a second verb in the one accent-coloured control was the
   * thing people pressed by accident most.
   */
  const face: ComposerPrimaryFace = settling ? "busy" : isBusy ? (steerReady ? "send" : "stop") : "send";
  const primaryLabel = settling
    ? status === "stopping"
      ? "Stopping task"
      : "Starting task"
    : face === "stop"
      ? "Stop this task"
      : isBusy
        ? "Send to running task"
        : isCloud
          ? "Start a cloud run"
          : "Send to your Mac";
  const primaryTip = settling
    ? status === "stopping"
      ? "Stopping…"
      : "Starting…"
    : face === "stop"
      ? "Stop"
      : isBusy
        ? "Send to running task"
        : "Send";
  const onPrimary = face === "stop" ? onCancel : isBusy ? onSteer : onSubmit;
  const primaryDisabled = settling || (face === "send" && !(isBusy ? steerReady : canSend));

  const runLabel = resolving ? "Getting this session ready…" : isCloud ? (cloudRepoFull ?? workspaceName) : workspaceName;

  const placeholder = canSteer
    ? "Add an instruction to the running task…"
    : isCloud
      ? `Describe the change to make in ${cloudRepoFull ?? "the repo"}…`
      : presenceState === "offline"
        ? "Describe the change — it sends when your Mac reconnects…"
        : "Describe what to build or fix…";

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      {above}
      {blockedReason && (
        <p id={blockedId} className="sr-only">
          {blockedReason}
        </p>
      )}

      <div className="relative isolate w-full">
        {voicePanel}

        <DictationSwap
          active={dictation.active}
          onCancel={dictation.onCancel}
          onClose={(transcript, sendNow) => (sendNow ? dictation.onSend(transcript) : dictation.onStop(transcript))}
        >
          <div
            onDragOver={(e) => {
              if (!dropEnabled) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (dropEnabled && e.dataTransfer.files.length) attachments.onAddFiles(e.dataTransfer.files);
            }}
            className="relative w-full"
          >
            <ComposerShell
              className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
              dimmed={locked}
              above={
                attachments.enabled && (
                  <ComposerAttachmentTray uploads={attachments.uploads} onRemove={attachments.onRemove} />
                )
              }
              field={
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (isBusy) {
                        if (steerReady) onSteer();
                      } else if (canSend) {
                        onSubmit();
                      }
                    }
                  }}
                  rows={1}
                  disabled={locked}
                  placeholder={placeholder}
                  aria-label={canSteer ? "Instruction for the running task" : "Prompt for this code session"}
                  aria-describedby={blockedReason ? blockedId : undefined}
                  className={composerFieldClass}
                />
              }
              leading={
                attachments.enabled && (
                  // Attachments cannot ride a steer, so the `+` rests while a
                  // run is going even though the field does not.
                  <ComposerAddMenu
                    open={plusOpen}
                    onOpenChange={setPlusOpen}
                    disabled={isBusy}
                    onPickPhotos={() => imageInputRef.current?.click()}
                    onPickFiles={() => fileInputRef.current?.click()}
                    onPickLibrary={() => setLibraryOpen(true)}
                  />
                )
              }
              trailing={
                <>
                  {/* Where this runs: a fact, in the chip's own ink and
                      height, not a control. It truncates first. */}
                  <span
                    title={isCloud ? (cloudRepoFull ?? undefined) : (workspacePath ?? undefined)}
                    className="hidden h-8 min-w-0 items-center gap-1.5 px-2 text-ui text-muted-foreground sm:flex coarse:h-10"
                  >
                    {resolving ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                    ) : isCloud ? (
                      <CodeIcons.cloud className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <AppIcons.projects className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {!resolving && <span className="sr-only">Runs in </span>}
                    <span className="min-w-0 max-w-[12rem] truncate">{runLabel}</span>
                    {!resolving && isCloud && baseRef && (
                      <>
                        <span aria-hidden="true" className="text-border">·</span>
                        <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Base branch </span>
                        <span className="min-w-0 max-w-[8rem] truncate">{baseRef}</span>
                      </>
                    )}
                  </span>

                  {onModelChange && (
                    <div className={cn("min-w-0", locked && "pointer-events-none")}>
                      <ModelSelector
                        value={model}
                        onChange={onModelChange}
                        disabled={locked}
                        thinking={thinkingControl}
                      />
                    </div>
                  )}

                  {dictation.supported && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={dictation.onStart}
                          disabled={locked || dictation.active || voice.open}
                          aria-label="Dictate"
                          aria-pressed={dictation.active}
                          className={composerIconButtonClass}
                        >
                          <Mic className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Dictate</TooltipContent>
                    </Tooltip>
                  )}

                  {voice.onOpen && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={voice.onOpen}
                          disabled={dictation.active || voice.open}
                          aria-label="Talk this session through with Juno"
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
                      face={face}
                      onClick={onPrimary}
                      disabled={primaryDisabled}
                      aria-label={primaryLabel}
                    />
                  </TooltipTrigger>
                  <TooltipContent>{primaryTip}</TooltipContent>
                </Tooltip>
              }
            />

            {dragging && <ComposerDropOverlay />}

            <ComposerFileInputs
              imageInputRef={imageInputRef}
              fileInputRef={fileInputRef}
              onFiles={attachments.onAddFiles}
            />
            {attachments.enabled && (
              <LibraryPicker
                open={libraryOpen}
                onOpenChange={setLibraryOpen}
                onAttach={attachments.onAddAttachments}
                existingCount={attachments.uploads.length}
              />
            )}
          </div>
        </DictationSwap>
      </div>
    </div>
  );
}
