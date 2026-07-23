"use client";

import * as React from "react";
import { Crop, ImageIcon, ImageOff, Info, MousePointer2, TriangleAlert, Wand2, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, dialogCloseClassName } from "@/components/ui/dialog";
import { GEN_MODELS, imageEditSupport, resolveModel, type ModelInfo } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { ClientAttachment, GenerateEditPayload } from "@/types/chat";
import type { ImageEditInput, SendResult } from "@/hooks/use-chat";

/**
 * Region-based image editor. Drag a marquee over the image (single-pointer,
 * touch included), describe the change, submit — the mask PNG is rendered
 * client-side at the image's natural size (transparent inside the region,
 * opaque black outside: the OpenAI images.edit convention) and the request
 * runs through the normal generation flow.
 */

type Region = { x: number; y: number; w: number; h: number };

// Drags smaller than 2% in either dimension read as an accidental tap → clear.
const MIN_REGION = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const describeRegion = (region: Region) =>
  `Selection at ${Math.round(region.x * 100)}% from the left and ${Math.round(region.y * 100)}% from the top, ${Math.round(region.w * 100)}% wide by ${Math.round(region.h * 100)}% high.`;

/** The model that will run the edit: the currently selected model when it's an
 * image model, otherwise the image that generated the attachment (or an image
 * model from the same provider family). */
function pickEditModel(currentModelId: string, sourceModelId?: string | null): ModelInfo | null {
  const current = resolveModel(currentModelId);
  if (current?.modality === "image") return current;
  const source = sourceModelId ? resolveModel(sourceModelId) : null;
  if (source?.modality === "image") return source;
  if (source) {
    const familyMatch = GEN_MODELS.find((m) => m.modality === "image" && m.provider === source.provider);
    if (familyMatch) return familyMatch;
  }
  return null;
}

interface ImageEditOverlayProps {
  attachment: ClientAttachment;
  /** Model that generated this image (message.model) — provider-family fallback. */
  sourceModelId?: string | null;
  /** Model currently selected in the composer. */
  currentModelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ImageEditInput) => SendResult;
}

export function ImageEditOverlay({
  attachment,
  sourceModelId,
  currentModelId,
  open,
  onOpenChange,
  onSubmit,
}: ImageEditOverlayProps) {
  const canvasAreaRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const dragStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [region, setRegion] = React.useState<Region | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [imgReady, setImgReady] = React.useState(false);
  const [imgFailed, setImgFailed] = React.useState(false);
  const [frameSize, setFrameSize] = React.useState<{ width: number; height: number } | null>(null);
  const [selectionAnnouncement, setSelectionAnnouncement] = React.useState("");
  const selectionHelpId = React.useId();
  const selectionStatusId = React.useId();

  const editModel = React.useMemo(() => pickEditModel(currentModelId, sourceModelId), [currentModelId, sourceModelId]);
  const support = editModel ? imageEditSupport(editModel.provider) : "none";

  // Fresh state each time the editor opens (or targets another image).
  React.useEffect(() => {
    if (!open) return;
    setRegion(null);
    setPrompt("");
    setDragging(false);
    setSelectionAnnouncement("");
    dragStartRef.current = null;
    setFrameSize(null);
    const el = imgRef.current;
    const imageComplete = !!el?.complete;
    const imageDecoded = imageComplete && !!el?.naturalWidth;
    setImgReady(imageDecoded);
    setImgFailed(imageComplete && !imageDecoded);
  }, [open, attachment.id]);

  const fitFrameToCanvas = React.useCallback(() => {
    const canvasArea = canvasAreaRef.current;
    const image = imgRef.current;
    if (!canvasArea) return;

    const rect = canvasArea.getBoundingClientRect();
    const styles = window.getComputedStyle(canvasArea);
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const availableWidth = Math.max(1, rect.width - horizontalPadding);
    const availableHeight = Math.max(1, rect.height - verticalPadding);

    // Loading and error states keep a compact, predictable 16:11 canvas.
    // Once decoded, the frame adopts the image's exact aspect ratio so the
    // visible pixels, marquee coordinates, and generated mask all agree.
    const sourceWidth = imgReady && !imgFailed && image?.naturalWidth ? image.naturalWidth : 320;
    const sourceHeight = imgReady && !imgFailed && image?.naturalHeight ? image.naturalHeight : 220;
    const scale = Math.min(
      availableWidth / sourceWidth,
      availableHeight / sourceHeight,
      imgReady && !imgFailed ? Number.POSITIVE_INFINITY : 1
    );
    const next = {
      width: Math.max(1, sourceWidth * scale),
      height: Math.max(1, sourceHeight * scale),
    };

    setFrameSize((current) =>
      current && Math.abs(current.width - next.width) < 0.5 && Math.abs(current.height - next.height) < 0.5 ? current : next
    );
  }, [imgFailed, imgReady]);

  React.useLayoutEffect(() => {
    if (!open) return;
    const canvasArea = canvasAreaRef.current;
    if (!canvasArea) return;

    fitFrameToCanvas();
    const observer = new ResizeObserver(fitFrameToCanvas);
    observer.observe(canvasArea);
    window.visualViewport?.addEventListener("resize", fitFrameToCanvas);

    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", fitFrameToCanvas);
    };
  }, [attachment.id, fitFrameToCanvas, open]);

  const toNormalized = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = frameRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!imgReady || imgFailed || support === "none") return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toNormalized(e);
    dragStartRef.current = p;
    setDragging(true);
    setRegion({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const p = toNormalized(e);
    setRegion({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  };

  const endDrag = () => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    setRegion((r) => (r && r.w >= MIN_REGION && r.h >= MIN_REGION ? r : null));
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!imgReady || imgFailed || support === "none") return;

    if ((e.key === "Enter" || e.key === " ") && !region) {
      e.preventDefault();
      e.stopPropagation();
      const next = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      setRegion(next);
      setSelectionAnnouncement(describeRegion(next));
      return;
    }

    if (e.key === "Escape" && region) {
      e.preventDefault();
      e.stopPropagation();
      setRegion(null);
      setSelectionAnnouncement("Selection cleared. Changes apply to the whole image.");
      return;
    }

    if (!region || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.altKey ? 0.005 : 0.02;

    let next = region;
    if (e.shiftKey) {
      if (e.key === "ArrowLeft") next = { ...region, w: Math.max(MIN_REGION, region.w - step) };
      else if (e.key === "ArrowRight") next = { ...region, w: Math.min(1 - region.x, region.w + step) };
      else if (e.key === "ArrowUp") next = { ...region, h: Math.max(MIN_REGION, region.h - step) };
      else next = { ...region, h: Math.min(1 - region.y, region.h + step) };
    } else if (e.key === "ArrowLeft") next = { ...region, x: Math.max(0, region.x - step) };
    else if (e.key === "ArrowRight") next = { ...region, x: Math.min(1 - region.w, region.x + step) };
    else if (e.key === "ArrowUp") next = { ...region, y: Math.max(0, region.y - step) };
    else next = { ...region, y: Math.min(1 - region.h, region.y + step) };

    setRegion(next);
    setSelectionAnnouncement(describeRegion(next));
  };

  /** Opaque-black canvas at the natural size with the region cleared to
   * transparent. No cross-origin pixels are ever drawn, so toDataURL is safe. */
  const buildMask = (): string | undefined => {
    const img = imgRef.current;
    const r = region;
    if (!img || !r) return undefined;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(Math.round(r.x * w), Math.round(r.y * h), Math.max(1, Math.round(r.w * w)), Math.max(1, Math.round(r.h * h)));
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return undefined;
    }
  };

  const canSubmit = prompt.trim().length > 0 && support !== "none" && !!editModel && (region == null || imgReady);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !editModel) return;
    const edit: GenerateEditPayload = { attachmentId: attachment.id };
    if (region) {
      edit.region = { x: round4(region.x), y: round4(region.y), w: round4(region.w), h: round4(region.h) };
      // "prompt"-level providers take the region as guidance only — no hard mask.
      if (support === "mask") {
        const mask = buildMask();
        if (mask) edit.maskDataUrl = mask;
      }
    }
    const result = onSubmit({ prompt: prompt.trim(), model: editModel.id, edit });
    if (result.accepted) onOpenChange(false);
  };

  // Caption clips against the frame's top edge when the region hugs the top —
  // flip it below the marquee in that case.
  const captionBelow = region != null && region.y < 0.14;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `bg-background` on purpose — an image editor needs an opaque working
          surface — but the radius, border and close button are the shared ones
          so it still reads as the same family of modal. */}
      <DialogContent
        hideClose
        className="h-[min(92dvh,46rem)] max-h-[92dvh] w-[calc(100%-1rem)] max-w-[68rem] gap-0 overflow-hidden bg-background p-0 backdrop-blur-none sm:w-[calc(100%-2rem)] md:h-[min(86dvh,43rem)]"
      >
        {/* Rendered here rather than by DialogContent: the layout is `p-0`, so
            the button has to clear the canvas header instead of the padding. */}
        <DialogClose className={cn("group/close absolute right-3 top-3 z-50 sm:right-4 sm:top-4", dialogCloseClassName)}>
          <X className="size-4 transition-transform duration-fast ease-out-soft group-hover/close:rotate-90 motion-reduce:transition-none motion-reduce:group-hover/close:rotate-0" aria-hidden="true" />
          <span className="sr-only">Close image editor</span>
        </DialogClose>

        <div className="grid h-full min-h-0 w-full grid-rows-[minmax(15rem,42%)_minmax(0,1fr)] md:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.85fr)] md:grid-rows-1">
          {/* Canvas workspace */}
          <section className="relative flex min-h-0 flex-col overflow-hidden border-b border-border/60 bg-muted/20 md:border-b-0 md:border-r" aria-label="Image canvas">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 px-4 pr-14 sm:px-5 sm:pr-16">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-border/60 bg-background text-muted-foreground shadow-soft">
                <ImageIcon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-foreground">{attachment.fileName}</p>
                <p className="text-[11px] text-muted-foreground">Edit canvas</p>
              </div>
              <span className="ml-auto hidden shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] text-muted-foreground shadow-soft sm:inline-flex">
                {region ? <Crop className="size-3" aria-hidden="true" /> : <ImageIcon className="size-3" aria-hidden="true" />}
                {region ? "Selected area" : "Whole image"}
              </span>
            </header>

            <div ref={canvasAreaRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 sm:p-6 lg:p-8">
              <div
                ref={frameRef}
                role="group"
                aria-label="Image selection canvas"
                aria-describedby={`${selectionHelpId} ${selectionStatusId}`}
                aria-keyshortcuts="Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
                tabIndex={support === "none" || imgFailed || !imgReady ? -1 : 0}
                onKeyDown={handleCanvasKeyDown}
                className="relative shrink-0 select-none overflow-hidden rounded-[14px] bg-background shadow-[0_18px_50px_hsl(var(--foreground)/0.12)] ring-1 ring-inset ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-4 focus-visible:ring-offset-muted/20"
                style={frameSize ? { width: frameSize.width, height: frameSize.height } : { width: "min(16rem, 100%)", height: "min(11rem, 100%)" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={attachment.url}
                  alt={attachment.fileName}
                  draggable={false}
                  onLoad={() => {
                    setImgFailed(false);
                    setImgReady(true);
                  }}
                  onError={() => {
                    setImgReady(false);
                    setImgFailed(true);
                  }}
                  className={cn(
                    "block size-full rounded-[13px] object-contain transition-opacity duration-fast motion-reduce:transition-none",
                    imgReady && !imgFailed ? "opacity-100" : "opacity-0"
                  )}
                />

                {!imgReady && !imgFailed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground" role="status">
                    <span className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40">
                      <ImageIcon className="size-4 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                    </span>
                    <span className="text-xs">Preparing image…</span>
                  </div>
                )}

                {imgFailed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                    <span className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40">
                      <ImageOff className="size-4" aria-hidden="true" />
                    </span>
                    <span className="text-xs">Couldn&apos;t load this image.</span>
                  </div>
                )}

                {/* Pointer-capture layer */}
                {imgReady && !imgFailed && support !== "none" && (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 z-10 cursor-crosshair"
                    style={{ touchAction: "none" }}
                    onPointerDown={(e) => {
                      frameRef.current?.focus({ preventScroll: true });
                      onPointerDown(e);
                    }}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  />
                )}

                {region == null && imgReady && !imgFailed && support !== "none" && (
                  <div aria-hidden="true" className="pointer-events-none absolute inset-1.5 z-20 rounded-[10px] border border-dashed border-white/60 mix-blend-difference" />
                )}

                {region && (
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute z-20 rounded-[3px] border border-white/90",
                      "shadow-[0_0_0_9999px_hsl(0_0%_0%/0.58),0_0_0_1px_hsl(0_0%_0%/0.34)]",
                      dragging ? "transition-none" : "transition-[left,top,width,height] duration-fast ease-out-soft motion-reduce:transition-none"
                    )}
                    style={{
                      left: `${region.x * 100}%`,
                      top: `${region.y * 100}%`,
                      width: `${region.w * 100}%`,
                      height: `${region.h * 100}%`,
                    }}
                  >
                    {(["tl", "tr", "bl", "br"] as const).map((c) => (
                      <span
                        key={c}
                        className={cn(
                          "absolute size-3 border-0 border-white drop-shadow-sm",
                          c[0] === "t" ? "-top-px border-t-2" : "-bottom-px border-b-2",
                          c[1] === "l" ? "-left-px border-l-2" : "-right-px border-r-2"
                        )}
                      />
                    ))}
                    <span
                      className={cn(
                        "absolute left-0 whitespace-nowrap rounded-[6px] border border-white/20 bg-black/75 px-2 py-1 font-mono text-[10px] tabular-nums text-white shadow-soft backdrop-blur-sm",
                        captionBelow ? "-bottom-2 translate-y-full" : "-top-2 -translate-y-full"
                      )}
                    >
                      {Math.round(region.w * 100)}% × {Math.round(region.h * 100)}%
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-t border-border/50 px-4 text-[11px] text-muted-foreground sm:px-5">
              <p id={selectionHelpId} className="flex min-w-0 items-center gap-2">
                <MousePointer2 className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">Drag to select. Keyboard: Enter, arrows, Shift + arrows, Escape.</span>
              </p>
              {region && (
                <button
                  type="button"
                  onClick={() => {
                    setRegion(null);
                    setSelectionAnnouncement("Selection cleared. Changes apply to the whole image.");
                  }}
                  className="shrink-0 rounded-[7px] px-2 py-1 font-medium text-foreground outline-none transition-colors duration-fast hover:bg-background focus-visible:ring-2 focus-visible:ring-foreground/15 motion-reduce:transition-none"
                >
                  Clear selection
                </button>
              )}
            </div>
          </section>

          {/* Edit controls */}
          <aside className="min-h-0 overflow-y-auto bg-card" aria-label="Image edit controls">
            <form onSubmit={handleSubmit} className="flex min-h-full flex-col p-5 pt-6 sm:p-6 md:p-7">
              <div className="pr-9">
                <p className="font-mono text-[10px] font-semibold text-muted-foreground">Image editor</p>
                <DialogTitle className="mt-2 font-serif text-[26px] font-normal leading-tight tracking-[-0.02em] text-foreground">Edit image</DialogTitle>
                <DialogDescription className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                  Describe the change and optionally target a precise area.
                </DialogDescription>
              </div>

              <fieldset className="mt-6">
                <legend className="mb-2 font-mono text-[10px] font-semibold text-muted-foreground">Edit area</legend>
                <div className="grid grid-cols-2 gap-1 rounded-[12px] border border-border/60 bg-muted/40 p-1" role="group" aria-label="Edit area">
                  <button
                    type="button"
                    aria-pressed={region == null}
                    onClick={() => {
                      setRegion(null);
                      setSelectionAnnouncement("Selection cleared. Changes apply to the whole image.");
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center gap-2 rounded-[8px] px-3 text-[12px] font-medium outline-none transition-[background-color,color,box-shadow,transform] duration-fast ease-out-soft active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-foreground/15 motion-reduce:transition-none motion-reduce:active:scale-100",
                      region == null ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <ImageIcon className="size-3.5" aria-hidden="true" />
                    Whole image
                  </button>
                  <button
                    type="button"
                    aria-pressed={region != null}
                    onClick={() => frameRef.current?.focus({ preventScroll: true })}
                    className={cn(
                      "flex h-9 items-center justify-center gap-2 rounded-[8px] px-3 text-[12px] font-medium outline-none transition-[background-color,color,box-shadow,transform] duration-fast ease-out-soft active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-foreground/15 motion-reduce:transition-none motion-reduce:active:scale-100",
                      region != null ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Crop className="size-3.5" aria-hidden="true" />
                    {region ? "Selected area" : "Select area"}
                  </button>
                </div>
                <p className="mt-2 min-h-4 text-[11px] leading-relaxed text-muted-foreground">
                  {region
                    ? `Selection: ${Math.round(region.w * 100)}% × ${Math.round(region.h * 100)}%.`
                    : "Applies to the whole image."}
                </p>
                <p id={selectionStatusId} role="status" aria-live="polite" className="sr-only">
                  {selectionAnnouncement}
                </p>
              </fieldset>

              {support === "none" && (
                <div role="status" className="mt-4 flex items-start gap-2.5 rounded-[12px] border border-destructive/25 bg-destructive/[0.045] px-3.5 py-3 text-[12px] leading-relaxed text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {editModel
                      ? `${editModel.name} does not support editing. Switch to GPT Image, Nano Banana, or Grok Imagine.`
                      : "Choose an image model in the composer to edit this image."}
                  </span>
                </div>
              )}

              {support === "prompt" && editModel && (
                <div className="mt-4 flex items-start gap-2.5 rounded-[12px] border border-border/60 bg-muted/25 px-3.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{editModel.name} uses the selected area as guidance, so nearby details may also adjust.</span>
                </div>
              )}

              <div className="mt-5">
                <label htmlFor={`${selectionHelpId}-prompt`} className="font-mono text-[10px] font-semibold text-muted-foreground">
                  Instructions
                </label>
                <div className="mt-2 overflow-hidden rounded-[14px] border border-border/70 bg-background shadow-[inset_0_1px_2px_hsl(var(--foreground)/0.035)] transition-[border-color,box-shadow] duration-fast focus-within:border-foreground/25 focus-within:shadow-[0_0_0_3px_hsl(var(--foreground)/0.06)]">
                  <textarea
                    id={`${selectionHelpId}-prompt`}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={region ? "Describe what should change inside the selection…" : "Describe how the image should change…"}
                    aria-label="Describe changes"
                    disabled={support === "none"}
                    className="h-28 w-full resize-none bg-transparent px-3.5 py-3 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 md:h-32"
                  />
                  <div className="flex min-h-9 items-center justify-between gap-3 border-t border-border/50 px-3 text-[10px] text-muted-foreground">
                    <span className="truncate">{region ? "Editing selected area" : "Editing whole image"}</span>
                    {editModel && <span className="shrink-0 font-mono">{editModel.name}</span>}
                  </div>
                </div>
              </div>

              <div className="mt-auto flex items-center justify-end gap-2 pt-6">
                <DialogClose asChild>
                  <button
                    type="button"
                    className="h-10 rounded-full px-4 text-[13px] font-medium text-muted-foreground outline-none transition-[color,background-color,transform] duration-fast ease-out-soft hover:bg-muted hover:text-foreground active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none motion-reduce:active:scale-100"
                  >
                    Cancel
                  </button>
                </DialogClose>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="group/apply inline-flex h-10 min-w-36 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-[13px] font-semibold text-background outline-none transition-[opacity,transform] duration-fast ease-out-soft hover:opacity-90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-none motion-reduce:active:scale-100"
                >
                  <Wand2 className="size-3.5 transition-transform duration-base ease-out-soft group-hover/apply:-translate-y-0.5 group-hover/apply:rotate-[-8deg] motion-reduce:transition-none motion-reduce:group-hover/apply:translate-y-0 motion-reduce:group-hover/apply:rotate-0" aria-hidden="true" />
                  <span>Generate edit</span>
                </button>
              </div>
            </form>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
