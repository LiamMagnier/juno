"use client";

import * as React from "react";
import Image from "next/image";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AudioLines, Loader2, Send, Square } from "@/components/ui/icons";

import { ActionIcons } from "@/lib/app-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requiresViewerCredentials } from "@/lib/image-source";
import { spring, transition } from "@/lib/motion";
import { cn, formatBytes } from "@/lib/utils";
import { FilePreview } from "@/components/chat/file-preview";
import type { PendingUpload } from "@/hooks/use-uploads";

/**
 * The composer: one quiet surface (docs/design/FLAT_UI.md §3).
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  above      attachment thumbnails / quote     │
 *   │  field      the textarea, directly on the     │
 *   │             surface — no well, no second box  │
 *   │  +  ····························  chip  ◎  ●  │  one controls row
 *   └──────────────────────────────────────────────┘
 *
 * The material is `.composer-surface` (globals.css): `bg-card`, a 1px
 * hairline, one low shadow. Focus darkens the edge and lifts the shadow one
 * notch; nothing else changes.
 *
 * The row is deliberately sparse. Three objects at rest — `+`, the model
 * chip, the send circle — and at most two quiet icon buttons (dictate,
 * voice) between them. Everything else a composer can arm (thinking effort,
 * tools, project, connectors) lives one press away inside `+` or the model
 * popover, because a row that shows every option at once reads as a
 * settings panel, and the field above it stops being the point. The `+`
 * and the text share one left inset; the send circle and the text share
 * one right inset. That alignment is most of what makes the box read as
 * drawn rather than assembled.
 *
 * Slots only. No state, no pickers, no upload logic: every composer in the
 * product (chat, Code, Compare, Work) draws this box and owns everything in
 * it. The shared recipes below — the chip, the icon button, the primary
 * action, the attachment tile — are what keep six composers reading as one.
 */
export interface ComposerShellProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The textarea — or whatever replaces it, e.g. a collapsed-draft card. */
  field: React.ReactNode;
  /** Left cluster of the controls row: `+`, and any context chips. */
  leading?: React.ReactNode;
  /** Right cluster, before the primary action: model, mic. */
  trailing?: React.ReactNode;
  /** The primary action — send ⇄ stop. Never dimmed. */
  action: React.ReactNode;
  /** Above the field, inside the surface: attachments, quote chip, clarification. */
  above?: React.ReactNode;
  /**
   * Streaming / locked: the row fades to 60% while the primary action stays
   * at full strength, because Stop is the one thing left to press.
   */
  dimmed?: boolean;
  /**
   * The field tier's element. Anything a host floats off the composer with
   * `bottom-full` — the slash/@ palette — resolves against this, not the shell.
   */
  fieldTierRef?: React.Ref<HTMLDivElement>;
  /** Where the composer stands: the home's composer is taller at rest than the dock's. */
  frame?: "home" | "dock";
  /**
   * The field has focus from the keyboard: the edge becomes one ring in the
   * presence ink (C1). Focus from a pointer only darkens the edge
   * (`.composer-surface:focus-within`).
   */
  keyboardFocus?: boolean;
}

const ComposerShell = React.forwardRef<HTMLDivElement, ComposerShellProps>(function ComposerShell(
  { field, leading, trailing, action, above, dimmed = false, fieldTierRef, frame, keyboardFocus = false, className, ...props },
  ref
) {
  const dim = cn(
    "transition-opacity duration-fast ease-out-soft motion-reduce:transition-none",
    dimmed && "opacity-60"
  );
  return (
    <div
      ref={ref}
      data-frame={frame}
      data-kbd-focus={keyboardFocus ? "" : undefined}
      className={cn("composer-surface relative flex w-full flex-col rounded-composer", className)}
      {...props}
    >
      {/* `@container`, so what is inside the composer can be sized by the
          COMPOSER. PREMIUM_AUDIT.md rule 11: the same box has ~500px inside a
          1440px window with the sidebar out, and 350 on a phone — the window
          number describes neither. The armed marks read this to decide whether
          their labels fit beside the sentence (see `ComposerArmedMark`). */}
      <div ref={fieldTierRef} className="@container relative flex w-full min-w-0 flex-col">
        {above}
        {field}
        {/* The V3 row: 6px over the controls, 10px under and at the sides,
            so the 34px `+` hangs just outside the 20px text column and the
            36px disc closes the right edge. Used a hundred times a day, so
            its glyphs stay still under the pointer (I-7). */}
        <div className="flex flex-nowrap items-center gap-0.5 px-2.5 pb-2.5 pt-1.5">
          <div className={cn("flex min-w-0 shrink-0 items-center gap-0.5", dim)}>
            {leading}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            {/* No `overflow-x-auto` here. It used to scroll with no scrollbar
                and no fade, so on a narrow window the chips simply left the
                screen with nothing saying they existed. The row now shrinks
                instead: `min-w-0` lets the model chip — the one control on it
                carrying a long, truncatable string — give up its width first,
                which is the right thing to lose. */}
            {trailing && <div className={cn("flex min-w-0 items-center gap-1", dim)}>{trailing}</div>}
            {action}
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * THE COMPOSER'S HEIGHT AT REST, for the skeletons that stand in for it.
 *
 * An empty composer is three stacked boxes, and every one of them is declared
 * in this file:
 *
 *   field      `min-h-[2.8125rem]` in COMPOSER_FIELD_METRICS          45
 *              (`coarse:min-h-[3.25rem]`, 52, on a touch screen)
 *   controls   `pt-1.5` + the tallest control on the row + `pb-2.5`   52
 *              (the 36px disc; every control is 44px on a coarse pointer, so 60 there)
 *   edge       `.composer-surface`'s 1px hairline, top and bottom       2
 *                                                                      99  (114 coarse)
 *
 * The home's composer is taller at rest (its field is 70px, composer.tsx)
 * and its skeleton is drawn by the landing frame, not from this constant.
 *
 * The chat skeletons (`app/(app)/chat/loading.tsx` and `[id]/loading.tsx`)
 * take their placeholder from here instead of writing a number of their own.
 * The number they used to write was 68px, a composer from an older layout,
 * so every chat load jumped 30px at the moment the real one arrived.
 * `tests/composer-rest-height.test.ts` adds the metrics back up from this
 * file's source, so changing the field or the row without changing this fails
 * there rather than on screen.
 */
export const COMPOSER_REST_HEIGHT = { pointer: 99, coarse: 114 } as const;

/** The same two heights as classes. Tailwind reads classes from source text, so they are written out. */
export const composerRestHeightClass = "h-[99px] coarse:h-[114px]";

/**
 * The HOME's composer at rest: the same row and edge over the home's taller
 * field (`min-h-[4.375rem]`, 70px, composer.tsx's landing frame; the coarse
 * field is the dock's 52px), so the new-chat skeleton stands exactly where
 * the composer lands.
 */
export const COMPOSER_HOME_REST_HEIGHT = { pointer: 124, coarse: 114 } as const;
export const composerHomeRestHeightClass = "h-[124px] coarse:h-[114px]";

/* ————————————————————————————————————————————————————————————————————————
 * Shared recipes
 * ———————————————————————————————————————————————————————————————————— */

/**
 * The spring every composer grows on, and its attachment tiles pop on.
 *
 * `spring.standard` (lib/motion.ts), not a private stiffness/damping pair: it
 * was `{ stiffness: 380, damping: 32 }`, a hand-typed near-twin of the shared
 * settle, which meant the field growing a line and the model chip's thumb
 * beside it settled on two different clocks. Same feel, one number.
 */
export const COMPOSER_SPRING = spring.standard;

/**
 * EVERY PROPERTY THAT DECIDES WHERE A GLYPH LANDS, in one string.
 *
 * The box, the type and the wrapping, and nothing else. It is split out
 * because two elements lay the draft's first line out IDENTICALLY: the field,
 * and the marks laid over its head (`ComposerFieldLead`), which have to sit on
 * the same inset and line as the text that follows them. V3: 13px over the
 * first line, 20px at the sides (16 on a phone), the 16px / 26px sentence.
 */
const COMPOSER_FIELD_METRICS =
  // eslint-disable-next-line design-system/no-raw-text-size -- 16px exactly: iOS Safari zooms the page into any focused field below it, and body-lg (17px) is a different measure.
  "block w-full min-h-[2.8125rem] coarse:min-h-[3.25rem] px-5 max-[760px]:px-4 pb-1 pt-[0.8125rem] text-base leading-relaxed";

/**
 * The textarea, directly on the surface: transparent, 16px inline padding
 * (the same inset the `+` glyph hangs off), `text-base` because iOS Safari
 * zooms into anything smaller.
 *
 * The placeholder is the full muted ink. At `/80` it measured 3.58:1 on the
 * card, under the 4.5:1 its 16px text needs, and "Ask Juno" is the one
 * instruction on an empty page.
 */
export const composerFieldClass = cn(
  COMPOSER_FIELD_METRICS,
  "resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60",
);

/**
 * A flat text chip on the controls row: model, target, permission. Quiet at
 * rest — muted ink, no fill — and it only takes the accent fill under the
 * pointer or while its popover is open. A chip is a label on a control,
 * not a button; it should read at the weight of the placeholder text beside
 * it, not compete with the send circle.
 *
 * IT SHRINKS. It used to carry `shrink-0`, which quietly cancelled the design
 * the row it sits in describes two hundred lines below ("the row now shrinks
 * instead: `min-w-0` lets the model chip give up its width first"). A chip that
 * refuses to shrink cannot give up anything, so the `min-w-0` on the cluster
 * and the `truncate` on each chip's own label were both dead code, and on a
 * 390px phone the Work composer — which puts three chips on this row — pushed
 * its controls straight out through the right edge of the box they are drawn
 * in, the send button landing on top of a half-written "Ask before risky st".
 *
 * Nothing changes at a width where the row fits: flex only shrinks what
 * overflows, and it takes width from the widest item first, which is the long
 * truncatable label every time. The glyph and the chevron keep their own
 * `shrink-0`, so a squeezed chip loses letters, never its marks.
 *
 * Focus is the global 2px --ring outline at its 2px offset (globals.css
 * `:focus-visible`, ICONS_AND_MOTION.md §2.2 rule 3), plus the accent fill.
 * The inset ring it used to draw instead was for a control flush inside a
 * clipping parent, and the controls row is neither: it sits 10px inside a
 * surface that does not clip, so the outline has room on every side.
 */
export const composerChipClass =
  "group inline-flex h-8 min-w-0 items-center gap-1 rounded-control px-2 font-sans text-ui font-medium text-muted-foreground transition-[background-color,color,opacity] duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none coarse:h-10";

/* ————————————————————————————————————————————————————————————————————————
 * The field tier: armed marks and connector mentions, inside the draft
 * ———————————————————————————————————————————————————————————————————— */

/**
 * WHERE AN ARMED TOOL IS SAID, and why it is not on the controls row.
 *
 * It used to be a filled pill — `bg-primary/10` inside `border-primary/30`,
 * accent ink — sitting beside the `+` on the row UNDER the field. Two things
 * were wrong with that and only one of them was the colour.
 *
 * The colour, first: that row is a `+`, a muted model chip, a muted mic and
 * the send circle, so the pill was the only tinted FILL among them and the
 * fact that this message will also search the web out-shouted the button that
 * sends it. On a warm accent (coral is the default) a tinted capsule beside a
 * neutral row reads as a warning badge, which is the one thing an armed tool
 * is not. These are NEUTRAL now — `bg-accent`, foreground ink, a brand logo
 * where the tool is an app — because an armed tool is a fact about the draft,
 * not an alert about it.
 *
 * The position matters more. A tool armed for the next message is part of what
 * you are about to say, and it was being stated in the chrome BELOW the thing
 * you say it in — so the sentence and its qualifier lived on two different
 * lines, in two different type sizes, and only one of them moved when you
 * typed. The reference (ChatGPT) puts them in the field: "Deep research" sits
 * where your first word would, and an app you mention sits in the sentence,
 * at the point you mentioned it. That is where they are now, at the field's
 * own 16px, which is what makes them read as part of the draft rather than as
 * settings attached to it.
 *
 * TWO CONTROLS IN ONE OBJECT, and both are reachable. The label opens the menu
 * the mark came from (that is where depth, approval mode and the connector
 * list are actually changed); the ✕ disarms it. The ✕ is revealed on hover and
 * on focus — `coarse:opacity-100`, because a touch device never hovers and the
 * menu would otherwise be the only way to turn a tool off.
 */
export function ComposerArmedMark({
  icon,
  label,
  labelClassName,
  detail,
  tooltip,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
  disabled = false,
}: {
  /** The mark. A glyph from the icon set, or a brand logo for a connector. */
  icon: React.ReactNode;
  label: string;
  /**
   * A container query that decides whether the WORDS fit, e.g.
   * `hidden @[30rem]:inline`.
   *
   * With one mark in the field there is always room and this is left unset.
   * With two or more there is not, below about 480px of composer, and the
   * alternative to hiding the words is letting them eat the line you are
   * typing on — a mark you cannot read is worse than a mark you cannot see,
   * because it still costs the width. What survives is the icon, which for a
   * connector is its own brand logo. The words stay in the accessible name and
   * the tooltip.
   */
  labelClassName?: string;
  /** A derived fact about the armed tool — research depth, approval mode. */
  detail?: string;
  /**
   * What `detail` MEANS, in a sentence, on the label's tooltip.
   *
   * The mark can hold one word; "Max" does not explain that depth follows the
   * model and the thinking effort, and "asks first" does not explain which
   * actions it asks about. Both sentences already exist as copy
   * (`RESEARCH_EFFORT_COPY`, `WORK_APPROVAL_MODE_SUMMARY`) and are the only
   * place the product explains a state it lets you arm in one press.
   */
  tooltip?: React.ReactNode;
  /** Opens the surface this was armed from. */
  onOpen: () => void;
  /** Disarms it. */
  onRemove: () => void;
  /** What pressing the label does, for a screen reader. */
  openLabel: string;
  removeLabel: string;
  /** While the row is locked (streaming): the ✕ stops, the label still opens. */
  disabled?: boolean;
}) {
  /*
   * SYMMETRIC AT REST (owner: "the padding on the left and right isn't the
   * same"). The ✕ used to sit after the label at opacity 0, reserving 20px of
   * empty chip on the right. Removal now lives ON the icon: under the pointer
   * or keyboard focus the mark cross-fades to ✕ in the same 20px box, so the
   * chip is icon · label with equal 6px optical padding on both sides.
   */
  const trigger = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className={cn("truncate", labelClassName)}>{label}</span>
      {detail && (
        <>
          <span aria-hidden className={cn("shrink-0 text-muted-foreground", ARMED_DETAIL_CLASS)}>·</span>
          <span aria-hidden className={cn("shrink-0 truncate text-muted-foreground", ARMED_DETAIL_CLASS)}>
            {detail}
          </span>
        </>
      )}
    </button>
  );
  return (
    <span
      className={cn(
        "group/armed inline-flex min-w-0 items-center gap-1 rounded-md bg-accent pl-1 align-baseline font-medium text-foreground",
        "motion-safe:animate-pop-in",
      )}
    >
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={removeLabel}
        className="relative grid size-5 shrink-0 place-items-center rounded-sm text-foreground transition-colors duration-fast ease-out-soft hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span
          aria-hidden
          className="col-start-1 row-start-1 flex size-4 items-center justify-center transition-opacity duration-fast ease-out-soft group-hover/armed:opacity-0 group-focus-within/armed:opacity-0 motion-reduce:transition-none [&_svg]:size-4"
        >
          {icon}
        </span>
        <ActionIcons.dismiss
          aria-hidden
          className="col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft group-hover/armed:opacity-100 group-focus-within/armed:opacity-100 motion-reduce:transition-none"
        />
      </button>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-64 text-center">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
    </span>
  );
}

/** Where a mark's `detail` stops fitting. The composer surface is the `@container`. */
const ARMED_DETAIL_CLASS = "hidden @[30rem]:inline";

/**
 * The armed marks, laid into the START of the draft.
 *
 * They are drawn OVER the textarea rather than inside it — a textarea has no
 * elements in it — and the textarea is given a `text-indent` exactly as wide
 * as this group, so the first word you type lands after the marks instead of
 * under them. That is one measurement, taken here and handed back through
 * `onWidth`; nothing else in either layer knows the number.
 *
 * `pointer-events-none` on the layer and `auto` on the group: a click on a
 * mark works it, a click anywhere else in the field falls through to the
 * textarea and places the caret, which is what a field is for.
 *
 * The group TRANSLATES with the draft's own scroll. Past the composer's
 * eight-line cap the textarea scrolls under a fixed box, and marks pinned to
 * the frame would float over line fourteen; the layer clips, so they leave
 * with the line they belong to.
 */
export function ComposerFieldLead({
  children,
  onWidth,
  spanRef,
}: {
  children: React.ReactNode;
  onWidth: (width: number) => void;
  /**
   * The group itself, so the host can write its scroll transform straight to
   * the node. Through state it would re-render the whole composer on every
   * frame of a scroll, which is the one thing this layer must not cost.
   */
  spanRef: React.RefObject<HTMLSpanElement | null>;
}) {
  React.useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const measure = () => onWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // NOT keyed to `children`. The group's contents are a fresh array on every
    // render of the composer, so a dependency on them would tear down and
    // rebuild the observer on every keystroke — and the observer is the thing
    // that already answers "the contents changed size".
  }, [onWidth, spanRef]);
  return (
    <div className={cn(COMPOSER_FIELD_METRICS, "pointer-events-none absolute inset-0 overflow-hidden")}>
      <span
        ref={spanRef}
        // `pr-1.5` is INSIDE the measured width, so it becomes the gap between
        // the last mark and the first word — the marks are not touching the
        // sentence, and the number is spent once rather than twice.
        className="pointer-events-auto inline-flex max-w-full items-center gap-1 pr-1.5 align-baseline"
      >
        {children}
      </span>
    </div>
  );
}

/** The chevron that closes a chip: quiet, and it turns while the chip is open. */
export const composerChevronClass =
  "size-3 shrink-0 opacity-70 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180 motion-reduce:transition-none";

/**
 * A 32px flat icon button (`+`, mic, voice), 44px under a coarse pointer — the
 * touch minimum, met by the button itself. Written against `<Button
 * variant="ghost" size="icon-sm">`, whose hover raises a card — every
 * raised/pressed class is cancelled here so the button stays flat and only
 * the accent fill arrives.
 *
 * Focus is the global 2px --ring outline (globals.css `:focus-visible`), the
 * same mark every other control draws. It used to be replaced by an inset
 * ring, which exists for a control flush inside a clipping parent; the
 * controls row sits 10px inside a composer surface that does not clip, so the
 * outline's 2px offset has room and the one indicator is the house one.
 */
export const composerIconButtonClass =
  "size-[34px] shrink-0 rounded-full border-transparent bg-transparent text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground hover:shadow-none active:border-transparent active:bg-selected active:shadow-none data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:size-11";

/**
 * @deprecated The rule between the chips and the send pair is gone: the row
 * is now three objects and a hairline between them was furniture. Kept as a
 * no-op so composers that still import it keep compiling until they are
 * retuned; delete the import when you touch one.
 */
export function ComposerDivider(_: { className?: string }) {
  return null;
}

/**
 * The field grows one line at a time, and the growth SNAPS (C2).
 *
 * Typing is the highest-frequency act in the product (F0), so its height
 * changes in the same frame: the 220 ms height spring this hook used to run is
 * gone (INTERACTION_SPEC C2, decision D3). The measurement is a synchronous
 * set-to-auto / read / set, so nothing paints in between; one line at rest, up
 * to `maxLines` before the field scrolls inside itself. It works on the
 * textarea composers and on the chat composer's contenteditable alike.
 */
export function useComposerAutosize(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  {
    maxLines = 8,
    maxHeight,
    minHeight = 0,
  }: { maxLines?: number; maxHeight?: number; minHeight?: number } = {}
) {
  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cap = maxHeight ?? Math.round(line * maxLines + pad);
    const next = Math.max(minHeight, Math.min(el.scrollHeight, cap));
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
    el.style.height = `${next}px`;
  }, [ref, maxLines, maxHeight, minHeight]);

  React.useLayoutEffect(() => {
    measure();
  }, [value, measure]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.getBoundingClientRect().width;
    let active = true;
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) < 1) return;
      width = entry.contentRect.width;
      measure();
    });
    observer.observe(el);
    void document.fonts.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [ref, measure]);

  return measure;
}

/* ————————————————————————————————————————————————————————————————————————
 * Primary action: send ⇄ stop ⇄ busy
 * ———————————————————————————————————————————————————————————————————— */

/**
 * THE SLOT HOLDS THE ONE THING THERE IS TO DO, and on an empty composer that is
 * not sending.
 *
 * `voice` used to live here, was pulled out to a ghost button in the icon row,
 * and is back — but not the way it was. The objection to the old version was
 * real and is worth stating, because the fix has to answer it: voice took over
 * the ACCENT CIRCLE when the field was empty, so the one saturated control on
 * the row meant "call" until you typed and "send" after, and people pressed it
 * by accident. Two verbs wearing one colour.
 *
 * What was left behind was worse in a quieter way. With voice gone, an empty
 * composer's primary slot is a DISABLED circle: a grey disc with an arrow in
 * it, sitting on the most prominent control on the page, saying nothing except
 * that it does not work yet. That is the state the composer is in every time it
 * is opened.
 *
 * So the slot is live again, and the colour does the disambiguating that
 * position alone could not. Send is the accent; voice is the quiet secondary
 * disc — the same fill the dead button already had, now with something behind
 * it. The accent still means exactly one verb, so the misfire the old layout
 * caused cannot come back, and the first keystroke morphs the quiet disc into
 * the accent one, which is the clearest possible statement that the control has
 * changed hands.
 */
export type ComposerPrimaryFace = "send" | "stop" | "voice" | "busy";

const FACE_MOTION = {
  // One disc, three faces (C12, C13, C16; MOTION_AND_THINKING "Send / Stop /
  // Mic: existing semantic glyph change"): the glyphs overlap and swap in
  // place, opacity with scale 0.8 to 1 on fast. Reduced motion keeps the fade
  // (MotionConfig below drops the scale). Nothing delays Stop.
  initial: { opacity: 0, scale: 0.8 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.8 },
  // From the scale, not a literal. This was `0.12` and a raw cubic-bezier
  // array — the exact values of `--dur-fast` and `--ease-out-strong`, copied,
  // which means a change to the scale would have silently skipped this one
  // control.
  transition: transition.fast,
};

/**
 * The 32px circle. Flat — no raised shadow, no halo — and its face cross-morphs
 * (scale .9→1 + fade over `duration-fast`) between voice, send, stop and a
 * spinner.
 *
 * TWO FILLS, ONE SLOT. Accent for the three faces that act on the draft (send,
 * stop, busy); the quiet secondary disc for `voice`, which acts on nothing you
 * have typed. The fill is what keeps the accent meaning one verb — see the note
 * on `ComposerPrimaryFace` for why that matters here specifically.
 *
 * Disabled is that same NEUTRAL disc, not the accent at 40%. A washed-out coral
 * circle sat on every empty composer and read as a broken button; a quiet
 * secondary fill reads as "nothing to send yet", which is what it means. It is
 * also why `voice` needs no separate disabled treatment: it is already wearing
 * it, and a voice button cannot be short of anything to do.
 * `.composer-primary-action` is kept as a class hook for the e2e suite; it
 * carries no styles.
 */
export interface ComposerPrimaryActionProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  face: ComposerPrimaryFace;
}

const ComposerPrimaryAction = React.forwardRef<HTMLButtonElement, ComposerPrimaryActionProps>(
  function ComposerPrimaryAction({ face, className, type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        data-face={face}
        className={cn(
          // `.pressable` owns the press. This button also carried
          // `transition-[background-color,color]` and `active:scale-95`, both
          // emitted after the components layer at the same specificity, so the
          // utility list REPLACED the class's transition shorthand — transform
          // was not in it, and the dip snapped with no timing at all — while
          // the 0.95 beat the class's 0.97. The most-pressed control in the
          // product was the one `.pressable` that did not press like one.
          // The class already transitions colour and background at --dur-fast
          // and transform at --dur-press, which is everything this needed.
          //
          // Focus is the global 2px --ring outline at its 2px offset
          // (globals.css), which follows the round corner. The ring and
          // card-coloured ring offset it used to add painted a halo on top of
          // it (ICONS_AND_MOTION.md §2.2, rule 3).
          "composer-primary-action pressable relative grid size-9 shrink-0 place-items-center rounded-full",
          face === "voice"
            ? // Empty, the disc is the quiet voice entry: a tone step and the
              // second ink, so the field (the thing to do) leads and the disc
              // is never the strongest object of an empty composer.
              "bg-secondary text-foreground/75 hover:bg-selected hover:text-foreground active:bg-selected"
            : // With words, send: the ink disc, the one strong spot on the
              // composer (V3: graphite is the active control, ultramarine only
              // a small live presence). Stop and busy wear the same disc.
              "bg-foreground text-background hover:bg-foreground/90 dark:hover:bg-white active:bg-foreground/80",
          "disabled:pointer-events-none disabled:bg-secondary disabled:text-muted-foreground/70",
          // 44px under a coarse pointer, the touch minimum; 36px on a mouse.
          "motion-reduce:transition-none motion-reduce:active:scale-100 coarse:size-11",
          className
        )}
        {...props}
      >
        <MotionConfig reducedMotion="user">
          <AnimatePresence initial={false} mode="sync">
            {face === "busy" ? (
              <motion.span key="busy" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                <Loader2 className="size-4 animate-spin" />
              </motion.span>
            ) : face === "stop" ? (
              <motion.span key="stop" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                <Square className="size-4 fill-current" />
              </motion.span>
            ) : face === "voice" ? (
              <motion.span key="voice" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                {/* The waveform, not a microphone. A mic is the glyph for
                    dictation — which this composer already has, one button to
                    the left — and the two doing different things behind the
                    same picture is the confusion this row can least afford. */}
                <AudioLines className="size-5" />
              </motion.span>
            ) : (
              <motion.span key="send" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                {/* The bold cut: the one glyph on the row set on a solid
                    accent disc, where the regular line thins against the fill
                    — the same weight Claude and ChatGPT give their send arrow. */}
                <Send weight="bold" className="size-5" />
              </motion.span>
            )}
          </AnimatePresence>
        </MotionConfig>
      </button>
    );
  }
);

/* ————————————————————————————————————————————————————————————————————————
 * Attachments: what you attached, said in words
 * ———————————————————————————————————————————————————————————————————— */

const TILE_MOTION = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
  transition: COMPOSER_SPRING,
};

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).slice(0, 4).toUpperCase() : "FILE";
}

/**
 * ONE 64px TILE FOR AN IMAGE, A NAMED CARD FOR EVERYTHING ELSE.
 *
 * Every attachment used to be the same 56px square, and for anything that was
 * not an image that square held a grey document glyph with "PDF" under it —
 * no name, no excerpt, nothing. Attach three PDFs and the composer showed
 * three identical grey squares; the only way to tell which was which was to
 * hover one and read a `title` attribute, and on a touch device there was no
 * way at all.
 *
 * That is the exact finding `FilePreview` was written for, one surface over:
 * "a grid of eight documents was eight identical icons … images got
 * recognition, files got a label." The Library got the fix; the composer —
 * where you are looking at the file for the last time before you send it —
 * never did, and it is the place the question "which one is that" is most
 * expensive to get wrong.
 *
 * An image is still a square, because an image IS its own label. A file gets
 * the two things a square cannot carry: its NAME, read rather than hovered,
 * and a 64px page beside it showing the first lines of what is actually in it
 * (`FilePreview`, whose excerpt comes bounded from the server and is cached
 * per attachment). A file with no readable text — a PDF, an image-only scan —
 * falls back to its extension on the same paper, which is what a PDF shows in
 * every other viewer too.
 */
export function ComposerAttachmentTile({
  upload,
  onRemove,
  className,
}: {
  upload: PendingUpload;
  /**
   * Whether Juno can actually READ this file, once indexing has settled.
   *
   * Only ever set for the files where the answer changes what the model
   * receives — in practice, PDFs, whose text reaches a model only through the
   * index (see `useAttachmentReadiness`). A `.txt` is sent whatever the index
   * does, so it is left alone rather than given a status it does not have.
   */

  onRemove?: () => void;
  className?: string;
}) {
  const attachment = upload.attachment;
  const isImage = attachment?.kind === "IMAGE";
  const status =
    upload.status === "uploading" ? `Uploading ${upload.progress}%` : upload.status === "error" ? "Failed" : null;
  const extension = fileExtension(upload.fileName);
  const meta = upload.size ? `${extension} · ${formatBytes(upload.size)}` : extension;
  /*
   * THE LINE THAT WAS MISSING, and it is the one sentence that costs a whole
   * request to learn any other way: a PDF whose text could not be extracted
   * reaches the model as a bracketed note and nothing else. It used to be
   * indistinguishable from a readable one until the reply arrived saying so.
   *
   * "Reading…" while the indexer works, so the empty second does not read as
   * a verdict; the warning only once it has actually settled.
   */
  /*
   * NO VERDICT ON THE FILE. The tile says what the file IS, not what a parser
   * made of it.
   *
   * It used to carry a readiness line — "Reading…", then "Couldn't read this
   * file" — driven by an extractor that ran at upload. That line was wrong in
   * both directions and could not be made right from here: it was computed
   * from a search index, while whether the model can read a document depends
   * on the model (Claude and Gemini are handed the PDF itself and read a scan
   * fine). Worse, it passed judgement before the person had asked anything.
   *
   * Nothing reads the file now until a question is sent, so there is no
   * verdict to show and no honest way to show one. Name, type, size.
   */
  const line = status ?? meta;

  /* The paper square. Before the upload lands there is no attachment id, so
     no excerpt can be asked for — it shows the extension, which is what the
     excerpt falls back to anyway, so nothing moves when the id arrives. */
  const page = attachment ? (
    <FilePreview
      item={{
        id: attachment.id,
        kind: "FILE",
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        url: attachment.url,
      }}
      className="size-16 shrink-0"
      sizes="64px"
    />
  ) : (
    <span className="grid size-16 shrink-0 place-items-center bg-card font-mono text-caption font-medium text-muted-foreground">
      {extension}
    </span>
  );

  return (
    <div
      title={status ? `${upload.fileName} (${status})` : upload.fileName}
      className={cn(
        // `rounded-control`: the same rung as every chip on the row below, so
        // the tiles and the controls read as one family of objects.
        "group relative flex h-16 shrink-0 overflow-hidden rounded-control border border-border/70 bg-secondary",
        isImage ? "w-16" : "w-56 max-w-full",
        upload.status === "error" && "border-destructive/60",
        className,
      )}
    >
      {isImage && attachment ? (
        <Image
          src={attachment.url}
          unoptimized={requiresViewerCredentials(attachment.url)}
          alt={upload.fileName}
          fill
          sizes="64px"
          className="object-cover"
        />
      ) : (
        <>
          {page}
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 border-l border-border/60 px-2.5">
            {/* Two lines, and the second one wraps rather than truncating —
                a filename is identified by its END as often as its start
                ("…-final-v3.pdf"), so `line-clamp-2` keeps the tail visible
                where `truncate` would always eat it. */}
            <span className="line-clamp-2 text-caption font-medium leading-tight text-foreground">
              {upload.fileName}
            </span>
            <span
              className={cn(
                "truncate font-mono text-micro uppercase text-muted-foreground",
              )}
            >
              {line}
            </span>
          </span>
        </>
      )}
      {upload.status === "uploading" && (
        <span className="absolute inset-0 grid place-items-center bg-card/70">
          <Loader2 className="size-4 animate-spin text-foreground" aria-hidden="true" />
        </span>
      )}
      {/* Said out loud too: a reader who cannot see the tile still needs the
          file's name and, while it is going up, its progress. There is no
          verdict to announce any more — nothing has read the file yet. */}
      <span className="sr-only">{status ? `${upload.fileName}, ${status}` : upload.fileName}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${upload.fileName}`}
          className="absolute right-0.5 top-0.5 grid size-6 coarse:size-8 place-items-center rounded-full bg-foreground/80 text-background opacity-0 transition-[opacity,background-color] duration-fast ease-out-soft hover:bg-foreground focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none coarse:opacity-100"
        >
          <ActionIcons.dismiss className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The attachment row. Tiles pop in on the spring and pop out on removal;
 * the row itself takes no space while it is empty.
 */
export function ComposerAttachmentRow({
  uploads,
  onRemove,
  className,
}: {
  uploads: readonly PendingUpload[];
  /** Attachment id → whether its text reached the index (`useAttachmentReadiness`). */

  onRemove: (localId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2 px-4 pt-3.5 empty:hidden", className)}>
      <MotionConfig reducedMotion="user">
        <AnimatePresence initial={false}>
          {uploads.map((upload) => (
            <motion.div key={upload.localId} layout {...TILE_MOTION} className="min-w-0">
              <ComposerAttachmentTile
                upload={upload}
                onRemove={() => onRemove(upload.localId)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </MotionConfig>
    </div>
  );
}

export { ComposerShell, ComposerPrimaryAction };
