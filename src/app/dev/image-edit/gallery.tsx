"use client";

import * as React from "react";
import { GeneratedImage } from "@/components/chat/generated-media";
import { ImageEditOverlay } from "@/components/chat/image-edit-overlay";
import { Button } from "@/components/ui/button";
import type { ImageEditInput } from "@/hooks/use-chat";
import type { ClientAttachment } from "@/types/chat";

/** A cat-free still life, painted on a canvas so the gallery needs no fixture. */
function paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#5b6fa8");
  sky.addColorStop(0.6, "#f2c48f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const sun = ctx.createRadialGradient(w * 0.68, h * 0.42, 10, w * 0.68, h * 0.42, w * 0.35);
  sun.addColorStop(0, "#fff3dc");
  sun.addColorStop(1, "transparent");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff3dc";
  ctx.beginPath();
  ctx.arc(w * 0.68, h * 0.42, w * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ["#43517a", "#2c3557", "#1a2038"].forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let s = 0; s <= 64; s++) {
      const x = (w * s) / 64;
      ctx.lineTo(x, h * (0.58 + i * 0.13) - Math.sin(x / (w * (0.11 + i * 0.05)) + i * 1.7) * h * (0.05 + i * 0.02));
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
  // A lone tree, something worth selecting.
  ctx.fillStyle = "#121726";
  ctx.fillRect(w * 0.25, h * 0.5, w * 0.012, h * 0.16);
  ctx.beginPath();
  ctx.ellipse(w * 0.256, h * 0.47, w * 0.045, h * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
}

function useSample(w: number, h: number) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, w, h);
    let made: string | null = null;
    let cancelled = false;
    canvas.toBlob((blob) => {
      if (!blob || cancelled) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, "image/png");
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [w, h]);
  return url;
}

export function ImageEditGallery({ dark: startDark, model, startOpen }: { dark?: boolean; model?: string; startOpen?: boolean }) {
  const [dark, setDark] = React.useState(!!startDark);
  const [open, setOpen] = React.useState(false);
  const [origin, setOrigin] = React.useState<DOMRect | null>(null);
  const [last, setLast] = React.useState<ImageEditInput | null>(null);
  const url = useSample(1536, 1024);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  React.useEffect(() => {
    if (startOpen && url) setOpen(true);
  }, [startOpen, url]);

  const attachment: ClientAttachment | null = url
    ? { id: "dev-sample", kind: "IMAGE", fileName: "Nano Banana 2 - Evening hills.png", mimeType: "image/png", size: 1, url, width: 1536, height: 1024 }
    : null;

  return (
    <main className="min-h-dvh bg-background px-4 py-10 text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-label text-muted-foreground">Image editor, dev gallery</p>
          <Button variant="ghost" size="sm" onClick={() => setDark((d) => !d)}>
            {dark ? "Light" : "Dark"}
          </Button>
        </div>
        <p className="text-body">Here is the evening landscape you asked for.</p>
        {attachment && (
          <div data-testid="sample">
            <GeneratedImage
              attachment={attachment}
              onEdit={(rect) => {
                setOrigin(rect ?? null);
                setOpen(true);
              }}
            />
          </div>
        )}
        {last && (
          <pre data-testid="last-edit" className="overflow-x-auto rounded-card bg-secondary p-4 font-mono text-caption">
            {JSON.stringify(
              { ...last, edit: { ...last.edit, maskDataUrl: last.edit.maskDataUrl ? `${last.edit.maskDataUrl.slice(0, 32)}… (${last.edit.maskDataUrl.length} chars)` : undefined } },
              null,
              2
            )}
          </pre>
        )}
      </div>
      {attachment && (
        <ImageEditOverlay
          attachment={attachment}
          sourceModelId="google:gemini-3.1-flash-image"
          currentModelId={model ?? "google:gemini-3.1-flash-image"}
          originRect={origin}
          open={open}
          onOpenChange={setOpen}
          onSubmit={(input) => {
            setLast(input);
            return { accepted: true };
          }}
        />
      )}
    </main>
  );
}
