"use client";

import * as React from "react";
import { ArrowUp, Check, FileText, Loader2, Mic, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { LibraryPicker } from "@/components/chat/library-picker";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { WorkThreadAddPanel } from "@/components/work/composer/work-thread-add-panel";
import {
  WorkThreadControlsNote,
  WorkThreadModelControl,
  WorkThreadRunContext,
} from "@/components/work/composer/work-thread-controls";
import { useWorkThreadContext } from "@/components/work/composer/use-work-thread-context";
import { useWorkThreadFiles } from "@/components/work/composer/work-thread-files";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { cn, formatBytes } from "@/lib/utils";

/**
 * The box at the bottom of a Work thread. It is always there.
 *
 * This replaces a composer that removed itself — a `{ kind: "closed", reason }`
 * that swapped the box for a dashed panel saying "This task has finished. Start
 * it again above, or begin a new one, to say more." Three ordinary states hit
 * that branch: a finished task, a draft, and a task the server had refused to
 * dispatch. In all three the reader had something to say and the product's
 * answer was to take the field away and point at a button somewhere else.
 *
 * So the box never goes. What varies is what SENDING does, and every mode says
 * so above the field before the send rather than in a toast after it:
 *
 *   answer   the run asked something; this goes to `POST /answer` with its id
 *   steer    the run is going; this is recorded on the task and read next turn
 *   restart  the run is over; this starts a NEW attempt carrying the message
 *   start    never dispatched; this starts it, carrying the message
 *
 * The last two are the capability that was missing. Neither is faked: see the
 * note on `startCarrying` in the thread page for the two requests they are made
 * of and why they are made in that order.
 *
 * ── Nothing typed is ever thrown away ──────────────────────────────────────
 *
 * `onSend` resolves false when the words did not land, and the draft is only
 * cleared on true — the same contract the chat composer keeps with its
 * `accepted: false`. Clearing on submit and hoping is how a refused send costs
 * somebody a paragraph they will not retype.
 *
 * ── Two tiers, because the row was answering two questions ─────────────────
 *
 * `ComposerShell` is the chrome, and adopting it is what split the one row this
 * composer used to have. It held the model, the permission mode, the project,
 * the [+], the mic and Send in a single flex-wrap line, so "which project this
 * task belongs to" and "send this message" sat at identical weight and the row
 * rewrapped under the reader's hand every time the run context changed. Above
 * the hairline is now what you do to THIS message — attach, pick the model,
 * dictate, send. Below it is what stays true afterwards: how often the task
 * stops to ask, and where it is filed.
 *
 * ── The controls around it ─────────────────────────────────────────────────
 *
 * Everything the home composer offers before a task exists is offered here
 * while it runs: which model, how deeply it thinks, how often it stops to ask,
 * where it is filed, and — behind the [+] — its files, its apps and its skill.
 * They were absent for as long as there was no route that could change them,
 * which meant a task started on the wrong model or on Skip could only be
 * corrected by starting a different task.
 *
 * Attachments are the last of those to come out of hiding. The files existed —
 * `WorkThreadAddPanel` has had a picker and a library for a while — but they
 * lived entirely inside a popover, which meant two things: the reader could not
 * see what they had picked without reopening the menu, and Radix unmounting that
 * menu destroyed the upload. Both are fixed the same way, by `useWorkThreadFiles`
 * living out here: the chips are above the field, exactly as on the home
 * composer, and the one press that hands them to the task is beside them.
 *
 * They all write through `PATCH /sessions/[id]/context`, and every one of them
 * obeys the same rule, stated in one place in `useWorkThreadContext`: a run's
 * inputs were fixed when it was dispatched, so a change made mid-task takes
 * effect on the NEXT attempt unless the server says otherwise. The line under
 * the controls says so before the change and reports the server's own answer
 * after it. Nothing here animates into a state the run has not got.
 *
 * ── It must not take focus while a run streams ─────────────────────────────
 *
 * There is no `autoFocus` here and nothing focuses the textarea except the
 * reader and the dictation hand-off. The field is also never `disabled`: the
 * page re-renders roughly once a second while a run is live, and a `disabled`
 * that flipped on any of those frames would blur whatever the reader was in the
 * middle of. Sending is gated on the button and on the Enter handler instead,
 * which is where the guard belongs.
 *
 * ── One primary button, three jobs ─────────────────────────────────────────
 *
 * The button on the right is the same control chat's composer runs: with
 * nothing to send and a voice relay available it IS the voice launcher, and the
 * moment there is anything to send it morphs into Send in place. See
 * `showVoiceButton` in `chat/composer.tsx`. It used to be a second, separate
 * button beside Send, which is two entry points a centimetre apart for a
 * conversation and a message — and it drifted from chat within one release.
 */

/** What the box is for right now. There is no "closed" — that was the bug. */
export type WorkComposerMode =
  /** The run asked something and is stopped until it is answered. */
  | { kind: "answer"; question: string }
  /** The run is under way; this is an instruction it will read next turn. */
  | { kind: "steer" }
  /** The run is over; sending starts another attempt at the same goal. */
  | { kind: "restart" }
  /** Never dispatched; sending starts it. */
  | { kind: "start" };

/** The mono line above the field: what pressing send will actually do. */
function intent(mode: WorkComposerMode): string {
  switch (mode.kind) {
    case "answer":
      return `Answering: ${mode.question}`;
    case "steer":
      // Said before the send rather than after it, because the difference
      // matters: this goes on the task's record, and the attempt already running
      // was handed its instructions when it started. What became of it is the
      // route's sentence to write, not this one's — a cloud run and a Mac whose
      // relay refused the instruction are different outcomes, and only the
      // response knows which happened.
      return "Not an answer to anything — this is kept on the task";
    // "This attempt is over" rather than "this task has finished": the same
    // branch serves a failure, a cancellation and a Mac that went offline, and
    // three of the four would be told they had succeeded.
    case "restart":
      return "This attempt is over — sending starts another and hands it this message";
    case "start":
      return "Not started yet — sending starts this task and hands it this message";
  }
}

function placeholder(mode: WorkComposerMode): string {
  return mode.kind === "answer" ? "Answer in your own words" : "Write a message…";
}

/** The send button's accessible name, which is the only place its effect is named twice. */
function sendLabel(mode: WorkComposerMode): string {
  switch (mode.kind) {
    case "answer":
      return "Send answer";
    case "steer":
      return "Add this to the task";
    case "restart":
      return "Start this task again with this message";
    case "start":
      return "Start this task with this message";
  }
}

export function WorkThreadComposer({
  session,
  mode,
  sending,
  onSend,
  onOpenVoiceMode,
  voiceActive = false,
}: {
  /** The task these controls change. Its own fields are the starting values. */
  session: ClientWorkSession;
  mode: WorkComposerMode;
  /** A send is in flight. Locks the button, never the field. */
  sending: boolean;
  /** Resolves true when the words landed. False keeps them in the box. */
  onSend: (text: string) => Promise<boolean>;
  /**
   * Opens a spoken conversation about this task.
   *
   * Its ABSENCE is meaningful and is the whole gate: undefined means this
   * deployment has no voice relay, or a session is already live, and in both
   * cases the primary button stays a plain Send. Chat reads its own
   * `onOpenVoiceMode` the same way. Passing a no-op instead would put wave bars
   * on a build that cannot open a microphone.
   */
  onOpenVoiceMode?: () => void;
  /** A voice session is live. Dictation and voice are the same microphone. */
  voiceActive?: boolean;
}) {
  const [draft, setDraft] = React.useState("");
  const [dictating, setDictating] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // Every other composer in the product hides the mic where the browser has no
  // SpeechRecognition — work-composer.tsx, chat/composer.tsx, code-session-view
  // all gate on this. This one did not, so a Firefox reader got the one mic in
  // Juno that opens a dictation panel which can never hear anything.
  const { supported: speechSupported } = useSpeechRecognition();

  /*
   * A run is under way in exactly the two modes that describe one: `steer` is a
   * run going, and `answer` is a run stopped mid-turn waiting to be told
   * something. `restart` and `start` have no attempt in flight for a change to
   * miss, which is the difference the note under the controls turns on.
   */
  const live = mode.kind === "steer" || mode.kind === "answer";
  const context = useWorkThreadContext({ session, live });
  /*
   * The documents, owned out here rather than inside the [+].
   *
   * Radix unmounts a popover's content on close, and the hand-over is
   * deliberately a second press — so a reader who picked a file and then closed
   * the menu lost the upload. See `useWorkThreadFiles`.
   */
  const files = useWorkThreadFiles(context);

  /*
   * The library dialog, mounted here rather than in the [+] panel.
   *
   * A modal dialog opened from inside a Radix popover is dismissed along with
   * the popover the moment it takes focus, so the picker has to be a sibling of
   * the composer — the arrangement the chat and Code composers already use.
   * Picking is its own deliberate confirm inside the dialog, so this is the
   * same one-press / one-request hand-off `useWorkThreadFiles` argues for, and
   * it sends the WHOLE list for the reason stated there: a partial one is only
   * safe if the route is certain to read it as an addition.
   */
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const openLibrary = React.useCallback(() => {
    setAddOpen(false);
    setLibraryOpen(true);
  }, []);

  const autoresize = React.useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [draft, autoresize]);

  const submit = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      const accepted = await onSend(trimmed);
      // Only a landed send empties the box. A refusal leaves the words exactly
      // where the reader left them, so "try again" is one keystroke rather than
      // a retype.
      if (!accepted) return;
      setDraft((current) => {
        // A send takes a second or so and the field stays live throughout, so
        // the box is not necessarily holding what was sent by the time this
        // resolves. Only the sent words are removed; anything typed on top of
        // them is the reader's next message and a blanket clear would eat it.
        const head = current.trimStart();
        if (head === trimmed) return "";
        return head.startsWith(trimmed) ? head.slice(trimmed.length).trimStart() : current;
      });
    },
    [onSend, sending]
  );

  /**
   * Dictate mode hands its transcript back the same two ways chat's does.
   *
   * Stop merges it into the field for editing; Send merges and submits through
   * the identical path as typing, so a dictated message cannot take a shortcut
   * around the mode the composer is in.
   */
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
      if (!sendNow || !merged || sending) {
        setDraft(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      setDraft(merged);
      void submit(merged);
    },
    [autoresize, draft, sending, submit]
  );

  const canSend = draft.trim().length > 0 && !sending;
  // Chat's rule, verbatim in shape: with nothing to send and voice available the
  // primary button becomes the voice-conversation launcher; the moment there is
  // sendable content it morphs back into Send. Keeping the two expressions the
  // same is what stops the two composers behaving differently on the same
  // keystroke.
  const showVoiceButton = !sending && !canSend && !!onOpenVoiceMode;

  return (
    <div
      className={cn(
        "relative grid w-full grid-cols-1 grid-rows-1 items-end justify-items-center",
        // Only min-height animates. Dictation's transcript preview floats above
        // the capsule and needs the headroom; animating the two layers'
        // opacity/transform keeps the swap on the compositor.
        "transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
        dictating ? "min-h-[170px]" : "min-h-0"
      )}
    >
      <div
        // `inert` is what actually takes this half of the cross-fade out of the
        // page. `opacity-0 pointer-events-none` hides it from the eye and the
        // mouse and leaves it in the tab order and the accessibility tree, so a
        // keyboard or screen-reader user could reach a composer that is not on
        // screen — and, mid-dictation, type into it. Same defect the chat
        // transcript's jump-to-latest button had.
        inert={!dictating}
        className={cn(
          "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
          dictating
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-1 scale-95 opacity-0"
        )}
      >
        {dictating && (
          <ComposerDictation
            onCancel={() => setDictating(false)}
            onStop={(text) => closeDictation(text, false)}
            onSend={(text) => closeDictation(text, true)}
          />
        )}
      </div>

      {/* The cross-fade lives on a wrapper, not on the shell: `ComposerShell`
          already declares `transition-[border-color,box-shadow]`, and two
          arbitrary `transition-[…]` utilities on one element are resolved by
          stylesheet order rather than class order — one would silently win. */}
      <div
        // `inert` is what actually takes this half of the cross-fade out of the
        // page. `opacity-0 pointer-events-none` hides it from the eye and the
        // mouse and leaves it in the tab order and the accessibility tree, so a
        // keyboard or screen-reader user could reach a composer that is not on
        // screen — and, mid-dictation, type into it. Same defect the chat
        // transcript's jump-to-latest button had.
        inert={dictating}
        className={cn(
          "col-start-1 row-start-1 w-full transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
          dictating && "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
        )}
      >
        <ComposerShell
          utilityLabel="How often this task asks, and where it is filed"
          above={
            <>
              {/* What sending does, in the same mono register as every other
                  metadata label in Work. Only the echoed question is truncated —
                  the four fixed sentences are the whole point of the strip and a
                  clipped one would be worse than none. */}
              <p
                className={cn(
                  "px-3 pt-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground sm:px-3.5",
                  mode.kind === "answer" && "truncate"
                )}
              >
                {intent(mode)}
              </p>

              {/*
               * The documents this task has been given, or is about to be.
               *
               * Visible on the surface at last. They were listed only inside the
               * [+], which meant the reader could not see what they had picked
               * without reopening a menu — and the hand-over is a second press,
               * so reopening was the normal path rather than a rare one.
               *
               * `grid-rows-[0fr]`→`[1fr]` rather than height, so the strip can
               * animate open without anything being measured. Same collapse, same
               * chips, same remove affordance as the home composer.
               */}
              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-base ease-out-soft",
                  files.uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 px-3 pt-2 sm:px-3.5">
                    {files.uploads.map((upload) => {
                      const added =
                        upload.attachment !== undefined &&
                        context.attachmentIds.includes(upload.attachment.id);
                      return (
                        <div
                          key={upload.localId}
                          // `bg-secondary`, not `bg-background` + `shadow-soft` —
                          // the same correction as the home composer's chips. On a
                          // pure-black ground the chip was darker than the shell it
                          // sits in and its shadow was black ink on black.
                          className="flex items-center gap-2 rounded-control border border-border/60 bg-secondary px-2.5 py-2 text-xs motion-safe:animate-rise-in"
                        >
                          <FileText
                            className="h-5 w-5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <div className="max-w-[140px]">
                            <p className="truncate font-medium">{upload.fileName}</p>
                            <p className="text-muted-foreground">
                              {upload.status === "uploading"
                                ? `${upload.progress}%`
                                : upload.status === "error"
                                  ? "Failed"
                                  : added
                                    ? "On this task from the next attempt"
                                    : formatBytes(upload.size)}
                            </p>
                          </div>
                          {upload.status === "uploading" && (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                          {added ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          ) : (
                            <Pressable
                              kind="icon"
                              size="sm"
                              onClick={() => files.remove(upload.localId)}
                              className="-mr-1 shrink-0"
                              aria-label={`Remove ${upload.fileName}`}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </Pressable>
                          )}
                        </div>
                      );
                    })}

                    {/* The hand-over, beside the files it is about rather than
                        back inside the menu they were picked from. A run is
                        handed its files at dispatch, so this is a press about the
                        next attempt and the button says which files it means. */}
                    {files.pending.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={files.hand}
                        disabled={context.saving || files.isUploading}
                        className="gap-1.5"
                      >
                        {context.saving && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        )}
                        {files.pending.length === 1
                          ? "Give it this file"
                          : `Give it these ${files.pending.length} files`}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          }
          field={
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // Escape gets out of the box rather than out of the page: the
                  // transcript is what a reader wants their keyboard back for.
                  event.preventDefault();
                  event.currentTarget.blur();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit(draft);
                }
              }}
              rows={1}
              placeholder={placeholder(mode)}
              // Stable in every mode but the one where it carries real
              // information. The page re-renders about once a second while a run
              // is live, and a field whose accessible name changed as the run
              // moved between states would be re-announced under the reader
              // mid-sentence. The send button is where the effect is named, and
              // it is not the thing holding focus.
              aria-label={mode.kind === "answer" ? `Answer: ${mode.question}` : "Message"}
              // `text-body`. Writing the thing Juno will act on was set at 14px
              // here and 16px in the home composer — the same act, two pixels
              // apart, neither on the scale.
              className="max-h-[180px] min-h-[38px] w-full resize-none bg-transparent px-3 py-2.5 text-body outline-none placeholder:text-muted-foreground/70 sm:px-3.5"
            />
          }
          controls={
            <>
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Popover open={addOpen} onOpenChange={setAddOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Add a file, an app or a skill to this task"
                      className={cn(
                        // `coarse:h-11 coarse:w-11` to match the home composer's
                        // [+]. Without it this button tops out at 32px on touch,
                        // under the 44px the coarse variant exists to guarantee.
                        "composer-add-button group shrink-0 rounded-composer-control text-muted-foreground hover:text-foreground coarse:h-11 coarse:w-11",
                        addOpen && "bg-accent"
                      )}
                    >
                      <Plus
                        aria-hidden="true"
                        strokeWidth={1.75}
                        className="composer-add-icon h-4 w-4 transition-transform duration-base ease-out-strong group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                      />
                    </Button>
                  </PopoverTrigger>
                  {/* The panel's requests are made when it mounts, which Radix
                      does on open — so a reader who never opens the [+] never
                      makes any of them. */}
                  <PopoverContent align="start" side="top" sideOffset={10} className="w-80 p-0">
                    <WorkThreadAddPanel
                      context={context}
                      files={files}
                      onOpenLibrary={openLibrary}
                    />
                  </PopoverContent>
                </Popover>

                {/* One divider class, one height, one breakpoint — the form chat
                    settled on after shipping two of each. */}
                <span
                  className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
                  aria-hidden="true"
                />

                <WorkThreadModelControl context={context} />
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1">
                {speechSupported && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDictating(true)}
                        // Dictation and the voice conversation want the same
                        // microphone, and the browser gives it to whoever asked
                        // last — so opening one while the other is live steals
                        // the input stream from a session still holding it. Chat
                        // locks the same pair the same way.
                        disabled={dictating || voiceActive}
                        aria-label="Dictate this message"
                        aria-pressed={dictating}
                        className="composer-mic-button shrink-0 rounded-composer-control text-muted-foreground hover:text-foreground coarse:h-11 coarse:w-11"
                      >
                        <Mic className="composer-mic-icon h-4 w-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Dictate</TooltipContent>
                  </Tooltip>
                )}

                {/* Primary action morphs in place: Voice (empty) → Send (has text). */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      onClick={showVoiceButton ? onOpenVoiceMode : () => void submit(draft)}
                      disabled={showVoiceButton ? false : !canSend}
                      aria-label={showVoiceButton ? "Talk to Juno about this task" : sendLabel(mode)}
                      className={cn(
                        // The same property list and easing chat transitions on,
                        // so the two buttons morph identically. `width` and
                        // `border-radius` are in it even though this composer
                        // holds both fixed: dropping them here is how the lists
                        // drift and a later shape change animates on one surface
                        // only.
                        // 36px on `rounded-composer-action`, 44px on touch — the
                        // same as the home composer's send. `composer-action` is the
                        // radius the token file reserves for the primary at its 36px
                        // rest size, and the button reached only 32px before, which
                        // is under the touch floor its neighbours already clear.
                        "composer-primary-action h-9 w-9 shrink-0 rounded-composer-action coarse:h-11 coarse:w-11",
                        "transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-out-strong"
                      )}
                    >
                      {sending ? (
                        // Work's busy state is a send in flight, not a stream
                        // being generated — the composer has no stop path, that
                        // control is in the page header. So this maps to chat's
                        // `checking` spinner rather than to its Square.
                        <Loader2
                          key="sending"
                          className="h-3.5 w-3.5 animate-spin motion-safe:animate-fade-in"
                          aria-hidden="true"
                        />
                      ) : showVoiceButton ? (
                        <span
                          key="voice"
                          className="composer-voice-wave motion-safe:animate-fade-in"
                          aria-hidden="true"
                        >
                          <span /><span /><span /><span /><span />
                        </span>
                      ) : (
                        <ArrowUp
                          key="send"
                          className="composer-send-icon h-3.5 w-3.5 motion-safe:animate-fade-in"
                          aria-hidden="true"
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{showVoiceButton ? "Voice conversation" : "Send"}</TooltipContent>
                </Tooltip>
              </div>
            </>
          }
          utility={<WorkThreadRunContext context={context} />}
        />

        {/* Under the shell rather than beside any one control: it is true of all
            of them, and a caveat that wrapped in among the chips would be read
            as a label for whichever one it landed next to. The utility tier does
            not wrap, so a sentence cannot live in it. */}
        <WorkThreadControlsNote context={context} live={live} />

        <LibraryPicker
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          onAttach={files.attachFromLibrary}
          existingCount={context.attachmentIds.length}
        />
        {files.input}
      </div>
    </div>
  );
}