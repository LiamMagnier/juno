"use client";

import * as React from "react";
import { Crop, ImageIcon, ImageOff, Info, MousePointer2, TriangleAlert, Wand2, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { GEN_MODELS, imageEditSupport, resolveModel, type ModelInfo } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { ClientAttachment, GenerateEditPayload } from "@/types/chat";
import type { ImageEditInput } from "@/hooks/use-chat";

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
  onSubmit: (input: ImageEditInput) => void;
}

export function ImageEditOverlay({
  attachment,
  sourceModelId,
  currentModelId,
  open,
  onOpenChange,
  onSubmit,
}: ImageEditOverlayProps) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const dragStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [region, setRegion] = React.useState<Region | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [imgReady, setImgReady] = React.useState(false);
  const [imgFailed, setImgFailed] = React.useState(false);
  const selectionHelpId = React.useId();

  const editModel = React.useMemo(() => pickEditModel(currentModelId, sourceModelId), [currentModelId, sourceModelId]);
  const support = editModel ? imageEditSupport(editModel.provider) : "none";

  // Fresh state each time the editor opens (or targets another image).
  React.useEffect(() => {
    if (!open) return;
    setRegion(null);
    setPrompt("");
    setDragging(false);
    dragStartRef.current = null;
    const el = imgRef.current;
    setImgReady(!!el?.complete && !!el.naturalWidth);
    setImgFailed(false);
  }, [open, attachment.id]);

  const toNormalized = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = frameRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
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
    if (e.key !== "Escape" || !region) return;
    e.preventDefault();
    e.stopPropagation();
    setRegion(null);
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
    onSubmit({ prompt: prompt.trim(), model: editModel.id, edit });
    onOpenChange(false);
  };

  // Caption clips against the frame's top edge when the region hugs the top —
  // flip it below the marquee in that case.
  const captionBelow = region != null && region.y < 0.14;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="h-[min(92dvh,46rem)] max-h-[92dvh] w-[calc(100%-1rem)] max-w-[68rem] gap-0 overflow-hidden rounded-[24px] border border-border/70 bg-background p-0 shadow-float sm:w-[calc(100%-2rem)] md:h-[min(86dvh,43rem)]"
      >
        <DialogClose
          className="group/close absolute right-3 top-3 z-50 flex size-9 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-soft backdrop-blur-sm transition-[color,background-color,transform] duration-fast ease-out-soft hover:bg-muted hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:active:scale-100 sm:right-4 sm:top-4"
        >
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

            <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6 lg:p-8">
              <div
                ref={frameRef}
                role="group"
                aria-label="Image selection canvas"
                aria-describedby={selectionHelpId}
                aria-keyshortcuts="Escape"
                tabIndex={support === "none" || imgFailed ? -1 : 0}
                onKeyDown={handleCanvasKeyDown}
                className="relative max-h-full max-w-full select-none overflow-hidden rounded-[14px] border border-border/70 bg-background shadow-[0_18px_50px_hsl(var(--foreground)/0.12)] outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-4 focus-visible:ring-offset-muted/20"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={attachment.url}
                  alt={attachment.fileName}
                  draggable={false}
                  onLoad={() => setImgReady(true)}
                  onError={() => setImgFailed(true)}
                  className="block max-h-[calc(42dvh-5.5rem)] w-auto max-w-full rounded-[13px] object-contain md:max-h-[calc(min(86dvh,43rem)-8rem)]"
                />

                {imgFailed && (
                  <div className="absolute inset-0 flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                    <span className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40">
                      <ImageOff className="size-4" aria-hidden="true" />
                    </span>
                    <span className="text-xs">Couldn&apos;t load this image.</span>
                  </div>
                )}

                {/* Pointer-capture layer */}
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

                {region == null && !imgFailed && support !== "none" && (
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
                          "absolute size-2.5 rounded-[2px] border border-black/30 bg-white shadow-sm",
                          c[0] === "t" ? "-top-1.5" : "-bottom-1.5",
                          c[1] === "l" ? "-left-1.5" : "-right-1.5"
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
                <span className="truncate">Drag over the image to target an area.</span>
              </p>
              {region && (
                <button
                  type="button"
                  onClick={() => setRegion(null)}
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
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Image editor</p>
                <DialogTitle className="mt-2 font-serif text-[26px] font-normal leading-tight tracking-[-0.02em] text-foreground">Edit image</DialogTitle>
                <DialogDescription className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                  Describe the result you want, then apply it to the whole image or one precise area.
                </DialogDescription>
              </div>

              <fieldset className="mt-6">
                <legend className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Edit area</legend>
                <div className="grid grid-cols-2 gap-1 rounded-[12px] border border-border/60 bg-muted/40 p-1" role="group" aria-label="Edit area">
                  <button
                    type="button"
                    aria-pressed={region == null}
                    onClick={() => setRegion(null)}
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
                <p className="mt-2 min-h-4 text-[11px] leading-relaxed text-muted-foreground" aria-live="polite">
                  {region
                    ? `${Math.round(region.w * 100)}% × ${Math.round(region.h * 100)}% of the image will be targeted.`
                    : "No selection — changes apply across the full image."}
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
                <label htmlFor={`${selectionHelpId}-prompt`} className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
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
                    autoFocus
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
