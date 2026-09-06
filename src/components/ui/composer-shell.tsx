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
import { ArrowUp, Loader2, Square } from "lucide-react";

import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import { cn } from "@/lib/utils";
import type { PendingUpload } from "@/hooks/use-uploads";

/**
 * The composer: one quiet surface (docs/design/SOFT_UI.md §3).
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  above      attachment thumbnails / quote     │
 *   │  field      the textarea, directly on the     │
 *   │             surface — no well, no second box  │
 *   │  leading ······················ trailing  ●   │  one controls row
 *   └──────────────────────────────────────────────┘
 *
 * The material is `.composer-surface` (globals.css): `bg-card`, a 1px
 * hairline, one low shadow. Focus darkens the edge and lifts the shadow one
 * notch; nothing else changes. There is deliberately no second tier — every
 * chip a surface needs (model, effort, target, permission, project) sits on
 * the same row, and the row scrolls sideways before it ever stacks.
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
  /** Right cluster, before the primary action: model, effort, mic. */
  trailing?: React.ReactNode;
  /** The primary action — send ⇄ stop ⇄ voice. Never dimmed. */
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
      className={cn("composer-surface relative flex w-full flex-col rounded-panel", className)}
      {...props}
    >
      <div ref={fieldTierRef} className="relative flex w-full min-w-0 flex-col">
        {above}
        {field}
        <div className="flex flex-nowrap items-center gap-1.5 px-3 pb-3 pt-1">
          <div className={cn("flex min-w-0 shrink-0 items-center gap-1.5", dim)}>
            {leading}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {trailing && <div className={cn("flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar py-1", dim)}>{trailing}</div>}
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
 * The textarea, directly on the surface: transparent, 16px inline / 14px
 * block padding, `text-base` because iOS Safari zooms into anything smaller.
 */
export const composerFieldClass =
  "block w-full resize-none bg-transparent min-h-16 px-5 pb-3 pt-4 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60";

/**
 * A flat text chip on the controls row: model, effort, target, permission.
 * Hover fills with the accent; open is the same fill with darker ink. No
 * raised or pressed treatment — the row is one quiet line of text.
 */
export const composerChipClass =
  "group inline-flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-control px-2.5 font-sans text-ui font-medium text-foreground/80 transition-[background-color,color,opacity] duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:bg-accent focus-visible:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none coarse:h-11";

/** The chevron that closes a chip: quiet, and it turns while the chip is open. */
export const composerChevronClass =
  "size-3 shrink-0 opacity-60 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180 motion-reduce:transition-none";

/**
 * A 36px flat icon button (`+`, mic). Written against `<Button variant="ghost"
 * size="icon-sm">`, whose hover raises a card — every raised/pressed class is
 * cancelled here so the button stays flat and only the accent fill arrives.
 */
export const composerIconButtonClass =
  "size-9 shrink-0 rounded-control focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring border-transparent bg-transparent text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground hover:shadow-none active:border-transparent active:bg-accent active:shadow-none data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:size-11";

/** The thin rule between the chips and the mic/send pair. */
export function ComposerDivider({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("mx-1 hidden h-4 w-px shrink-0 bg-border min-[380px]:block", className)} />;
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
 * Primary action: send ⇄ stop ⇄ voice ⇄ busy
 * ———————————————————————————————————————————————————————————————————— */

export type ComposerPrimaryFace = "send" | "stop" | "voice" | "busy";

const FACE_MOTION = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.9 },
  transition: { duration: 0.12, ease: [0.2, 0, 0, 1] as const },
};

/**
 * The 36px coral circle. Flat — no raised shadow, no halo — and its face
 * cross-morphs (scale .9→1 + fade over `duration-fast`) between send, stop,
 * the voice wave and a spinner. `.composer-primary-action` is kept as a class
 * hook for the e2e suite; it carries no styles.
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
        className={cn(
          "composer-primary-action pressable relative grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card hover:bg-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-40",
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
                <Square className="size-3 fill-current" />
              </motion.span>
            ) : face === "voice" ? (
              <motion.span key="voice" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                <span className="composer-voice-wave">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              </motion.span>
            ) : (
              <motion.span key="send" className="col-start-1 row-start-1 grid place-items-center" {...FACE_MOTION} aria-hidden="true">
                <ArrowUp className="size-4" strokeWidth={2.25} />
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
        "group relative size-14 shrink-0 overflow-hidden rounded-field border border-border/70 bg-secondary",
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
