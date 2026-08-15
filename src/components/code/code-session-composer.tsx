"use client";

import * as React from "react";
import { ArrowUp, Loader2, Mic, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { AppIcons, CodeIcons } from "@/lib/app-icons";
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

/*
 * The Code session composer — chrome only.
 *
 * It was 470 lines inside code-session-view.tsx, assigned to a `const composer`
 * and rendered from two branches, which is what made the view impossible to
 * read: the twenty lines that decide whether a session can run at all were
 * separated from the twenty that decide what to do about it by an entire
 * textarea, an attachment tray, two dropdown menus and a file picker.
 *
 * Nothing here decides anything. Every gate arrives as a boolean the view
 * computed and every action as a callback, so the rules about presence, cloud
 * repos and busy runs stay in one place — this file only draws them. The three
 * pieces of state it does own (`dragging`, the "+" menu, the library sheet) are
 * about this widget and nothing else.
 */

/*
 * The composer's separator, one string, both places one is needed. The comment
 * at chat/composer.tsx:2205 records what happens otherwise: two heights
 * (h-5/h-4) behind two breakpoints (min-[420px]/min-[380px]) put two different
 * separators on screen at once between 380 and 420px.
 */
const COMPOSER_DIVIDER = "mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block";

export interface CodeSessionComposerProps {
  /** Cards stacked above the composer — the run stack. Always rendered. */
  above: React.ReactNode;
  /** The live voice call, or null. A SIBLING of the composer, never a wrapper. */
  voicePanel: React.ReactNode;

  // —— run context, drawn in the utility tier ——
  resolving: boolean;
  isCloud: boolean;
  workspaceName: string;
  workspacePath: string | null;
  cloudRepoFull: string | null;
  baseRef: string | null;
  presenceState: PresenceState;

  // —— the draft ——
  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;

  // —— gates ——
  /**
   * Why this session cannot dispatch right now, in a sentence, or null.
   *
   * It does NOT disable the field, and that is the change. Blocking the
   * textarea on an unreachable Mac contradicted the machinery right beside it:
   * a handed-off first prompt already waits in this composer and fires the
   * moment presence resolves, and dictation already parks its words here for
   * the same reason. Writing the instruction while the Mac wakes up is the
   * normal case, so the field stays live, the send button carries the refusal,
   * and the run stack above says why with a way out. Kept here only as the
   * field's accessible description.
   */
  blockedReason: string | null;
  canSend: boolean;
  /** Words typed, or a finished upload staged. Decides send-vs-voice. */
  hasPayload: boolean;
  onSubmit: () => void;

  // —— the live run ——
  status: CodeSessionStatus;
  isBusy: boolean;
  onCancel: () => void;

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
    /** Undefined means "draw no voice affordance" — never a no-op handler. */
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
  hasPayload,
  onSubmit,
  status,
  isBusy,
  onCancel,
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

  // Nothing written → the primary action opens the conversation instead of
  // sitting there disabled. Keyed on the payload, not on `canSend`: with words
  // in the field and an unreachable Mac, `canSend` is false too, and swapping
  // Send for a phone call there would hide the control whose disabled state is
  // the only thing pointing at the problem.
  const showVoiceButton = !isBusy && !hasPayload && !!voice.onOpen;
  const dropEnabled = attachments.enabled && !isBusy && !dictation.active;

  return (
    <div className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4">
      {above}
      {blockedReason && (
        <p id={blockedId} className="sr-only">
          {blockedReason}
        </p>
      )}

      <div className="composer-aura-host relative isolate w-full">
        {/* Sibling of the composer, never a wrapper: the voice field paints at
            `z-index: -1`, and the `isolate` above is the floor it is allowed to
            fall to. No idle bloom on this surface — a transcript sits above the
            composer, so the only light here is a live call. */}
        {voicePanel}

        {/* Composer ⇄ Dictation share one grid cell and cross-fade. */}
        <div
          className={cn(
            "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
            dictation.active ? "min-h-[170px]" : "min-h-[68px]",
          )}
        >
          <div
            // `inert` is what actually takes this half of the cross-fade out of
            // the page. `opacity-0 pointer-events-none` hides it from the eye
            // and the mouse and leaves it in the tab order and the
            // accessibility tree, so a keyboard or screen-reader user could
            // reach a composer that is not on screen — and, mid-dictation, type
            // into it.
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

          {/*
            The cross-fade and the drop target sit on this wrapper, not on the
            shell. <ComposerShell> owns a `transition-[border-color,box-shadow]`
            already, and a second `transition-[opacity,transform,…]` on the same
            element is two `transition-property` declarations at equal
            specificity — which one survives would be decided by Tailwind's emit
            order rather than by anything written here. It also lets the drop
            overlay cover both tiers: `absolute inset-0` inside the shell
            reaches only one slot, and the shell cannot clip.
          */}
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
                  // The blocked sentence is on screen in the run stack above,
                  // and is also this field's description: a keyboard user who
                  // tabs straight into a composer whose send is refusing has to
                  // hear the reason without going looking for it.
                  aria-describedby={blockedReason ? blockedId : undefined}
                  // The height eased here is real layout movement — the whole
                  // composer, and everything stacked on it, rises as you type —
                  // so it needs the same reduced-motion escape every other
                  // transition on this surface carries.
                  //
                  // PLACEHOLDER AT FULL --muted-foreground: input.tsx,
                  // textarea.tsx and select.tsx each removed `/70` with a note
                  // recording it as a 2.91:1 contrast failure against a token
                  // tuned to 5.3:1.
                  className="max-h-[200px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 motion-reduce:transition-none sm:px-[18px] sm:pt-[17px]"
                />
              }
              controls={
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1">
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
                              // A live call already holds the microphone — the
                              // same interlock every other composer keeps
                              // between dictation and voice.
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

                    {/* One button, three jobs: stop the run, send the next
                        instruction, or — with nothing written — open a
                        conversation about what the run did. Same morph as chat
                        and the Work thread, so the gesture is one gesture
                        across the product. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          onClick={
                            isBusy ? onCancel : showVoiceButton && voice.onOpen ? voice.onOpen : onSubmit
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
                            // ring-primary/30, not /15: the halo that says "this
                            // is now a stop button" was ~2% lightness against
                            // the black ground and did not read at all.
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
                  {/* Identity is the workspace NAME (device) or the repo
                      (cloud); the device-local path stays honest secondary
                      metadata, on hover. While `resolving` neither can be
                      claimed, so the strip says only that. */}
                  <span
                    title={isCloud ? cloudRepoFull ?? undefined : workspacePath ?? undefined}
                    className="flex min-w-0 items-center gap-1.5 font-mono"
                  >
                    {resolving ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                    ) : isCloud ? (
                      <CodeIcons.cloud className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <AppIcons.projects className="size-3 shrink-0" aria-hidden="true" />
                    )}
                    {/* The glyph carries "device or cloud" for everyone who can
                        see it; this is the same fact for everyone who cannot.
                        Suppressed while resolving, where the following text is
                        a sentence and "Runs in Getting this session ready" is
                        not one. */}
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
                      <span className="flex min-w-0 items-center gap-1 font-mono">
                        <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Base branch </span>
                        <span className="min-w-0 truncate">{baseRef}</span>
                      </span>
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
