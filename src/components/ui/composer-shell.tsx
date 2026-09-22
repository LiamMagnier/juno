"use client";

import * as React from "react";
import Image from "next/image";
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useReducedMotion,
  type AnimationPlaybackControls,
} from "framer-motion";
import { ArrowUp, AudioLines, Loader2, Square } from "lucide-react";

import { ActionIcons } from "@/lib/app-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requiresViewerCredentials } from "@/lib/image-source";
import { transition } from "@/lib/motion";
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
}

const ComposerShell = React.forwardRef<HTMLDivElement, ComposerShellProps>(function ComposerShell(
  { field, leading, trailing, action, above, dimmed = false, fieldTierRef, className, ...props },
  ref
) {
  const dim = cn(
    "transition-opacity duration-fast ease-out-soft motion-reduce:transition-none",
    dimmed && "opacity-60"
  );
  return (
    <div
      ref={ref}
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
        {/* px-2.5 puts the 32px `+` glyph's left edge 10px in and its centre
            at 26px; the field's text starts at 16px. That is the Claude /
            ChatGPT geometry — the glyph reads as hanging just outside the
            text column rather than indented into it. */}
        <div className="flex flex-nowrap items-center gap-1 px-2.5 pb-2.5 pt-0.5">
          <div className={cn("flex min-w-0 shrink-0 items-center gap-1", dim)}>
            {leading}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1">
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

/* ————————————————————————————————————————————————————————————————————————
 * Shared recipes
 * ———————————————————————————————————————————————————————————————————— */

/** The height spring every composer grows on (SOFT_UI.md §2.4). */
export const COMPOSER_SPRING = { type: "spring", stiffness: 380, damping: 32 } as const;

/**
 * EVERY PROPERTY THAT DECIDES WHERE A GLYPH LANDS, in one string.
 *
 * The box, the type and the wrapping — and nothing else. It is split out
 * because two elements have to lay the draft out IDENTICALLY: the textarea,
 * and the mirror painted behind it that draws connector mentions with their
 * app's logo (`composerMirrorClass`). A caret that sits one pixel off the
 * letter under it is the most obvious kind of broken an input can be, and the
 * only way to guarantee it is for both to read their metrics from here.
 */
const COMPOSER_FIELD_METRICS =
  // eslint-disable-next-line design-system/no-raw-text-size -- 16px exactly: iOS Safari zooms the page into any focused field below it, and body-lg (17px) is a different measure.
  "block w-full min-h-[3.25rem] px-4 pb-2 pt-3.5 text-base leading-relaxed";

/**
 * The textarea, directly on the surface: transparent, 16px inline padding
 * (the same inset the `+` glyph hangs off), `text-base` because iOS Safari
 * zooms into anything smaller.
 */
export const composerFieldClass = cn(
  COMPOSER_FIELD_METRICS,
  "resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground/80 disabled:opacity-60",
);

/**
 * THE MIRROR: the draft painted a second time, underneath the textarea, so a
 * connector mention can carry its app's logo.
 *
 * A textarea renders one run of plain text and nothing else — no spans, no
 * images — so an `@GitHub` inside the sentence you are typing cannot be drawn
 * as anything but the eight characters it is. The way every editor that shows
 * rich mentions in a plain field does it is to paint the text twice: the
 * textarea keeps the caret, the selection, IME composition, undo and the
 * native mobile keyboard, and goes `text-transparent`; this layer sits behind
 * it and draws the same string with the tokens marked up.
 *
 * It only paints text when there IS a token, which is the safety property that
 * makes the whole technique acceptable on the product's most-used control: a
 * draft with no mentions is drawn by the textarea itself, exactly as before, so
 * a mirror that somehow failed to render could never leave the field looking
 * empty.
 *
 * `select-none` and `pointer-events-none`: this is paint. Every event belongs
 * to the textarea on top of it.
 */
export const composerMirrorClass = cn(
  COMPOSER_FIELD_METRICS,
  "pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words text-foreground",
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
 */
export const composerChipClass =
  "group inline-flex h-8 min-w-0 items-center gap-1 rounded-control px-2 font-sans text-ui font-medium text-muted-foreground transition-[background-color,color,opacity] duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:bg-accent focus-visible:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none coarse:h-10";

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
  /** The mark. A Lucide glyph, or a brand logo for a connector. */
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
  const trigger = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pl-1.5 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {/* A fixed box, so a brand logo and a Lucide glyph put their labels on
          the same edge. `[&_svg]:size-4` reaches the mark whether it arrived as
          a `<GitHubMark>` or as a lucide component. */}
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
        {icon}
      </span>
      <span className={cn("truncate", labelClassName)}>{label}</span>
      {detail && (
        <>
          {/* The derived fact rides muted: it is a CONSEQUENCE of the state,
              not a second state. It is also the FIRST thing to go when the
              composer runs short, at every mark count — the state's NAME
              outranks a qualifier on it, and the qualifier is in the tooltip
              either way. */}
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
        "group/armed inline-flex min-w-0 items-center rounded-md bg-accent align-baseline font-medium text-foreground",
        // It ARRIVES. A tool you just armed appearing with no transition in the
        // line you are typing is the one moment this mark has to be noticed;
        // after that it should be quiet, which is what the rest of the recipe
        // is for. `motion-safe:` because a spring pop is exactly what reduced
        // motion asks not to see.
        "motion-safe:animate-pop-in",
      )}
    >
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
      {/* `opacity-0`, never `hidden`. A ✕ that only takes up space on hover
          re-measures the mark under the pointer and shifts the words after it
          by 20px at the moment you are reaching for one of them. The space is
          reserved at rest and costs nothing but air. */}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={removeLabel}
        className="inline-flex shrink-0 items-center rounded-md py-0.5 pl-1 pr-1.5 text-muted-foreground opacity-0 transition-opacity duration-fast hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0 group-hover/armed:opacity-100 motion-reduce:transition-none coarse:opacity-100"
      >
        <ActionIcons.dismiss aria-hidden className="size-3.5" />
      </button>
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

/** One run of the mirrored draft: plain text, or an app the draft mentions. */
export type ComposerFieldSegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; icon: React.ReactNode };

/**
 * The draft, painted behind the textarea, with its mentions marked up.
 *
 * See `composerMirrorClass` for why a second layer exists at all. What matters
 * here is that a mention must not change a single advance: the caret in the
 * textarea is positioned by the plain string, so anything this layer adds has
 * to be out of flow. The app's logo is therefore drawn ON the "@" — which is
 * transparent, and is about as wide as the mark that covers it — and the
 * token's padding is a `box-shadow` spread, which paints outside the box
 * without occupying any.
 */
export function ComposerFieldMirror({
  segments,
  indent,
  viewportRef,
}: {
  segments: ComposerFieldSegment[];
  indent: number;
  viewportRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={viewportRef} aria-hidden className={composerMirrorClass} style={{ textIndent: indent || undefined }}>
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <React.Fragment key={i}>{segment.value}</React.Fragment>
        ) : (
          <span key={i} className="composer-mention">
            <span className="composer-mention__at" aria-hidden>
              @
              <span className="composer-mention__logo">{segment.icon}</span>
            </span>
            {segment.value}
          </span>
        ),
      )}
      {/* A draft ending in a newline has no content on its last line, and a
          block collapses that line away — so the mirror would come up one row
          short of the textarea and every wrap below the fold would drift. */}
      {"\n"}
    </div>
  );
}

/** The chevron that closes a chip: quiet, and it turns while the chip is open. */
export const composerChevronClass =
  "size-3 shrink-0 opacity-70 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180 motion-reduce:transition-none";

/**
 * A 32px flat icon button (`+`, mic, voice). Written against `<Button
 * variant="ghost" size="icon-sm">`, whose hover raises a card — every
 * raised/pressed class is cancelled here so the button stays flat and only
 * the accent fill arrives.
 */
export const composerIconButtonClass =
  // `focus-visible:outline-none` beside the inset ring, not as well as it. An
  // INSET ring exists for controls flush inside a clipping parent, where the
  // global outline's 2px offset would be clipped away — it REPLACES the global
  // outline (globals.css `:focus-visible`), it never joins it. Without this the
  // focused `+` drew a 2px ring inside a 2px outline: two indicators, one
  // control.
  "size-8 shrink-0 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring border-transparent bg-transparent text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground hover:shadow-none active:border-transparent active:bg-accent active:shadow-none data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:size-10";

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
 * Auto-growing textarea, on the spring.
 *
 * Measures the content height on every value change and animates the field's
 * inline height to it — one line at rest, up to `maxLines` before it scrolls.
 * The measurement is a synchronous set-to-auto / read / restore, so nothing
 * paints in between; framer's `animate` then drives the inline style, which
 * is the same property the measurement reads back from, so an interrupted
 * growth carries on from wherever it was. Reduced motion snaps.
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
  const reduce = useReducedMotion();
  const controls = React.useRef<AnimationPlaybackControls | null>(null);

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const prev = el.style.height;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cap = maxHeight ?? Math.round(line * maxLines + pad);
    const next = Math.max(minHeight, Math.min(el.scrollHeight, cap));
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
    el.style.height = prev;

    controls.current?.stop();
    const from = parseFloat(prev);
    if (!prev || Number.isNaN(from) || reduce || Math.abs(from - next) < 1) {
      el.style.height = `${next}px`;
      return;
    }
    controls.current = animate(from, next, {
      ...COMPOSER_SPRING,
      onUpdate: (v) => {
        el.style.height = `${v}px`;
      },
      onComplete: () => {
        el.style.height = `${next}px`;
      },
    });
  }, [ref, maxLines, maxHeight, minHeight, reduce]);

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
    return () => { active = false; observer.disconnect(); controls.current?.stop(); };
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
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
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
          "composer-primary-action pressable relative grid size-8 shrink-0 place-items-center rounded-full",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          face === "voice"
            ? // Quiet, and reaching the accent only on hover — enough to say it
              // is live without competing with the send circle it becomes.
              "bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
          "disabled:pointer-events-none disabled:bg-secondary disabled:text-muted-foreground/70",
          "motion-reduce:transition-none motion-reduce:active:scale-100 coarse:size-10",
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
                <Square className="size-3 fill-current" />
              </motion.span>
            ) : face === "voice" ? (
              <motion.span key="voice" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                {/* The waveform, not a microphone. A mic is the glyph for
                    dictation — which this composer already has, one button to
                    the left — and the two doing different things behind the
                    same picture is the confusion this row can least afford. */}
                <AudioLines className="size-4" />
              </motion.span>
            ) : (
              <motion.span key="send" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                <ArrowUp className="size-4" strokeWidth={2.5} />
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
  readiness,
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
  readiness?: "reading" | "unreadable" | "partial" | "ready";
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
  const unreadable = readiness === "unreadable";
  const line = unreadable
    ? "Couldn’t read this file"
    : readiness === "partial"
      ? "Read in part"
      : readiness === "reading"
        ? "Reading…"
        : (status ?? meta);

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
    <span className="grid size-16 shrink-0 place-items-center bg-card font-mono text-caption font-medium text-muted-foreground/70">
      {extension}
    </span>
  );

  return (
    <div
      title={status ? `${upload.fileName} — ${status}` : upload.fileName}
      className={cn(
        // `rounded-control`: the same rung as every chip on the row below, so
        // the tiles and the controls read as one family of objects.
        "group relative flex h-16 shrink-0 overflow-hidden rounded-control border border-border/70 bg-secondary",
        isImage ? "w-16" : "w-56 max-w-full",
        (upload.status === "error" || unreadable) && "border-destructive/60",
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
                "truncate font-mono text-micro uppercase",
                unreadable ? "text-destructive" : "text-muted-foreground",
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
      {/* Said out loud too, and as a live region: a reader who cannot see the
          tile turning red has to be TOLD that the file they attached is one
          the model will not receive. */}
      <span role={unreadable ? "status" : undefined} className="sr-only">
        {unreadable
          ? `${upload.fileName} — Juno could not read this file, so its contents will not reach the model.`
          : status
            ? `${upload.fileName}, ${status}`
            : upload.fileName}
      </span>
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
  readiness,
  onRemove,
  className,
}: {
  uploads: readonly PendingUpload[];
  /** Attachment id → whether its text reached the index (`useAttachmentReadiness`). */
  readiness?: ReadonlyMap<string, "reading" | "unreadable" | "partial" | "ready">;
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
                readiness={upload.attachment ? readiness?.get(upload.attachment.id) : undefined}
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
