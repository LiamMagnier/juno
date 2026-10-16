"use client";

/**
 * The Code composer's attachments: paste, drop, the "+" menu, the library and
 * a screen capture, all through Chat's upload pipeline (`useUploads` →
 * `/api/upload`), so a file attached to a Code turn is stored, sniffed and
 * size-checked exactly as one attached to a chat.
 *
 * Two intake rules sit in front of the upload:
 *
 * - HEIC. Nothing on the server decodes it and Chromium cannot draw it, so it
 *   is converted to JPEG here when the browser can decode it (Safari), and
 *   refused with a sentence that says what to do when it cannot. Never
 *   uploaded as an opaque file the model cannot read.
 * - A long paste (over 32 KiB) becomes a text file on the row rather than a
 *   wall of text in the field, as T3 Code does. "Keep it inline" puts it back,
 *   and Mod+Shift+V pastes inline in the first place.
 *
 * The rules are pure (lib/code-v2/composer-attachments.ts); this wires them.
 */
import * as React from "react";
import { toast } from "sonner";
import { useUploads } from "@/hooks/use-uploads";
import { useFileDrop } from "@/components/library/library-drop-zone";
import { HEIC_UNSUPPORTED_MESSAGE, MAX_ATTACHMENTS } from "@/lib/uploads";
import { intakeKind, jpegNameFor, pasteBecomesFile, pastedTextFileName } from "@/lib/code-v2/composer-attachments";
import type { ClientAttachment } from "@/types/chat";

/** The long edge a converted photo keeps: plenty for a screenshot or a photo of a whiteboard. */
const HEIC_MAX_EDGE = 3072;

const TOO_MANY_MESSAGE = `You can attach up to ${MAX_ATTACHMENTS} files per message.`;
const UPLOADS_OFF_MESSAGE = "File uploads aren’t set up on this server.";
const SCREENSHOT_FAILED_MESSAGE = "Couldn’t capture the screen.";

/**
 * A HEIC photo as a JPEG, when this browser can decode HEIC (Safari can,
 * Chromium and Firefox cannot). Null when it cannot.
 */
async function heicToJpeg(file: File): Promise<File | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, HEIC_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return blob ? new File([blob], jpegNameFor(file.name), { type: "image/jpeg", lastModified: file.lastModified }) : null;
  } catch {
    return null;
  }
}

export interface ComposerAttachments {
  /** Uploads can happen here at all (storage configured, composer live). */
  enabled: boolean;
  uploads: ReturnType<typeof useUploads>["uploads"];
  /** Finished uploads, in order: what a send carries. */
  ready: ClientAttachment[];
  uploading: boolean;
  addFiles(files: FileList | File[]): void;
  addAttachments(attachments: ClientAttachment[]): void;
  remove(localId: string): void;
  clear(): void;
  dragging: boolean;
  dropHandlers: ReturnType<typeof useFileDrop>["handlers"];
  onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  /** Mod+Shift+V: the next paste stays inline however long it is. */
  onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  /** The last long paste that became a file, while it is still on the row. */
  lastPaste: { fileName: string; text: string } | null;
  /** Takes that file off the row and returns its text, for the field. */
  keepInline(): string | null;
  canScreenshot: boolean;
  captureScreenshot(): Promise<void>;
}

export function useComposerAttachments({ conversationId, enabled }: { conversationId: string | null; enabled: boolean }): ComposerAttachments {
  const { uploads, addFiles: upload, addAttachments: attachStored, remove, clear: clearUploads, readyAttachments, isUploading } = useUploads(conversationId);
  const keepNextInline = React.useRef(false);
  const [lastPaste, setLastPaste] = React.useState<{ fileName: string; text: string } | null>(null);
  const count = React.useRef(0);
  count.current = uploads.length;

  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      if (!enabled) {
        toast.error(UPLOADS_OFF_MESSAGE);
        return;
      }
      const headroom = Math.max(0, MAX_ATTACHMENTS - count.current);
      if (list.length > headroom) toast.error(TOO_MANY_MESSAGE);
      const take = list.slice(0, headroom);
      const plain = take.filter((f) => intakeKind(f) === "upload");
      if (plain.length) upload(plain);
      for (const photo of take.filter((f) => intakeKind(f) === "heic")) {
        void heicToJpeg(photo).then((jpeg) => {
          if (jpeg) upload([jpeg]);
          else toast.error(HEIC_UNSUPPORTED_MESSAGE);
        });
      }
    },
    [enabled, upload],
  );

  const addAttachments = React.useCallback((attachments: ClientAttachment[]) => attachStored(attachments), [attachStored]);

  const { dragging, handlers: dropHandlers } = useFileDrop({ onFiles: addFiles, enabled });

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v") keepNextInline.current = true;
  }, []);

  const onPaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const keepInline = keepNextInline.current;
      keepNextInline.current = false;
      const files = Array.from(event.clipboardData.files);
      if (files.length) {
        event.preventDefault();
        addFiles(files);
        return;
      }
      if (!enabled) return;
      const text = event.clipboardData.getData("text/plain");
      if (!pasteBecomesFile(text, keepInline)) return;
      event.preventDefault();
      const fileName = pastedTextFileName(new Date());
      addFiles([new File([text], fileName, { type: "text/plain" })]);
      setLastPaste({ fileName, text });
    },
    [addFiles, enabled],
  );

  // The paste notice lasts as long as its file is on the row (sent or removed, it goes).
  const pasteRow = lastPaste ? uploads.find((u) => u.fileName === lastPaste.fileName) : undefined;
  const shownPaste = pasteRow ? lastPaste : null;

  const keepInline = React.useCallback(() => {
    if (!lastPaste) return null;
    const row = uploads.find((u) => u.fileName === lastPaste.fileName);
    if (row) remove(row.localId);
    setLastPaste(null);
    return lastPaste.text;
  }, [lastPaste, remove, uploads]);

  const clear = React.useCallback(() => {
    clearUploads();
    setLastPaste(null);
  }, [clearUploads]);

  // Resolved after mount, so the server render and the first paint agree.
  const [canScreenshot, setCanScreenshot] = React.useState(false);
  React.useEffect(() => {
    setCanScreenshot(typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function");
  }, []);

  // The chat composer's capture: getDisplayMedia → <video> → <canvas>.
  const captureScreenshot = React.useCallback(async () => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const frame = document.createElement("canvas");
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext("2d")?.drawImage(video, 0, 0);
      video.pause();
      video.srcObject = null;
      const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, "image/png"));
      if (!blob) return;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      addFiles([new File([blob], `Screenshot ${stamp}.png`, { type: "image/png" })]);
    } catch (error) {
      // Cancelling the picker is a decision, not a failure.
      if ((error as DOMException)?.name !== "NotAllowedError") toast.error(SCREENSHOT_FAILED_MESSAGE);
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  }, [addFiles]);

  return {
    enabled,
    uploads,
    ready: readyAttachments,
    uploading: isUploading,
    addFiles,
    addAttachments,
    remove,
    clear,
    dragging,
    dropHandlers,
    onPaste,
    onKeyDown,
    lastPaste: shownPaste,
    keepInline,
    canScreenshot,
    captureScreenshot,
  };
}
