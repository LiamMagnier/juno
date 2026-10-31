import type { ClientAttachment } from "@/types/chat";

/*
 * ATTACH FROM A CLOUD DRIVE: the vocabulary the composer's picker and the two
 * routes under /api/connectors/[id]/files share. Client-safe on purpose (no
 * tokens, no fetches), so the picker draws exactly the rows the server serves.
 *
 * The drives are the first-party connectors that already hold a read scope on
 * the person's files (src/lib/first-party-connectors/providers.ts): Google
 * Drive (`drive.readonly`) and Microsoft 365 (`Files.Read.All`, which is
 * OneDrive). No new OAuth app, no new scope, no new stored secret: a file is
 * fetched with the token the person already granted, server-side, and the
 * token never reaches the browser or a model.
 */

export const CLOUD_FILE_PROVIDERS = ["google-drive", "microsoft-365"] as const;
export type CloudFileProvider = (typeof CLOUD_FILE_PROVIDERS)[number];

export function isCloudFileProvider(id: string): id is CloudFileProvider {
  return (CLOUD_FILE_PROVIDERS as readonly string[]).includes(id);
}

/**
 * The drive's own name, as the + menu and the picker say it. Microsoft 365 is
 * the connector; the files it reaches here are the person's OneDrive.
 */
export const CLOUD_FILE_SOURCE_LABEL: Record<CloudFileProvider, string> = {
  "google-drive": "Google Drive",
  "microsoft-365": "OneDrive",
};

/**
 * The most one import may weigh, whatever the plan allows an upload.
 *
 * Two reasons, both about the server rather than the person. A OneDrive file
 * arrives through Graph's short-lived download URL, which is fetched with the
 * shared SSRF-safe client, and that client stops reading at 32 MB
 * (`MAX_MCP_RESPONSE_BYTES`). And an import is buffered whole before it is
 * sniffed and stored, inside a route with a minute to finish ten of them. A
 * bigger file is still one download and one upload away, and the refusal says
 * so instead of failing halfway.
 */
export const CLOUD_IMPORT_CEILING_MB = 32;

/** One row of the picker. */
export interface CloudFileSummary {
  /** The drive's own id for the file. */
  id: string;
  /** OneDrive: the drive that holds it when it is not the person's own (shared, recent). Google: null. */
  driveId: string | null;
  /** The name the drive shows. */
  name: string;
  /** The name the attachment will carry: a Google Doc gains the extension of the format it is exported as. */
  attachName: string;
  /** The type the attachment arrives as, for the row's file mark. */
  attachMime: string;
  /** Bytes, when the drive knows them. Google's own documents have no size until exported. */
  size: number | null;
  /** ISO 8601, when the drive reports it. */
  modifiedAt: string | null;
  /** Why the row cannot be attached ("Folder", "Over 10 MB", …), or null when it can. */
  unavailable: string | null;
}

export interface CloudFileListResponse {
  files: CloudFileSummary[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
  /** The per-file ceiling this account has for an import, in bytes. */
  maxBytes: number;
}

export interface CloudFileRef {
  id: string;
  driveId?: string | null;
}

export interface CloudFileAttachFailure {
  id: string;
  name: string | null;
  error: string;
}

export interface CloudFileAttachResponse {
  /** Ready-to-send attachments, in the order they were picked. */
  attachments: ClientAttachment[];
  /** Picked files that did not make it, each with the sentence that says why. */
  failed: CloudFileAttachFailure[];
}

/** Attachment.origin for a file brought in from a cloud drive. */
export const CLOUD_IMPORT_ORIGIN = "cloud_import";

/**
 * Drive and Graph ids are URL-safe tokens: Google's `[A-Za-z0-9_-]`, Graph's
 * add `!` and `.` (`D4648F06C91D9D3D!54927`, `b!x1…`). Anything else is not an
 * id either service issues, and is refused before it reaches a URL — as is
 * a run of dots, which a URL would read as a path segment ("..").
 */
export const CLOUD_FILE_ID = /^(?!\.+$)[A-Za-z0-9!._-]{1,256}$/;
