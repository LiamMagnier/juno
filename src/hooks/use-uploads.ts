"use client";

import * as React from "react";
import { toast } from "sonner";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import type { ClientAttachment } from "@/types/chat";

export interface PendingUpload {
  localId: string;
  fileName: string;
  size: number;
  progress: number; // 0..100
  status: "uploading" | "done" | "error";
  attachment?: ClientAttachment;
  error?: string;
}

let counter = 0;

export function useUploads(conversationId: string | null) {
  const [uploads, setUploads] = React.useState<PendingUpload[]>([]);

  const update = (localId: string, patch: Partial<PendingUpload>) =>
    setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));

  const uploadOne = React.useCallback(
    (file: File, conversationIdValue: string | null) => {
      const localId = `up-${Date.now()}-${counter++}`;
      setUploads((prev) => [
        ...prev,
        { localId, fileName: file.name, size: file.size, progress: 0, status: "uploading" },
      ]);

      const form = new FormData();
      form.append("file", file);
      if (conversationIdValue) form.append("conversationId", conversationIdValue);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) update(localId, { progress: Math.round((e.loaded / e.total) * 95) });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            update(localId, { status: "done", progress: 100, attachment: data.attachment });
          } catch {
            update(localId, { status: "error", error: "Upload failed." });
          }
        } else {
          let msg = "Upload failed.";
          try {
            msg = JSON.parse(xhr.responseText).error ?? msg;
          } catch {
            /* ignore */
          }
          update(localId, { status: "error", error: msg });
          toast.error(msg);
        }
      };
      xhr.onerror = () => {
        update(localId, { status: "error", error: "Upload failed." });
        toast.error("Upload failed. Check your connection.");
      };
      xhr.send(form);
    },
    []
  );

  const addFiles = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      for (const f of list) uploadOne(f, conversationId);
    },
    [uploadOne, conversationId]
  );

  // Add already-stored attachments (e.g. cloned from the Library) as ready-to-send
  // chips — no upload needed, they already have a server-side id. Capped at
  // MAX_ATTACHMENTS so a send can never exceed the server's per-message limit.
  const addAttachments = React.useCallback((attachments: ClientAttachment[]) => {
    if (attachments.length === 0) return;
    setUploads((prev) => {
      const existing = new Set(prev.map((u) => u.attachment?.id).filter(Boolean));
      const headroom = Math.max(0, MAX_ATTACHMENTS - prev.length);
      const fresh = attachments.filter((a) => !existing.has(a.id));
      const next = fresh.slice(0, headroom).map((a) => ({
        localId: `lib-${a.id}-${counter++}`,
        fileName: a.fileName,
        size: a.size,
        progress: 100,
        status: "done" as const,
        attachment: a,
      }));
      if (fresh.length > next.length) {
        toast.error(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, []);

  const remove = React.useCallback((localId: string) => {
    setUploads((prev) => prev.filter((u) => u.localId !== localId));
  }, []);

  const clear = React.useCallback(() => setUploads([]), []);

  const readyAttachments = React.useMemo(
    () => uploads.filter((u) => u.status === "done" && u.attachment).map((u) => u.attachment!),
    [uploads]
  );
  const isUploading = uploads.some((u) => u.status === "uploading");

  return { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading };
}
