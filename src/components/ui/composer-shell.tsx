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

import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
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
      <div ref={fieldTierRef} className="relative flex w-full min-w-0 flex-col">
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
 * The textarea, directly on the surface: transparent, 16px inline padding
 * (the same inset the `+` glyph hangs off), `text-base` because iOS Safari
 * zooms into anything smaller.
 */
export const composerFieldClass =
  // eslint-disable-next-line design-system/no-raw-text-size -- 16px exactly: iOS Safari zooms the page into any focused field below it, and body-lg (17px) is a different measure.
  "block w-full resize-none bg-transparent min-h-[3.25rem] px-4 pb-2 pt-3.5 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80 disabled:opacity-60";

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
          "composer-primary-action pressable relative grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,color] duration-fast ease-out-soft",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-95",
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
 * Attachments: a row of 56px thumbnails above the text
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

/** One 56px tile: the image itself, or the file's extension over a glyph. */
export function ComposerAttachmentTile({
  upload,
  onRemove,
  className,
}: {
  upload: PendingUpload;
  onRemove?: () => void;
  className?: string;
}) {
  const image = upload.attachment?.kind === "IMAGE" ? upload.attachment : null;
  const status =
    upload.status === "uploading" ? `Uploading ${upload.progress}%` : upload.status === "error" ? "Failed" : null;
  return (
    <div
      title={status ? `${upload.fileName} — ${status}` : upload.fileName}
      className={cn(
        // `rounded-control`: the same rung as every chip on the row below,
        // so the tiles and the controls read as one family of objects.
        "group relative size-14 shrink-0 overflow-hidden rounded-control border border-border/70 bg-secondary",
        upload.status === "error" && "border-destructive/60",
        className
      )}
    >
      {image ? (
        <Image
          src={image.url}
          unoptimized={requiresViewerCredentials(image.url)}
          alt={upload.fileName}
          fill
          sizes="56px"
          className="object-cover"
        />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-0.5 text-muted-foreground">
          <CodeIcons.file className="size-5" aria-hidden="true" />
          <span className="font-mono text-micro leading-none">{fileExtension(upload.fileName)}</span>
        </span>
      )}
      {upload.status === "uploading" && (
        <span className="absolute inset-0 grid place-items-center bg-card/70">
          <Loader2 className="size-4 animate-spin text-foreground" aria-hidden="true" />
        </span>
      )}
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
 * The thumbnail row. Tiles pop in on the spring and pop out on removal;
 * the row itself takes no space while it is empty.
 */
export function ComposerAttachmentRow({
  uploads,
  onRemove,
  className,
}: {
  uploads: readonly PendingUpload[];
  onRemove: (localId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2 px-4 pt-3.5 empty:hidden", className)}>
      <MotionConfig reducedMotion="user">
        <AnimatePresence initial={false}>
          {uploads.map((upload) => (
            <motion.div key={upload.localId} layout {...TILE_MOTION}>
              <ComposerAttachmentTile upload={upload} onRemove={() => onRemove(upload.localId)} />
            </motion.div>
          ))}
        </AnimatePresence>
      </MotionConfig>
    </div>
  );
}

export { ComposerShell, ComposerPrimaryAction };
