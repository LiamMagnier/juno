"use client";

import * as React from "react";
import { ArrowUp, ChevronDown, Loader2, Mic, Cpu, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import {
  CodeConnectorsMenu,
  CodeActiveConnectorsBar,
} from "@/components/code/code-connectors-menu";
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

const COMPOSER_DIVIDER = "mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block";

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

  return (
    <div className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4">
      {above}
      {blockedReason && (
        <p id={blockedId} className="sr-only">
          {blockedReason}
        </p>
      )}

      <div className="composer-aura-host relative isolate w-full">
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
              utilityLabel="Where this session runs"
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
                  className="max-h-[200px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 motion-reduce:transition-none sm:px-[18px] sm:pt-[17px]"
                />
              }
              controls={
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar">
                    {/* Add Menu */}
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

                    {/* Connectors Menu */}
                    {onToggleConnector && (
                      <CodeConnectorsMenu
                        enabledConnectors={connectorsEnabled}
                        onToggleConnector={onToggleConnector}
                        disabled={isBusy}
                      />
                    )}

                    {/* Model Selector */}
                    {onModelChange && (
                      <>
                        <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                        <div className="min-w-0 shrink-0">
                          <ModelSelector
                            value={model}
                            onChange={onModelChange}
                            reasoningEffort={reasoningEffort}
                            onReasoningChange={onReasoningChange}
                          />
                        </div>
                      </>
                    )}

                    {/* Thinking Slider */}
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
                              <Cpu className="size-3 text-muted-foreground" />
                              <span>Auto</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
                        </Tooltip>
                      </>
                    )}

                    {!isAuto && effortOptions.length > 0 && onReasoningChange && (() => {
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
                                    disabled={isBusy}
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
                        </>
                      );
                    })()}
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {dictation.supported && (
                      <>
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
                              className="composer-mic-button rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                            >
                              <Mic className="composer-mic-icon size-4" aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Dictate</TooltipContent>
                        </Tooltip>
                        <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                      </>
                    )}

                    {/* Primary Action Button: Morphs seamlessly between Voice (empty), Send/Stop (busy/has text) */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
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
                          className={cn(
                            "composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-out-strong",
                            isBusy && status !== "submitting"
                              ? "w-11 rounded-composer-control ring-2 ring-primary/30"
                              : "rounded-composer-action",
                          )}
                        >
                          {status === "submitting" ? (
                            <Loader2 key="submitting" className="size-4 animate-spin motion-safe:animate-fade-in" aria-hidden="true" />
                          ) : isBusy ? (
                            <Square key="stop" className="composer-stop-icon size-3.5 fill-current motion-safe:animate-fade-in" aria-hidden="true" />
                          ) : showVoiceButton ? (
                            <span key="voice" className="composer-voice-wave motion-safe:animate-fade-in" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                              <span />
                              <span />
                            </span>
                          ) : (
                            <ArrowUp key="send" className="composer-send-icon size-4 motion-safe:animate-fade-in" aria-hidden="true" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isBusy ? "Stop" : showVoiceButton ? "Voice conversation" : "Send"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </>
              }
              utility={
                <>
                  <span
                    title={isCloud ? cloudRepoFull ?? undefined : workspacePath ?? undefined}
                    className="flex min-w-0 items-center gap-1.5 font-mono text-ui text-muted-foreground"
                  >
                    {resolving ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                    ) : isCloud ? (
                      <CodeIcons.cloud className="size-3 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <AppIcons.projects className="size-3 shrink-0 text-primary" aria-hidden="true" />
                    )}
                    {!resolving && <span className="sr-only">Runs in </span>}
                    <span className="min-w-0 truncate">
                      {resolving
                        ? "Getting this session ready…"
                        : isCloud
                          ? cloudRepoFull ?? workspaceName
                          : workspaceName}
                    </span>
                  </span>

                  {!resolving && isCloud && baseRef && (
                    <>
                      <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                      <span className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground">
                        <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Base branch </span>
                        <span className="min-w-0 truncate">{baseRef}</span>
                      </span>
                    </>
                  )}

                  {connectorsEnabled.length > 0 && onToggleConnector && (
                    <>
                      <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                      <CodeActiveConnectorsBar
                        enabledConnectors={connectorsEnabled}
                        onToggleConnector={onToggleConnector}
                      />
                    </>
                  )}
                </>
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
