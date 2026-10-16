/*
 * The canvas draft, client half (G12: never lose canvas edits).
 *
 * The server keeps the person's unsaved Code-tab edit (ArtifactCanvasDraft,
 * src/lib/artifact-canvas-draft.ts); this file holds what the browser decides
 * on its own: the device copy written before any request goes out, which of
 * two copies to offer back, and the words for where the edit is kept.
 *
 * THE DEVICE COPY IS THE FIRST WRITE. A request can be slow, offline or
 * refused; `localStorage` answers synchronously, so a reload or a crash in the
 * second between a keystroke and the autosave still finds the edit. It is kept
 * for a week (the server's copy for thirty days), is cleared the moment the
 * edit is saved as a version or discarded, is keyed by artifact id (an id only
 * its owner can open), and is never written for an incognito canvas. Storage
 * can be missing, full or blocked: every access is guarded and the canvas
 * works without it, saying where the edit actually is.
 *
 * Pure apart from the `Storage` it is handed, so node tests drive it.
 */

export const CANVAS_DRAFT_STORAGE_PREFIX = "alevr:canvas-draft:v1:";

/** How long the device copy is offered back. The server keeps its copy longer. */
export const LOCAL_CANVAS_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long after the last keystroke the edit is sent to the server. */
export const CANVAS_DRAFT_SERVER_DEBOUNCE_MS = 1200;

/** How long after the last keystroke the device copy is written. */
export const CANVAS_DRAFT_LOCAL_DEBOUNCE_MS = 250;

/**
 * The largest body a keepalive request can carry as the page goes away
 * (browsers cap the in-flight keepalive budget at 64 KiB). Bigger edits rely
 * on the device copy, which is written synchronously on the way out.
 */
export const KEEPALIVE_BODY_LIMIT = 60_000;

export interface CanvasDraftCopy {
  content: string;
  /** The version the edit started from. */
  baseVersion: number;
  /** ISO time of the last write. */
  updatedAt: string;
}

export function canvasDraftStorageKey(artifactId: string): string {
  return `${CANVAS_DRAFT_STORAGE_PREFIX}${artifactId}`;
}

function isCopy(value: unknown): value is CanvasDraftCopy {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === "string" &&
    typeof v.baseVersion === "number" &&
    Number.isInteger(v.baseVersion) &&
    v.baseVersion > 0 &&
    typeof v.updatedAt === "string" &&
    Number.isFinite(Date.parse(v.updatedAt))
  );
}

/** The browser's `localStorage`, or null where it cannot be reached. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The device copy, or null (none, unreadable, or older than the TTL — which is then removed). */
export function readLocalCanvasDraft(storage: Storage | null, artifactId: string, now: number = Date.now()): CanvasDraftCopy | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(canvasDraftStorageKey(artifactId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCopy(parsed) || now - Date.parse(parsed.updatedAt) > LOCAL_CANVAS_DRAFT_TTL_MS) {
      storage.removeItem(canvasDraftStorageKey(artifactId));
      return null;
    }
    return parsed;
  } catch {
    try {
      storage.removeItem(canvasDraftStorageKey(artifactId));
    } catch {
      /* Blocked storage has nothing to clear. */
    }
    return null;
  }
}

/** Every device copy's key, with its last write time (0 when unreadable). */
function localCanvasDraftEntries(storage: Storage): Array<{ key: string; at: number }> {
  const entries: Array<{ key: string; at: number }> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(CANVAS_DRAFT_STORAGE_PREFIX)) continue;
    let at = 0;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) ?? "");
      if (isCopy(parsed)) at = Date.parse(parsed.updatedAt);
    } catch {
      /* Unreadable: oldest of all. */
    }
    entries.push({ key, at });
  }
  return entries;
}

/**
 * Drops device copies past the TTL (or unreadable) for every artifact, not only
 * the one being opened: a copy is otherwise removed only when its own artifact
 * opens again, and copies of artifacts never reopened would pile up in the
 * origin's shared storage quota, which the rest of the app writes to as well.
 */
export function pruneLocalCanvasDrafts(storage: Storage | null, now: number = Date.now()): void {
  if (!storage) return;
  try {
    for (const { key, at } of localCanvasDraftEntries(storage)) {
      if (!at || now - at > LOCAL_CANVAS_DRAFT_TTL_MS) storage.removeItem(key);
    }
  } catch {
    /* Blocked storage has nothing to prune. */
  }
}

/** Every device copy, gone: signing out leaves no artifact source behind in this browser. */
export function clearAllLocalCanvasDrafts(storage: Storage | null): void {
  if (!storage) return;
  try {
    for (const { key } of localCanvasDraftEntries(storage)) storage.removeItem(key);
  } catch {
    /* Blocked storage has nothing to clear. */
  }
}

/**
 * Writes the device copy. False when storage is missing, full or blocked.
 *
 * A full quota first gives up older copies of OTHER artifacts (oldest first;
 * their server copies remain), so the edit being typed now wins the space.
 */
export function writeLocalCanvasDraft(storage: Storage | null, artifactId: string, copy: CanvasDraftCopy): boolean {
  if (!storage) return false;
  const key = canvasDraftStorageKey(artifactId);
  const value = JSON.stringify(copy);
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    /* Full or blocked: make room below, then try once more per copy given up. */
  }
  try {
    const others = localCanvasDraftEntries(storage)
      .filter((entry) => entry.key !== key)
      .sort((a, b) => a.at - b.at);
    for (const entry of others) {
      storage.removeItem(entry.key);
      try {
        storage.setItem(key, value);
        return true;
      } catch {
        /* Still full: give up the next oldest. */
      }
    }
  } catch {
    /* Blocked storage. */
  }
  return false;
}

export function clearLocalCanvasDraft(storage: Storage | null, artifactId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(canvasDraftStorageKey(artifactId));
  } catch {
    /* Blocked storage has nothing to clear. */
  }
}

/** Reads a server answer's `draft` defensively: anything malformed is no draft. */
export function parseServerCanvasDraft(body: unknown): CanvasDraftCopy | null {
  if (!body || typeof body !== "object") return null;
  const draft = (body as { draft?: unknown }).draft;
  return isCopy(draft) ? draft : null;
}

export interface CanvasDraftOffer extends CanvasDraftCopy {
  /** The head moved past the version the edit started from. */
  stale: boolean;
}

/**
 * Which unsaved edit to offer back when the artifact opens, if any.
 *
 * The newer of the two copies wins (the device copy can be ahead of a
 * request that never landed; the server's can be ahead when the edit was
 * made on another device). An edit identical to the current version is
 * nothing to restore. A copy whose base is past the head is from a version
 * this client has not seen yet and is not offered (it cannot be judged).
 */
export function canvasDraftOffer(input: {
  local: CanvasDraftCopy | null;
  server: CanvasDraftCopy | null;
  headContent: string;
  currentVersion: number;
}): CanvasDraftOffer | null {
  const { local, server } = input;
  const pick = local && server ? (Date.parse(local.updatedAt) >= Date.parse(server.updatedAt) ? local : server) : local ?? server;
  if (!pick) return null;
  if (pick.baseVersion > input.currentVersion) return null;
  if (pick.content === input.headContent) return null;
  return { ...pick, stale: pick.baseVersion < input.currentVersion };
}

/**
 * Where the unsaved edit is kept right now.
 *
 *   - `pending`: typed, not yet written anywhere but this tab's memory;
 *   - `saving`: on this device, on its way to the server;
 *   - `saved`: the server has it (and so does this device);
 *   - `device`: only this device has it (the server refused or is unreachable);
 *   - `unsaved`: nowhere but this tab — storage is blocked and the server
 *     refused or is unreachable. The one state that asks for the reader.
 */
export type CanvasDraftSync = "pending" | "saving" | "saved" | "device" | "unsaved";

/** Next sync state after the device write, given whether the server write follows. */
export function syncAfterLocalWrite(wroteLocally: boolean, serverQueued: boolean): CanvasDraftSync {
  if (serverQueued) return wroteLocally ? "saving" : "pending";
  return wroteLocally ? "device" : "unsaved";
}

/** Next sync state once the server answered. */
export function syncAfterServerWrite(serverOk: boolean, wroteLocally: boolean): CanvasDraftSync {
  if (serverOk) return "saved";
  return wroteLocally ? "device" : "unsaved";
}

/** True when leaving the page now could lose the edit, so the browser should ask first. */
export function draftAtRisk(sync: CanvasDraftSync | null): boolean {
  return sync === "pending" || sync === "unsaved";
}

/** The words the canvas shows for each state, in plain sentence case. */
export const CANVAS_DRAFT_COPY = {
  saving: "Saving draft",
  saved: "Draft saved",
  device: "Draft saved on this device",
  unsaved: "Draft not saved",
  headerLabel: "Draft",
  restoreTitle: "Unsaved draft",
  restoreStale: "Started before the latest version",
  restore: "Restore draft",
  discard: "Discard",
  restoredToast: "Draft restored. Save it as a version when you’re ready.",
  restoredToastIncognito: "Draft restored.",
  discardedToast: "Draft discarded.",
  closeTitle: "Keep your edits?",
  closeBody: "Your changes aren’t a version yet.",
  closeBodyKept: "They’re saved as a draft, and you can pick them up next time you open this.",
  closeBodyIncognito: "Nothing in this chat is saved, so closing loses them.",
  saveVersion: "Save version",
  keepDraft: "Keep draft",
  discardEdits: "Discard edits",
  keepEditing: "Keep editing",
  justNow: "just now",
} as const;

/**
 * The words for a sync state. Typing and the write in flight read the same
 * ("Saving draft", as a document editor says it) rather than flickering
 * through three labels a keystroke; only "not saved" asks for attention.
 */
export function draftSyncWords(sync: CanvasDraftSync): { text: string; attention: boolean } {
  switch (sync) {
    case "pending":
    case "saving":
      return { text: CANVAS_DRAFT_COPY.saving, attention: false };
    case "saved":
      return { text: CANVAS_DRAFT_COPY.saved, attention: false };
    case "device":
      return { text: CANVAS_DRAFT_COPY.device, attention: false };
    case "unsaved":
      return { text: CANVAS_DRAFT_COPY.unsaved, attention: true };
  }
}

/**
 * "3 minutes ago", "yesterday", in the reader's locale (Intl does the words).
 * Under a minute is "just now".
 */
export function relativeDraftAge(updatedAt: string, now: number, locale: string): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 60) return CANVAS_DRAFT_COPY.justNow;
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  const days = Math.round(hours / 24);
  return format.format(days, "day");
}
