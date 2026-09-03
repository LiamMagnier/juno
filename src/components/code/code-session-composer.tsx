"use client";

import * as React from "react";
import { ChevronDown, Loader2, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ComposerDivider,
  ComposerPrimaryAction,
  ComposerShell,
  composerChevronClass,
  composerChipClass,
  composerFieldClass,
  composerIconButtonClass,
} from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { CodeConnectorsMenu } from "@/components/code/code-connectors-menu";
import { AppIcons, CodeIcons } from "@/lib/app-icons";
import { resolveModel, DEFAULT_MODEL } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import {
  clampReasoningEffort,
  reasoningOptions,
  type ReasoningEffort,
} from "@/lib/model-metrics";
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
  hasPayload: boolean;
  onSubmit: () => void;

  status: CodeSessionStatus;
  isBusy: boolean;
  onCancel: () => void;

  // Model & Reasoning
  model?: string;
  onModelChange?: (model: string) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;

  // Connectors
  connectorsEnabled?: string[];
  onToggleConnector?: (id: string) => void;

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
 * One row of controls. Where the session runs — the workspace or the cloud
 * repo, and its base branch — is a quiet fact on the left of that row rather
 * than a second strip under it; the run context that used to live on a
 * hairline-separated tier sits inline, in the muted ink, and truncates first.
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
  hasPayload: _hasPayload,
  onSubmit,
  status,
  isBusy,
  onCancel,
  model = DEFAULT_MODEL,
  onModelChange,
  reasoningEffort = null,
  onReasoningChange,
  connectorsEnabled = [],
  onToggleConnector,
  attachments,
  dictation,
  voice,
}: CodeSessionComposerProps) {
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [fastMode, setFastMode] = React.useState(false);
  const [proMode, setProMode] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const blockedId = React.useId();

  const showVoiceButton = !isBusy && !_hasPayload && !!voice.onOpen;
  const dropEnabled = attachments.enabled && !isBusy && !dictation.active;

  const modelInfo = React.useMemo(() => resolveModel(model), [model]);
  const effortOptions = React.useMemo(
    () => (modelInfo ? reasoningOptions(modelInfo) : []),
    [modelInfo],
  );
  const isAuto = isAutoModelId(model);

  const face = isBusy
    ? status === "stopping" || status === "submitting"
      ? "busy"
      : "stop"
    : showVoiceButton
      ? "voice"
      : "send";

  const runLabel = resolving
    ? "Getting this session ready…"
    : isCloud
      ? (cloudRepoFull ?? workspaceName)
      : workspaceName;

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

        <div
          className={cn(
            "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
            dictation.active ? "min-h-[170px]" : "min-h-[68px]",
          )}
        >
          <div
            inert={!dictation.active}
            className={cn(
              "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
              dictation.active
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-1 scale-95 opacity-0",
            )}
          >
            {dictation.active && (
              <ComposerDictation
                onCancel={dictation.onCancel}
                onStop={dictation.onStop}
                onSend={dictation.onSend}
              />
            )}
          </div>

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
            inert={dictation.active}
            className={cn(
              "col-start-1 row-start-1 relative w-full origin-center",
              "transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
              dictation.active
                ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0"
                : "translate-y-0 scale-100 opacity-100",
            )}
          >
            <ComposerShell
              className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
              dimmed={isBusy}
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
                      if (canSend) onSubmit();
                    }
                  }}
                  rows={1}
                  disabled={isBusy}
                  placeholder={
                    isCloud
                      ? `Describe the change to make in ${cloudRepoFull ?? "the repo"}…`
                      : presenceState === "offline"
                        ? "Describe the change — it sends when your Mac reconnects…"
                        : "Describe what to build or fix…"
                  }
                  aria-label="Prompt for this code session"
                  aria-describedby={blockedReason ? blockedId : undefined}
                  className={composerFieldClass}
                />
              }
              leading={
                <>
                  {attachments.enabled && (
                    <ComposerAddMenu
                      open={plusOpen}
                      onOpenChange={setPlusOpen}
                      disabled={isBusy}
                      onPickPhotos={() => imageInputRef.current?.click()}
                      onPickFiles={() => fileInputRef.current?.click()}
                      onPickLibrary={() => setLibraryOpen(true)}
                    />
                  )}

                  {onToggleConnector && (
                    <CodeConnectorsMenu
                      enabledConnectors={connectorsEnabled}
                      onToggleConnector={onToggleConnector}
                      disabled={isBusy}
                    />
                  )}

                  {/* Where this runs: a fact, in the muted ink, on the same row. */}
                  <span
                    title={isCloud ? (cloudRepoFull ?? undefined) : (workspacePath ?? undefined)}
                    className="hidden min-w-0 items-center gap-1.5 px-2 text-ui text-muted-foreground sm:flex"
                  >
                    {resolving ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                    ) : isCloud ? (
                      <CodeIcons.cloud className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <AppIcons.projects className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {!resolving && <span className="sr-only">Runs in </span>}
                    <span className="min-w-0 max-w-[14rem] truncate">{runLabel}</span>
                    {!resolving && isCloud && baseRef && (
                      <>
                        <span aria-hidden="true" className="text-border">·</span>
                        <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Base branch </span>
                        <span className="min-w-0 max-w-[8rem] truncate">{baseRef}</span>
                      </>
                    )}
                  </span>
                </>
              }
              trailing={
                <>
                  {onModelChange && (
                    <div className="min-w-0 shrink-0">
                      <ModelSelector
                        value={model}
                        onChange={onModelChange}
                        reasoningEffort={reasoningEffort}
                        onReasoningChange={onReasoningChange}
                      />
                    </div>
                  )}

                  {isAuto && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-disabled
                          className={cn(composerChipClass, "cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground")}
                        >
                          <span>Auto</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
                    </Tooltip>
                  )}

                  {!isAuto && effortOptions.length > 0 && onReasoningChange && (() => {
                    const clamped = modelInfo ? clampReasoningEffort(modelInfo, reasoningEffort) : reasoningEffort;
                    const current = effortOptions.find((e) => e.value === clamped) ?? effortOptions[0];
                    const label = current.label === "Extra high" ? "X-high" : current.label;
                    const atTop = effortOptions.length > 1 && current.value === effortOptions[effortOptions.length - 1].value;

                    return (
                      <Tooltip>
                        <Popover>
                          <PopoverTrigger asChild>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={isBusy}
                                aria-label={`Thinking effort: ${current.label}`}
                                className={cn(composerChipClass, atTop && "text-primary hover:text-primary")}
                              >
                                <span className="min-w-0 truncate">{label}</span>
                                <ChevronDown className={composerChevronClass} />
                              </Button>
                            </TooltipTrigger>
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            sideOffset={10}
                            className="w-[300px] origin-popper p-4"
                          >
                            <ReasoningSlider
                              options={effortOptions}
                              value={reasoningEffort}
                              onChange={onReasoningChange}
                              disabled={isBusy}
                              fastMode={fastMode}
                              onFastModeChange={setFastMode}
                              proMode={proMode}
                              onProModeChange={setProMode}
                            />
                          </PopoverContent>
                        </Popover>
                        <TooltipContent>Thinking effort & depth</TooltipContent>
                      </Tooltip>
                    );
                  })()}

                  {dictation.supported && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={dictation.onStart}
                          disabled={isBusy || dictation.active || voice.open}
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
                  <ComposerDivider />
                </>
              }
              action={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ComposerPrimaryAction
                      face={face}
                      onClick={
                        isBusy
                          ? onCancel
                          : showVoiceButton && voice.onOpen
                            ? voice.onOpen
                            : onSubmit
                      }
                      disabled={
                        isBusy
                          ? status === "stopping" || status === "submitting"
                          : showVoiceButton
                            ? false
                            : !canSend
                      }
                      aria-label={
                        isBusy
                          ? status === "stopping"
                            ? "Stopping task"
                            : "Stop this task"
                          : showVoiceButton
                            ? "Talk this session through with Juno"
                            : isCloud
                              ? "Start a cloud run"
                              : "Send to your Mac"
                      }
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {isBusy ? "Stop" : showVoiceButton ? "Voice conversation" : "Send"}
                  </TooltipContent>
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
        </div>
      </div>
    </div>
  );
}
