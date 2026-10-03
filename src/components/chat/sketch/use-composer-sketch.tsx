"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { PendingUpload } from "@/hooks/use-uploads";
import { isSketchFileName, sketchFileName, type SketchDoc } from "@/lib/sketch/sketch-core";
import { sketchStore } from "@/lib/sketch/sketch-store";
import type { SketchResult } from "./sketch-dialog";

/*
 * The composer's side of Sketch: open a fresh sheet (or the last unattached
 * draft), turn a confirmed sketch into an ordinary image upload, and reopen
 * an attached sketch from its tile to keep drawing.
 *
 * The editor is loaded the first time it opens, so a composer that never
 * sketches never downloads it.
 */

const SketchDialog = dynamic(() => import("./sketch-dialog").then((m) => m.SketchDialog), { ssr: false });

interface Editing {
  localId: string;
  fileName: string;
}

export function useComposerSketch({
  addFiles,
  removeUpload,
  imageModel,
}: {
  /** The composer's own file path (`addComposerFiles`), so every rule a file meets applies. */
  addFiles: (files: File[]) => void;
  removeUpload: (localId: string) => void;
  /** The selected model makes pictures: the sketch will guide its layout. */
  imageModel: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [editing, setEditing] = React.useState<Editing | null>(null);
  const [initialDoc, setInitialDoc] = React.useState<SketchDoc | null>(null);

  const openSketch = React.useCallback(() => {
    setEditing(null);
    setInitialDoc(sketchStore.draft);
    setMounted(true);
    setOpen(true);
  }, []);

  /** Reopens an attached sketch, if this session still holds its drawing. */
  const openUpload = React.useCallback((upload: PendingUpload) => {
    const doc = sketchStore.get(upload.fileName);
    if (!doc) return false;
    setEditing({ localId: upload.localId, fileName: upload.fileName });
    setInitialDoc(doc);
    setMounted(true);
    setOpen(true);
    return true;
  }, []);

  const onConfirm = React.useCallback(
    ({ blob, doc }: SketchResult) => {
      const name = sketchStore.uniqueName(sketchFileName());
      sketchStore.put(name, doc);
      if (editing) {
        removeUpload(editing.localId);
        sketchStore.forget(editing.fileName);
      } else {
        sketchStore.draft = null;
      }
      addFiles([new File([blob], name, { type: "image/png" })]);
    },
    [addFiles, editing, removeUpload],
  );

  const onDismiss = React.useCallback(
    (doc: SketchDoc | null) => {
      // An attached sketch keeps its last attached state; only a new sheet becomes the draft.
      if (!editing) sketchStore.draft = doc;
    },
    [editing],
  );

  const dialog = mounted ? (
    <SketchDialog
      open={open}
      onOpenChange={setOpen}
      initialDoc={initialDoc}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      editing={!!editing}
      hint={imageModel ? "The image will follow this layout." : "Attached as an image to your next message."}
    />
  ) : null;

  return {
    openSketch,
    openUpload,
    dialog,
    /** The tile's small label. */
    sketchLabel: (upload: PendingUpload) => (isSketchFileName(upload.fileName) ? "Sketch" : null),
    canReopen: (upload: PendingUpload) => sketchStore.has(upload.fileName),
  };
}
