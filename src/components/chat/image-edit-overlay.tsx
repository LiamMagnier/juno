"use client";

import * as React from "react";
import { ImageOff, Info, Wand2, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
      <DialogContent className="max-w-5xl gap-0 overflow-hidden border border-border bg-card p-0 shadow-glass rounded-panel md:h-[580px] max-h-[85vh]">
        <div className="grid h-full w-full grid-cols-1 md:grid-cols-[1.35fr_1fr]">
          {/* Left Column: Canvas Workspace */}
          <div className="relative flex max-h-[45vh] flex-col items-center justify-center overflow-hidden border-b border-border/60 bg-muted/20 p-10 md:max-h-none md:border-b-0 md:border-r md:rounded-l-panel">
            <div
              ref={frameRef}
              className="relative max-h-[440px] max-w-full select-none overflow-hidden rounded-2xl border border-border/80 bg-background/50 shadow-soft"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={attachment.url}
                alt={attachment.fileName}
                draggable={false}
                onLoad={() => setImgReady(true)}
                onError={() => setImgFailed(true)}
                className="block max-h-[420px] w-auto max-w-full object-contain rounded-2xl"
              />

              {imgFailed && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                  <ImageOff className="h-5 w-5" aria-hidden="true" />
                  <span className="text-caption">Couldn&apos;t load this image.</span>
                </div>
              )}

              {/* Pointer-capture layer */}
              <div
                aria-hidden="true"
                className="absolute inset-0 z-10 cursor-crosshair"
                style={{ touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />

              {/* Whole-image mode: quiet dashed frame */}
              {region == null && !imgFailed && support !== "none" && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-20 rounded-2xl outline-dashed outline-1 -outline-offset-4 outline-primary/30"
                />
              )}

              {/* Region marquee: crop frame */}
              {region && (
                <div
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute z-20 bg-primary/[0.02] outline outline-1 outline-primary/70 rounded-[2px]",
                    "shadow-[0_0_0_9999px_hsl(var(--foreground)/0.55)] dark:shadow-[0_0_0_9999px_hsl(var(--background)/0.72)]",
                    dragging ? "transition-none" : "transition-[left,top,width,height] duration-fast ease-out-soft"
                  )}
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.w * 100}%`,
                    height: `${region.h * 100}%`,
                  }}
                >
                  {(["tl", "tr", "bl", "br"] as const).map((c) => (
                    <React.Fragment key={c}>
                      <span
                        className={cn(
                          "absolute h-px w-2.5 bg-primary",
                          c[0] === "t" ? "top-0" : "bottom-0",
                          c[1] === "l" ? "left-0" : "right-0"
                        )}
                      />
                      <span
                        className={cn(
                          "absolute h-2.5 w-px bg-primary",
                          c[0] === "t" ? "top-0" : "bottom-0",
                          c[1] === "l" ? "left-0" : "right-0"
                        )}
                      />
                    </React.Fragment>
                  ))}
                  <span
                    className={cn(
                      "absolute left-0 rounded-sm border border-border/70 bg-background/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider tabular-nums text-foreground shadow-soft",
                      captionBelow ? "-bottom-2 translate-y-full" : "-top-2 -translate-y-full"
                    )}
                  >
                    {Math.round(region.w * 100)}% × {Math.round(region.h * 100)}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Control Panel */}
          <div className="flex flex-col justify-between p-8 h-full bg-card">
            {/* Top: Header */}
            <div>
              <p className="text-[10px] font-bold tracking-widest text-primary uppercase font-sans">Canvas Editor</p>
              <DialogTitle className="mt-1 font-serif text-title font-normal text-foreground">Edit Image</DialogTitle>
              <DialogDescription className="mt-2 text-xs leading-relaxed text-muted-foreground/95">
                Drag a marquee region directly on the canvas to isolate a change, or describe instructions to regenerate the whole image.
              </DialogDescription>
            </div>

            {/* Middle: Selection Settings & Info */}
            <div className="flex flex-col gap-5 my-5">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">Scope</label>
                <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 p-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setRegion(null)}
                    className={cn(
                      "rounded-full px-4 py-1.5 text-xs font-medium transition-all",
                      region == null
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Whole Image
                  </button>
                  <button
                    type="button"
                    disabled={region == null}
                    className={cn(
                      "rounded-full px-4 py-1.5 text-xs font-medium transition-all disabled:opacity-40",
                      region != null
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Selected Region
                  </button>
                </div>
              </div>

              {region && (
                <div className="text-[11px] text-muted-foreground/90 font-mono flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                  <span>Region bounds: {Math.round(region.w * 100)}% × {Math.round(region.h * 100)}%</span>
                </div>
              )}

              {editModel && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 w-fit px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span>Model: {editModel.name}</span>
                </div>
              )}

              {support === "none" && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-relaxed text-destructive"
                >
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {editModel
                      ? `${editModel.name} does not support editing — switch to GPT Image, Nano Banana, or Grok Imagine.`
                      : "Pick an image model in the composer to edit here."}
                  </span>
                </div>
              )}

              {support === "prompt" && editModel && (
                <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/25 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {editModel.name} blends changes based on regional weights. Details near the boundary may adjust.
                  </span>
                </div>
              )}
            </div>

            <div className="h-px w-full bg-border/60 my-1" />

            {/* Bottom: Instructions Input & Submit Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">Instructions</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe what to add, remove, or replace in this area..."
                  aria-label="Describe changes"
                  disabled={support === "none"}
                  autoFocus
                  className="field-well h-28 w-full p-3 resize-none border border-border/80 rounded-xl bg-muted/10 text-xs focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/50 leading-relaxed text-foreground transition-all placeholder:text-muted-foreground/60 disabled:opacity-50"
                />
              </div>
              <button
                type="submit"
                disabled={!canSubmit}
                className="sheen-sweep btn-glossy halo-primary inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-full bg-primary text-sm font-semibold text-primary-foreground hover:brightness-[1.06] active:scale-[0.98] active:brightness-[0.97] transition-all duration-fast disabled:opacity-40 disabled:pointer-events-none"
              >
                <Wand2 className="h-[15px] w-[15px]" aria-hidden="true" />
                <span>Apply Changes</span>
              </button>
            </form>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
