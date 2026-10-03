"use client";

import * as React from "react";
import { SketchDialog, type SketchResult } from "@/components/chat/sketch/sketch-dialog";
import { ComposerAttachmentRow } from "@/components/ui/composer-shell";
import type { PendingUpload } from "@/hooks/use-uploads";
import { exportSize, sketchFileName, type SketchDoc } from "@/lib/sketch/sketch-core";

declare global {
  interface Window {
    /** Read by the Playwright check: the last export. */
    __sketchExport?: { width: number; height: number; bytes: number; objects: number; dataUrl: string };
  }
}

export function SketchGallery({ openOnLoad }: { openOnLoad: boolean }) {
  const [open, setOpen] = React.useState(openOnLoad);
  const [doc, setDoc] = React.useState<SketchDoc | null>(null);
  const [upload, setUpload] = React.useState<PendingUpload | null>(null);
  const [draft, setDraft] = React.useState<SketchDoc | null>(null);

  const onConfirm = async ({ blob, doc: next }: SketchResult) => {
    const url = URL.createObjectURL(blob);
    const name = sketchFileName();
    const bitmap = await createImageBitmap(blob);
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    window.__sketchExport = { width: bitmap.width, height: bitmap.height, bytes: blob.size, objects: next.objects.length, dataUrl };
    setDoc(next);
    setDraft(null);
    setUpload({
      localId: "dev-sketch",
      fileName: name,
      size: blob.size,
      progress: 100,
      status: "done",
      attachment: {
        id: "dev-sketch",
        kind: "IMAGE",
        fileName: name,
        mimeType: "image/png",
        size: blob.size,
        url,
      } as NonNullable<PendingUpload["attachment"]>,
    });
  };

  const expected = doc ? exportSize(doc.width, doc.height) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 bg-background p-6 text-foreground">
      <h1 className="font-serif text-display">Sketch</h1>
      <p className="text-body text-muted-foreground">
        The real dialog. Draw, attach, then click the tile to keep drawing.
      </p>
      <div>
        <button
          type="button"
          data-testid="open-sketch"
          className="rounded-full bg-foreground px-4 py-2 text-ui font-medium text-background"
          onClick={() => setOpen(true)}
        >
          Open sketch
        </button>
      </div>
      {upload ? (
        <section className="flex flex-col gap-2" data-testid="attachment-row">
          <h2 className="text-ui font-medium">Composer attachment row</h2>
          <div className="rounded-panel border border-border bg-card">
            <ComposerAttachmentRow
              className="pb-3.5"
              uploads={[upload]}
              onRemove={() => setUpload(null)}
              labelFor={() => "Sketch"}
              openerFor={() => () => setOpen(true)}
            />
          </div>
          {expected ? (
            <p className="font-mono text-caption text-muted-foreground" data-testid="export-size">
              paper {doc!.width}×{doc!.height} → png {expected.width}×{expected.height}
            </p>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={upload.attachment!.url}
            alt="The exported sketch"
            className="max-w-full rounded-xl border border-border"
            data-testid="export-image"
          />
        </section>
      ) : null}
      <SketchDialog
        open={open}
        onOpenChange={setOpen}
        initialDoc={doc ?? draft}
        onConfirm={onConfirm}
        onDismiss={(d) => {
          if (!doc) setDraft(d);
        }}
        editing={!!doc}
        hint="The image will follow this layout."
      />
    </main>
  );
}
