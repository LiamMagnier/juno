/*
 * A project's knowledge sources as the page draws them. Client-safe (no
 * tokens, no database), so the knowledge panel and the routes under
 * /api/projects/[id]/sources speak one vocabulary, and the wording of every
 * sync state lives in one place a test can read.
 */

/** A source is synced again when the project is used and its last attempt is older than this. */
export const SOURCE_STALE_MS = 10 * 60_000;

export type SourceState = "pending" | "syncing" | "ready" | "error";
export type SourceErrorCodeView =
  | "not_connected"
  | "reconnect"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "library_full"
  | "capacity"
  | "provider_error";

export interface ProjectSourceView {
  id: string;
  provider: "google-drive";
  kind: "file" | "folder";
  externalId: string;
  name: string;
  includeSubfolders: boolean;
  state: SourceState;
  /** A sync holds the source right now. */
  syncing: boolean;
  errorCode: SourceErrorCodeView | null;
  error: string | null;
  fileCount: number;
  skippedCount: number;
  truncated: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  /** Up to five files the last sync could not add, and why. */
  skipped: Array<{ name: string; error: string }>;
}

export interface DriveAvailability {
  /** Drive sources can be offered on this server (the connector is set up and cloud imports are on). */
  enabled: boolean;
  configured: boolean;
  /** This account has linked Google Drive. */
  connected: boolean;
  /** The Google account it linked, when Drive said. */
  accountLabel: string | null;
}

export interface ProjectSourcesResponse {
  sources: ProjectSourceView[];
  drive: DriveAvailability;
}

/** What the source's row says and offers, from its state. */
export interface SourceStatus {
  tone: "neutral" | "busy" | "attention" | "error";
  /** "24 files · Synced 3 min ago", "Syncing…", the error sentence. */
  text: string;
  /** The one thing that fixes it, when the person can. */
  action: { kind: "reconnect" | "connect" | "retry" | "open-drive"; label: string } | null;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/** "just now", "3 min ago", "2 hr ago", "yesterday", "4 days ago". */
export function syncedAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function describeSource(source: ProjectSourceView, now: number = Date.now()): SourceStatus {
  const files = source.kind === "folder" ? plural(source.fileCount, "file") : null;
  if (source.syncing || source.state === "syncing" || (source.state === "pending" && !source.lastSyncedAt)) {
    return {
      tone: "busy",
      text: source.lastSyncedAt ? `${files ? `${files} · ` : ""}Syncing…` : source.kind === "folder" ? "Reading the folder…" : "Adding the file…",
      action: null,
    };
  }
  if (source.state === "error" && source.errorCode) {
    const code = source.errorCode;
    const action: SourceStatus["action"] =
      code === "reconnect" || code === "forbidden"
        ? { kind: "reconnect", label: "Reconnect Drive" }
        : code === "not_connected"
          ? { kind: "connect", label: "Connect Drive" }
          : code === "not_found"
            ? null
            : code === "capacity" || code === "library_full"
              ? null
              : { kind: "retry", label: "Try again" };
    // Capacity and a full Library are partial: the folder synced, part of it
    // could not be kept. They read as attention, not as a broken source.
    const partial = code === "capacity" || code === "library_full";
    return { tone: partial ? "attention" : "error", text: source.error ?? "Couldn’t sync.", action };
  }
  const parts = [
    ...(files ? [files] : []),
    ...(source.skippedCount > 0 ? [`${source.skippedCount.toLocaleString("en-US")} skipped`] : []),
    source.lastSyncedAt ? `Synced ${syncedAgo(source.lastSyncedAt, now)}` : "Not synced yet",
  ];
  return { tone: source.skippedCount > 0 || source.truncated ? "attention" : "neutral", text: parts.join(" · "), action: null };
}

/** Whether the page should keep polling: something is being read right now. */
export function sourcesBusy(sources: readonly ProjectSourceView[]): boolean {
  return sources.some((source) => source.syncing || source.state === "syncing" || (source.state === "pending" && !source.lastSyncedAt));
}

/** The Drive web address of a source, for "Open in Google Drive". */
export function driveWebUrl(source: Pick<ProjectSourceView, "kind" | "externalId">): string {
  const id = encodeURIComponent(source.externalId);
  return source.kind === "folder" ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view`;
}

/**
 * Where the connect flow may send the person back to: a path on this site, and
 * nothing else. An absolute URL, a protocol-relative `//host` and a backslash
 * (which browsers read as a slash) are all ways off the site, so all refused.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, "https://alevr.invalid");
    if (url.origin !== "https://alevr.invalid" || url.pathname.startsWith("//")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
