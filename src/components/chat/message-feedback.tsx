"use client";

import * as React from "react";
import { ThumbsDown, ThumbsUp } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { Burst, Swell } from "@/components/ui/micro";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { claimFeedbackBurst } from "@/lib/feedback-celebration";
import {
  FEEDBACK_NOTE_LIMIT,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABEL,
  type FeedbackDetail,
  type FeedbackReason,
  type FeedbackValue,
} from "@/lib/feedback-reasons";
import { cn } from "@/lib/utils";

/**
 * THE TWO THUMBS, and what each one says back.
 *
 * Up swells, and the first one of a session also bursts (feedback-celebration.ts):
 * rating an answer is the one thing on the row the reader does for us, and a
 * tint on a 16px glyph is easy to miss. Down never celebrates. It records DOWN
 * at once — the rating must not depend on the reader filling in a form — and
 * opens a calm picker beside the thumb asking what went wrong, with six
 * reasons and an optional note. On a phone the picker is a bottom sheet.
 *
 * Pressing a filled thumb takes the rating back, as before; taking back a DOWN
 * also drops its reason on the server (feedbackWrite).
 */
export function MessageFeedback({
  messageId,
  feedback,
  onFeedback,
}: {
  messageId: string;
  feedback: FeedbackValue | undefined;
  onFeedback: (id: string, value: FeedbackValue, detail?: FeedbackDetail) => void;
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Armed at the press that turns the thumb on, and only if this press is the
  // session's first: the burst component plays on its own false → true edge.
  const [burstArmed, setBurstArmed] = React.useState(false);
  const downRef = React.useRef<HTMLButtonElement>(null);
  const up = feedback === "UP";
  const down = feedback === "DOWN";

  const pressUp = () => {
    if (up) {
      onFeedback(messageId, null);
      return;
    }
    setBurstArmed(claimFeedbackBurst());
    setPickerOpen(false);
    onFeedback(messageId, "UP");
  };

  const pressDown = () => {
    if (down) {
      setPickerOpen(false);
      onFeedback(messageId, null);
      return;
    }
    onFeedback(messageId, "DOWN");
    setPickerOpen(true);
  };

  const submit = (detail: { reason: FeedbackReason | null; note: string }) => {
    onFeedback(messageId, "DOWN", { reason: detail.reason, note: detail.note.trim() || null });
  };

  return (
    <>
      <Thumb label="Good response" active={up} onClick={pressUp}>
        <span className="relative inline-flex items-center justify-center">
          <Swell on={up}>
            {/* A rated thumb is filled: `weight="fill"` is this set's "on", so
                the state reads in the drawing, not only the tint. */}
            <ThumbsUp className="size-4" weight={up ? "fill" : undefined} />
          </Swell>
          <Burst on={up && burstArmed} />
        </span>
      </Thumb>
      <FeedbackReasonPicker
        open={pickerOpen && down}
        onOpenChange={setPickerOpen}
        onSubmit={submit}
        returnFocus={downRef}
      >
        <Thumb label="Bad response" active={down} onClick={pressDown} buttonRef={downRef} expanded={pickerOpen && down}>
          <ThumbsDown className="size-4" weight={down ? "fill" : undefined} />
        </Thumb>
      </FeedbackReasonPicker>
    </>
  );
}

/** The row's glyph button, drawn exactly like message-item's IconAction. */
function Thumb({
  label,
  active,
  onClick,
  children,
  buttonRef,
  expanded,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          kind="icon"
          size="md"
          selected={active}
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          aria-expanded={expanded === undefined ? undefined : expanded}
          aria-haspopup={expanded === undefined ? undefined : "dialog"}
          className={cn(active && "text-primary")}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The picker's frame: a popover anchored to the thumb, or a bottom sheet on a
 * phone, holding the same form. Focus goes to the first reason on open and
 * back to the thumb on close.
 */
export function FeedbackReasonPicker({
  open,
  onOpenChange,
  onSubmit,
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (detail: { reason: FeedbackReason | null; note: string }) => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const form = <FeedbackReasonForm onSubmit={onSubmit} onDone={close} />;

  if (phone) {
    return (
      <>
        {children}
        <BottomSheet open={open} onOpenChange={onOpenChange} title="What went wrong?">
          <div className="px-4 pb-4 pt-1">{form}</div>
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-80"
        aria-label="What went wrong?"
        onCloseAutoFocus={(e) => {
          // The anchor is not a Radix trigger, so hand focus back by hand.
          e.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
      >
        {form}
      </PopoverContent>
    </Popover>
  );
}

/** How long the thank-you line stays before the picker closes itself. */
export const FEEDBACK_THANKS_MS = 1400;

/**
 * The form itself: a heading, six reasons as a radio group, an optional note,
 * and Skip / Send. Send needs a reason or a note — an empty send would only
 * repeat the DOWN the thumb already recorded. After sending, one quiet line
 * of thanks replaces the form, then the picker closes.
 */
export function FeedbackReasonForm({
  onSubmit,
  onDone,
  initialReason = null,
}: {
  onSubmit: (detail: { reason: FeedbackReason | null; note: string }) => void;
  onDone: () => void;
  initialReason?: FeedbackReason | null;
}) {
  const [reason, setReason] = React.useState<FeedbackReason | null>(initialReason);
  const [note, setNote] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const chipRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const headingId = React.useId();
  const noteId = React.useId();
  const canSend = !!reason || !!note.trim();

  React.useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(onDone, FEEDBACK_THANKS_MS);
    return () => window.clearTimeout(timer);
  }, [sent, onDone]);

  // Roving tabindex: one stop for the group, arrows move within it, and the
  // arrow selects as it moves — the radio group's own contract.
  const focusIndex = Math.max(0, reason ? FEEDBACK_REASONS.indexOf(reason) : 0);
  const onChipKey = (e: React.KeyboardEvent, index: number) => {
    const next = nextRadioIndex(e.key, index, FEEDBACK_REASONS.length);
    if (next === null) return;
    e.preventDefault();
    setReason(FEEDBACK_REASONS[next]);
    chipRefs.current[next]?.focus();
  };

  if (sent) {
    return (
      <p role="status" className="flex items-center gap-2 py-1 text-ui text-foreground motion-safe:animate-rise-in">
        <StatusIcons.success className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        Thanks for telling us.
      </p>
    );
  }

  return (
    <form
      aria-labelledby={headingId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSend) return;
        onSubmit({ reason, note });
        setSent(true);
      }}
    >
      <h3 id={headingId} className="text-ui font-medium text-foreground">
        What went wrong?
      </h3>
      <div role="radiogroup" aria-labelledby={headingId} className="mt-3 flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((id, index) => (
          <Pressable
            key={id}
            ref={(el) => {
              chipRefs.current[index] = el;
            }}
            kind="chip"
            size="lg"
            role="radio"
            aria-checked={reason === id}
            selected={reason === id}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => setReason(id)}
            onKeyDown={(e) => onChipKey(e, index)}
            className="coarse:h-10"
          >
            {FEEDBACK_REASON_LABEL[id]}
          </Pressable>
        ))}
      </div>
      <label htmlFor={noteId} className="mt-3 block font-sans text-label font-normal text-muted-foreground">
        Anything else? (optional)
      </label>
      <Textarea
        id={noteId}
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, FEEDBACK_NOTE_LIMIT))}
        maxLength={FEEDBACK_NOTE_LIMIT}
        rows={3}
        placeholder="What would a better answer have done?"
        className="mt-1.5 resize-none"
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends from the note, the composer's own chord.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Skip
        </Button>
        <Button type="submit" size="sm" disabled={!canSend}>
          Send
        </Button>
      </div>
    </form>
  );
}

/** Arrow-key movement in a wrapping radio group, or null for any other key. */
export function nextRadioIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
