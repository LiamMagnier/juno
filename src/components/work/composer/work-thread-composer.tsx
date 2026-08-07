"use client";

import * as React from "react";
import { ArrowUp, Loader2, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { WorkThreadAddPanel } from "@/components/work/composer/work-thread-add-panel";
import {
  WorkThreadControls,
  WorkThreadControlsNote,
} from "@/components/work/composer/work-thread-controls";
import { useWorkThreadContext } from "@/components/work/composer/use-work-thread-context";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { cn } from "@/lib/utils";

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
 * ── The controls around it ─────────────────────────────────────────────────
 *
 * Everything the home composer offers before a task exists is offered here
 * while it runs: which model, how deeply it thinks, how often it stops to ask,
 * where it is filed, and — behind the [+] — its files, its apps and its skill.
 * They were absent for as long as there was no route that could change them,
 * which meant a task started on the wrong model or on Skip could only be
 * corrected by starting a different task.
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

  /*
   * A run is under way in exactly the two modes that describe one: `steer` is a
   * run going, and `answer` is a run stopped mid-turn waiting to be told
   * something. `restart` and `start` have no attempt in flight for a change to
   * miss, which is the difference the note under the controls turns on.
   */
  const live = mode.kind === "steer" || mode.kind === "answer";
  const context = useWorkThreadContext({ session, live });

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
        "transition-[min-height] duration-slow ease-spring motion-reduce:transition-none",
        dictating ? "min-h-[170px]" : "min-h-0"
      )}
    >
      <div
        className={cn(
          "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
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

      <div
        className={cn(
          "composer-surface col-start-1 row-start-1 flex w-full flex-col gap-1 rounded-[20px] border border-border/65 bg-card/95 p-1.5 backdrop-blur",
          "transition-[border-color,opacity,transform] duration-base ease-spring focus-within:border-foreground/15 motion-reduce:transition-none",
          dictating && "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
        )}
      >
        {/* What sending does, in the same mono register as every other metadata
            label in Work. Only the echoed question is truncated — the four fixed
            sentences are the whole point of the strip and a clipped one would be
            worse than none. */}
        <p
          className={cn(
            "px-2.5 pt-1 font-mono text-[10px] leading-relaxed text-muted-foreground",
            mode.kind === "answer" && "truncate"
          )}
        >
          {intent(mode)}
        </p>

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
          // Stable in every mode but the one where it carries real information.
          // The page re-renders about once a second while a run is live, and a
          // field whose accessible name changed as the run moved between states
          // would be re-announced under the reader mid-sentence. The send button
          // is where the effect is named, and it is not the thing holding focus.
          aria-label={mode.kind === "answer" ? `Answer: ${mode.question}` : "Message"}
          className="max-h-[180px] min-h-[38px] w-full resize-none bg-transparent px-2.5 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />

        <div className="flex items-center gap-1.5">
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Add a file, an app or a skill to this task"
                className={cn(
                  "composer-add-button group shrink-0 rounded-[11px] text-muted-foreground hover:text-foreground",
                  addOpen && "bg-accent"
                )}
              >
                <Plus
                  aria-hidden="true"
                  strokeWidth={1.75}
                  className="composer-add-icon h-4 w-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                />
              </Button>
            </PopoverTrigger>
            {/* The panel's three requests are made when it mounts, which Radix
                does on open — so a reader who never opens the [+] never makes
                any of them. */}
            <PopoverContent align="start" side="top" sideOffset={10} className="w-80 p-0">
              <WorkThreadAddPanel context={context} />
            </PopoverContent>
          </Popover>

          <WorkThreadControls context={context} />

          {/* Right: dictation mic + primary action (voice ⇄ send). */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDictating(true)}
                  // Dictation and the voice conversation want the same
                  // microphone, and the browser gives it to whoever asked last —
                  // so opening one while the other is live steals the input
                  // stream from a session still holding it. Chat locks the same
                  // pair the same way.
                  disabled={dictating || voiceActive}
                  aria-label="Dictate this message"
                  aria-pressed={dictating}
                  className="composer-mic-button shrink-0 rounded-[11px] text-muted-foreground hover:text-foreground"
                >
                  <Mic className="composer-mic-icon h-4 w-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Dictate</TooltipContent>
            </Tooltip>

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
                    // The same property list and easing chat transitions on, so
                    // the two buttons morph identically. `width` and
                    // `border-radius` are in it even though this composer holds
                    // both fixed: dropping them here is how the lists drift and
                    // a later shape change animates on one surface only.
                    "composer-primary-action h-8 w-8 shrink-0 rounded-[11px]",
                    "transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring"
                  )}
                >
                  {sending ? (
                    // Work's busy state is a send in flight, not a stream being
                    // generated — the composer has no stop path, that control is
                    // in the page header. So this maps to chat's `checking`
                    // spinner rather than to its Square.
                    <Loader2
                      key="sending"
                      className="h-3.5 w-3.5 animate-spin motion-safe:animate-fade-in"
                      aria-hidden="true"
                    />
                  ) : showVoiceButton ? (
                    <span key="voice" className="composer-voice-wave motion-safe:animate-fade-in" aria-hidden="true">
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
        </div>

        {/* Under the row rather than beside any one control: it is true of all
            of them, and a caveat that wrapped in among the chips would be read
            as a label for whichever one it landed next to. */}
        <WorkThreadControlsNote context={context} live={live} />
      </div>
    </div>
  );
}
