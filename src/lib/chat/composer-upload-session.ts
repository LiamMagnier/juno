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

/**
 * Upload work belongs to the conversation's in-memory draft session, not to a
 * particular Composer mount. The landing field and docked field swap during
 * first send, while XHR callbacks from the old field can still fire.
 *
 * No module-level uploads or persistence: conversation/privacy scope changes
 * create separate stores, and private content never enters browser storage.
 */
export function createComposerUploadSession() {
  let uploads: PendingUpload[] = [];
  const listeners = new Set<() => void>();

  const updateUploads = (change: (current: PendingUpload[]) => PendingUpload[]) => {
    const next = change(uploads);
    if (next === uploads) return;
    uploads = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => uploads,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    updateUploads,
    add(upload: PendingUpload) {
      updateUploads((prev) => [...prev, upload]);
    },
    update(localId: string, patch: Partial<PendingUpload>) {
      updateUploads((prev) => prev.some((upload) => upload.localId === localId)
        ? prev.map((upload) => upload.localId === localId ? { ...upload, ...patch } : upload)
        : prev);
    },
    remove(localId: string) {
      updateUploads((prev) => prev.some((upload) => upload.localId === localId)
        ? prev.filter((upload) => upload.localId !== localId)
        : prev);
    },
    clear() {
      updateUploads((prev) => prev.length ? [] : prev);
    },
  };
}

export type ComposerUploadSession = ReturnType<typeof createComposerUploadSession>;
