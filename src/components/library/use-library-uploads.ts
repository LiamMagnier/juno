"use client";

import * as React from "react";
import { attachmentKind, isAcceptedUpload } from "@/lib/uploads";
import type { ClientAttachment } from "@/types/chat";
import type { LibraryUpload } from "@/components/library/library-types";

/**
 * Uploads started from the Library page.
 *
 * NOT `useUploads`, though it posts to the same `/api/upload` with no
 * conversation, because the two want different things from a failure. The
 * composer's hook raises a toast and leaves a chip the reader removes before
 * sending; here the failed file stays as a row IN the list, saying why, with
 * Retry beside it. A toast on top of that row would say it twice, and a
 * composer chip has no use for Retry because the reader simply attaches again.
 * This hook keeps each `File` for exactly that reason.
 *
 * Checks the server would make anyway (type, the plan's per-file size) run
 * here first, so an unsupported file fails in the row at once instead of
 * after its bytes have crossed the network.
 */

export interface LibraryUploadsOptions {
  /** The plan's per-file ceiling, in bytes. */
  maxBytes: number;
  /** Called once per finished file, with the stored attachment. */
  onUploaded: (attachment: ClientAttachment) => void;
}

let sequence = 0;

/** Server replies turned into one sentence for the row. */
function failureMessage(status: number, body: unknown): string {
  const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
  if (data.code === "LIBRARY_QUOTA_EXCEEDED") return "Your library is full. Delete files to make room.";
  if (status === 429) return "Too many uploads at once. Try again in a few minutes.";
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  return "Upload failed.";
}

export function useLibraryUploads({ maxBytes, onUploaded }: LibraryUploadsOptions) {
  const [uploads, setUploads] = React.useState<LibraryUpload[]>([]);
  // Kept by id for Retry; dropped the moment a row goes away.
  const files = React.useRef(new Map<string, File>());
  const requests = React.useRef(new Map<string, XMLHttpRequest>());
  const previews = React.useRef(new Map<string, string>());
  const onUploadedRef = React.useRef(onUploaded);
  React.useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  const patch = React.useCallback((localId: string, next: Partial<LibraryUpload>) => {
    setUploads((previous) => previous.map((upload) => (upload.localId === localId ? { ...upload, ...next } : upload)));
  }, []);

  const forget = React.useCallback((localId: string) => {
    files.current.delete(localId);
    requests.current.delete(localId);
    const preview = previews.current.get(localId);
    if (preview) URL.revokeObjectURL(preview);
    previews.current.delete(localId);
    setUploads((previous) => previous.filter((upload) => upload.localId !== localId));
  }, []);

  const send = React.useCallback(
    (localId: string, file: File) => {
      const xhr = new XMLHttpRequest();
      requests.current.set(localId, xhr);
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          patch(localId, { progress: Math.min(100, Math.round((event.loaded / event.total) * 100)) });
        }
      };
      xhr.onload = () => {
        requests.current.delete(localId);
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // A proxy's HTML error page; the status alone decides below.
        }
        const attachment = (body as { attachment?: ClientAttachment } | null)?.attachment;
        if (xhr.status >= 200 && xhr.status < 300 && attachment?.id) {
          // The finished row replaces this one in the same frame, so the file
          // never appears twice and never disappears between the two.
          forget(localId);
          onUploadedRef.current(attachment);
          return;
        }
        // A refused type or an over-size file fails the same way every time. A
        // full library is also a 413, but the row tells the reader to make
        // room, and once they have, trying again is exactly what works.
        const libraryFull = (body as { code?: unknown } | null)?.code === "LIBRARY_QUOTA_EXCEEDED";
        patch(localId, {
          status: "failed",
          error: failureMessage(xhr.status, body),
          retryable: libraryFull || (xhr.status !== 413 && xhr.status !== 415),
        });
      };
      xhr.onerror = () => {
        requests.current.delete(localId);
        patch(localId, { status: "failed", error: "Couldn’t reach Juno. Check your connection.", retryable: true });
      };
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    },
    [forget, patch],
  );

  const add = React.useCallback(
    (list: FileList | File[]) => {
      const incoming = Array.from(list);
      if (incoming.length === 0) return;
      const rows: LibraryUpload[] = [];
      const toSend: [string, File][] = [];
      for (const file of incoming) {
        const localId = `library-upload-${Date.now()}-${sequence++}`;
        const kind = attachmentKind(file.type);
        const previewUrl = kind === "IMAGE" ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previews.current.set(localId, previewUrl);
        const base = { localId, fileName: file.name || "Untitled", size: file.size, kind, progress: 0, previewUrl };
        if (!isAcceptedUpload(file.name || "file", file.type || "application/octet-stream")) {
          rows.push({ ...base, status: "failed", error: "Juno can’t store this type of file.", retryable: false });
        } else if (file.size > maxBytes) {
          rows.push({ ...base, status: "failed", error: "This file is larger than your plan allows.", retryable: false });
        } else {
          files.current.set(localId, file);
          rows.push({ ...base, status: "uploading" });
          toSend.push([localId, file]);
        }
      }
      // Newest first, the same order the list itself runs in.
      setUploads((previous) => [...rows.reverse(), ...previous]);
      for (const [localId, file] of toSend) send(localId, file);
    },
    [maxBytes, send],
  );

  const retry = React.useCallback(
    (localId: string) => {
      const file = files.current.get(localId);
      if (!file) return;
      patch(localId, { status: "uploading", progress: 0, error: undefined });
      send(localId, file);
    },
    [patch, send],
  );

  /** Cancel an upload in flight, or clear a failed one. */
  const dismiss = React.useCallback(
    (localId: string) => {
      requests.current.get(localId)?.abort();
      forget(localId);
    },
    [forget],
  );

  // An upload in flight is left to finish when the page is left: the file
  // lands in the library either way, and aborting would throw away bytes the
  // reader asked to keep. Only the thumbnails' object URLs are released.
  React.useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  return { uploads, add, retry, dismiss };
}
