import { ConnectorApiError, type FirstPartyClient } from "@/lib/first-party-connectors/client";
import { CloudFileError, driveQueryLiteral, resolveGoogleFile, summarizeCloudFile, type GoogleFileMeta } from "@/lib/cloud-files/drives";
import { CLOUD_FILE_ID } from "@/lib/cloud-files/shared";
import { estimateKnowledgeTokens } from "./knowledge-capacity";

/*
 * A GOOGLE DRIVE FOLDER (OR FILE) AS PROJECT KNOWLEDGE.
 *
 * A project source mirrors what Drive holds into project attachments, which is
 * all a chat in the project ever reads: an attachment with `projectId` is
 * indexed for retrieval and listed in the project's reference files
 * (lib/chat/turn/project-context.ts). So "keeping a folder in sync" is three
 * questions asked of Drive on every sync, and this module is the answers:
 *
 *   1. What is in the folder now? `listDriveFolderTree` walks it, and its
 *      subfolders when asked, with every page of every listing read and a
 *      ceiling on how much one source may hold.
 *   2. What changed since the last sync? `planSourceSync` compares that
 *      listing with the files the source already mirrors, by Drive's own id
 *      and its `version` (which Drive bumps on every change to the file).
 *   3. What does the project do about it? `runSourceSync` adds the new files,
 *      re-imports the changed ones and removes the ones that left, through a
 *      port the database half implements (drive-source-store.ts) and a test
 *      can implement in memory.
 *
 * Every Drive request goes through `FirstPartyClient`, the adapter the Drive
 * tools and the composer's Drive picker already use: one origin, one API
 * prefix, the owner's own token, never a redirect followed with it. Nothing
 * here holds a token or decides whether a file is safe to store; the bytes go
 * through the same upload gate an upload does (the store's `importFile`).
 */

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/**
 * How much one source may hold. A folder is a person's own filing and can be
 * any size; a sync has a minute of a request's time and the project has a
 * knowledge capacity. Past these the listing stops and the source says so
 * (`truncated`) rather than silently mirroring a part of it.
 */
export const SOURCE_LIMITS = {
  maxFiles: 300,
  maxFolders: 100,
  maxDepth: 8,
} as const;

export type SourceLimits = { maxFiles: number; maxFolders: number; maxDepth: number };

/** One Drive file a listing found, where it sits, and the marker that changes when it does. */
export interface DriveListedFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, when Drive knows them (its own Docs have none until exported). */
  size: number | null;
  modifiedTime: string | null;
  /** "Specs/2026" under the source's folder; "" at its top. */
  path: string;
  /** Drive's `version`, else its checksum, else its modified time. */
  version: string;
}

export interface DriveFolderListing {
  files: DriveListedFile[];
  /** Folders read, the source's own included. */
  folders: number;
  /** The listing stopped at a ceiling in SOURCE_LIMITS. */
  truncated: boolean;
}

interface DriveListedEntry extends GoogleFileMeta {
  version?: string;
  md5Checksum?: string;
  trashed?: boolean;
}

const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,version,md5Checksum)";
const enc = encodeURIComponent;

function query(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return `${path}?${search}`;
}

function byteCount(value: string | number | undefined): number | null {
  const size = typeof value === "string" ? Number(value) : value;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

/** The marker a later sync compares: Drive bumps `version` on every change to the file. */
export function driveVersionOf(entry: { version?: string; md5Checksum?: string; modifiedTime?: string }): string {
  return entry.version || entry.md5Checksum || entry.modifiedTime || "0";
}

/** The source's own metadata: its name, and whether it is a folder at all. */
export interface DriveTarget {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  trashed: boolean;
  file: DriveListedFile;
}

export async function readDriveTarget(client: FirstPartyClient, id: string): Promise<DriveTarget> {
  if (!CLOUD_FILE_ID.test(id)) throw new CloudFileError("invalid_request", 400, "That Drive item isn’t valid.");
  const meta = await client.json<DriveListedEntry>(
    query(`/drive/v3/files/${enc(id)}`, {
      fields: "id,name,mimeType,size,modifiedTime,version,md5Checksum,trashed",
      supportsAllDrives: "true",
    }),
  );
  const name = meta.name?.trim() || "Untitled";
  const mimeType = meta.mimeType ?? "application/octet-stream";
  return {
    id,
    name,
    mimeType,
    isFolder: mimeType === DRIVE_FOLDER_MIME,
    trashed: meta.trashed === true,
    file: {
      id,
      name,
      mimeType,
      size: byteCount(meta.size),
      modifiedTime: meta.modifiedTime ?? null,
      path: "",
      version: driveVersionOf(meta),
    },
  };
}

/**
 * Every file under `folderId`, breadth first, every page of every listing.
 * Subfolders are walked only with `includeSubfolders`; shortcuts are not
 * followed (one points anywhere in Drive, including back up the tree).
 */
export async function listDriveFolderTree(
  client: FirstPartyClient,
  folderId: string,
  options: { includeSubfolders: boolean; limits?: SourceLimits },
): Promise<DriveFolderListing> {
  const limits = options.limits ?? SOURCE_LIMITS;
  const files: DriveListedFile[] = [];
  const queue: Array<{ id: string; path: string; depth: number }> = [{ id: folderId, path: "", depth: 0 }];
  const seen = new Set<string>([folderId]);
  let folders = 0;
  let truncated = false;

  while (queue.length > 0) {
    const folder = queue.shift()!;
    folders += 1;
    let pageToken: string | undefined;
    do {
      const page = await client.json<{ files?: DriveListedEntry[]; nextPageToken?: string }>(
        query("/drive/v3/files", {
          q: `${driveQueryLiteral(folder.id)} in parents and trashed = false`,
          pageSize: 200,
          pageToken,
          orderBy: "folder,name",
          fields: LIST_FIELDS,
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        }),
      );
      for (const entry of page.files ?? []) {
        if (typeof entry.id !== "string" || !CLOUD_FILE_ID.test(entry.id)) continue;
        const name = entry.name?.trim() || "Untitled";
        const mimeType = entry.mimeType ?? "application/octet-stream";
        if (mimeType === DRIVE_SHORTCUT_MIME) continue;
        if (mimeType === DRIVE_FOLDER_MIME) {
          if (!options.includeSubfolders || seen.has(entry.id)) continue;
          if (folder.depth + 1 > limits.maxDepth || folders + queue.length >= limits.maxFolders) {
            truncated = true;
            continue;
          }
          seen.add(entry.id);
          queue.push({ id: entry.id, path: folder.path ? `${folder.path}/${name}` : name, depth: folder.depth + 1 });
          continue;
        }
        if (files.length >= limits.maxFiles) {
          truncated = true;
          continue;
        }
        files.push({
          id: entry.id,
          name,
          mimeType,
          size: byteCount(entry.size),
          modifiedTime: entry.modifiedTime ?? null,
          path: folder.path,
          version: driveVersionOf(entry),
        });
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
  }
  return { files, folders, truncated };
}

/* ─────────────────────────────── The picker ─────────────────────────────── */

export interface DriveBrowseEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  mimeType: string;
  /** The type it arrives as (a Google Doc as .docx), for the row's file mark. */
  iconMime: string;
  modifiedAt: string | null;
  size: number | null;
  /** Why a file cannot become knowledge ("Can’t attach this type"), or null. */
  unavailable: string | null;
}

export interface DriveBrowsePage {
  entries: DriveBrowseEntry[];
  nextCursor: string | null;
}

export type DriveBrowseInput =
  | { view: "folder"; parent: string; cursor?: string | null }
  | { view: "shared"; cursor?: string | null }
  | { view: "search"; query: string; cursor?: string | null };

/**
 * One page of the "Add from Google Drive" picker: a folder's contents (My
 * Drive is the folder "root"), what was shared with the person, or a search.
 * Folders come first and are offered whole; files carry the same "can't be
 * added" note the composer's Drive picker draws, from the same resolver.
 */
export async function browseDrive(client: FirstPartyClient, input: DriveBrowseInput, maxBytes: number): Promise<DriveBrowsePage> {
  const clauses = ["trashed = false", `mimeType != ${driveQueryLiteral(DRIVE_SHORTCUT_MIME)}`];
  if (input.view === "folder") {
    if (input.parent !== "root" && !CLOUD_FILE_ID.test(input.parent)) {
      throw new CloudFileError("invalid_request", 400, "That folder isn’t valid.");
    }
    clauses.unshift(`${driveQueryLiteral(input.parent)} in parents`);
  } else if (input.view === "shared") {
    clauses.unshift("sharedWithMe = true");
  } else {
    const text = input.query.trim();
    if (text) clauses.unshift(`name contains ${driveQueryLiteral(text)}`);
  }
  const data = await client.json<{ files?: DriveListedEntry[]; nextPageToken?: string }>(
    query("/drive/v3/files", {
      q: clauses.join(" and "),
      pageSize: 50,
      pageToken: input.cursor ?? undefined,
      orderBy: input.view === "search" ? "folder,modifiedTime desc" : "folder,name",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    }),
  );
  const entries: DriveBrowseEntry[] = [];
  for (const file of data.files ?? []) {
    if (typeof file.id !== "string" || !CLOUD_FILE_ID.test(file.id)) continue;
    const mimeType = file.mimeType ?? "application/octet-stream";
    if (mimeType === DRIVE_FOLDER_MIME) {
      entries.push({ id: file.id, name: file.name?.trim() || "Untitled folder", kind: "folder", mimeType, iconMime: mimeType, modifiedAt: file.modifiedTime ?? null, size: null, unavailable: null });
      continue;
    }
    const summary = summarizeCloudFile(
      { id: file.id, driveId: null },
      resolveGoogleFile(file),
      { mimeType, modifiedAt: file.modifiedTime ?? null, size: byteCount(file.size) },
      maxBytes,
    );
    entries.push({ id: file.id, name: summary.name, kind: "file", mimeType, iconMime: summary.attachMime, modifiedAt: summary.modifiedAt, size: summary.size, unavailable: summary.unavailable });
  }
  return { entries, nextCursor: data.nextPageToken ?? null };
}

/* ─────────────────────────────── The plan ─────────────────────────────── */

/** A file a source already mirrors, as the store keeps it. */
export interface SourceItemRecord {
  id: string;
  externalId: string;
  version: string;
  attachmentId: string | null;
  state: "synced" | "skipped";
  name: string;
  path: string;
}

export interface SourceSyncPlan {
  add: DriveListedFile[];
  update: Array<{ item: SourceItemRecord; file: DriveListedFile }>;
  remove: SourceItemRecord[];
  /** Unchanged since the last sync, but renamed or moved inside the folder. */
  relabel: Array<{ item: SourceItemRecord; file: DriveListedFile }>;
  unchanged: number;
}

/**
 * What a sync does, from what the source mirrors and what Drive holds now.
 * Matched by Drive's own id, so a file renamed or moved inside the folder is
 * the same file; changed when its version differs; gone when the listing no
 * longer has it (deleted, trashed, or moved out of the folder).
 */
export function planSourceSync(existing: readonly SourceItemRecord[], remote: readonly DriveListedFile[]): SourceSyncPlan {
  const byId = new Map(existing.map((item) => [item.externalId, item]));
  const plan: SourceSyncPlan = { add: [], update: [], remove: [], relabel: [], unchanged: 0 };
  const present = new Set<string>();
  for (const file of remote) {
    if (present.has(file.id)) continue;
    present.add(file.id);
    const item = byId.get(file.id);
    if (!item) plan.add.push(file);
    else if (item.version !== file.version) plan.update.push({ item, file });
    else if (item.name !== file.name || item.path !== file.path) plan.relabel.push({ item, file });
    else plan.unchanged += 1;
  }
  for (const item of existing) if (!present.has(item.externalId)) plan.remove.push(item);
  return plan;
}

/* ─────────────────────────────── Errors ─────────────────────────────── */

export type SourceErrorCode =
  | "not_connected"
  | "reconnect"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "library_full"
  | "capacity"
  | "provider_error";

export class SourceSyncError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceSyncError";
  }
}

/** The sentence the project page shows for each way a sync stops. */
export function sourceErrorMessage(code: SourceErrorCode, name: string): string {
  const subject = `“${name}”`;
  switch (code) {
    case "not_connected":
      return `Connect Google Drive to keep ${subject} in sync.`;
    case "reconnect":
      return `Google Drive needs to be reconnected before ${subject} can sync again.`;
    case "forbidden":
      return `This Google account can’t open ${subject} any more. Ask its owner to share it with you, or reconnect Drive with an account that can.`;
    case "not_found":
      return `${subject} is no longer in Google Drive. It may have been deleted or moved to the trash.`;
    case "rate_limited":
      return "Google Drive is busy. The next sync will try again.";
    case "library_full":
      return "Your Library is full, so new files from this source weren’t added.";
    case "capacity":
      return "This project’s knowledge is full, so some files weren’t added. Remove files or sources to make room.";
    default:
      return `Couldn’t reach Google Drive to sync ${subject}. The next sync will try again.`;
  }
}

/** A Drive refusal of the source itself (its listing or its metadata), as a sync error. */
export function classifyDriveFailure(error: unknown, name: string): SourceSyncError {
  if (error instanceof SourceSyncError) return error;
  let code: SourceErrorCode = "provider_error";
  if (error instanceof ConnectorApiError) {
    if (error.status === 401) code = "reconnect";
    else if (error.status === 403) code = "forbidden";
    else if (error.status === 404) code = "not_found";
    else if (error.status === 429) code = "rate_limited";
  } else if (error instanceof CloudFileError) {
    if (error.code === "connector_reconnect") code = "reconnect";
    else if (error.code === "forbidden") code = "forbidden";
    else if (error.code === "not_found") code = "not_found";
    else if (error.code === "rate_limited") code = "rate_limited";
  }
  return new SourceSyncError(code, sourceErrorMessage(code, name));
}

/** A file-level refusal that ends the whole sync rather than skipping one file. */
function isSourceWide(error: unknown): boolean {
  if (error instanceof ConnectorApiError) return error.status === 401 || error.status === 429;
  if (error instanceof CloudFileError) return error.code === "connector_reconnect" || error.code === "rate_limited";
  return error instanceof SourceSyncError;
}

/* ─────────────────────────────── The run ─────────────────────────────── */

export interface ImportedFile {
  attachmentId: string;
  /** Bytes stored, for the capacity estimate. */
  bytes: number;
  mimeType: string;
}

/**
 * The database half of a sync, as the runner needs it. drive-source-store.ts
 * implements it with Prisma and the upload pipeline; the tests implement it in
 * memory.
 */
export interface SourceSyncPort {
  items(): Promise<SourceItemRecord[]>;
  /** Fetch one Drive file and store it as a project attachment. Throws a CloudFileError for a file it can't add. */
  importFile(file: DriveListedFile): Promise<ImportedFile>;
  /** Insert or update the item for `file`, by its Drive id. */
  saveItem(file: DriveListedFile, outcome: { attachmentId: string | null; state: "synced" | "skipped"; error: string | null }): Promise<void>;
  /** The item and its attachment leave the project (the attachment is tombstoned, its index redacted). */
  removeItem(item: SourceItemRecord): Promise<void>;
  /** An attachment replaced by a newer import leaves the project. */
  removeAttachment(attachmentId: string): Promise<void>;
  /** Rename or move an unchanged item without re-importing it. */
  relabelItem(item: SourceItemRecord, file: DriveListedFile): Promise<void>;
}

export interface SourceSyncInput {
  client: FirstPartyClient;
  source: { kind: "file" | "folder"; externalId: string; name: string; includeSubfolders: boolean };
  port: SourceSyncPort;
  /** Knowledge tokens the project can still take before this sync adds anything. */
  remainingTokens: number;
  limits?: SourceLimits;
}

export interface SourceSyncResult {
  state: "ready" | "error";
  errorCode: SourceErrorCode | null;
  error: string | null;
  /** The source's name as Drive has it now. */
  name: string;
  fileCount: number;
  skippedCount: number;
  truncated: boolean;
  added: number;
  updated: number;
  removed: number;
}

/**
 * One sync of one source. Never throws: a sync that cannot finish says why in
 * its result, and what it had already mirrored stays in the project. A Drive
 * that refuses the whole source (a lost token, a folder no longer shared) is
 * not a reason to delete the knowledge the project already holds; only a file
 * the folder no longer lists is removed.
 */
export async function runSourceSync(input: SourceSyncInput): Promise<SourceSyncResult> {
  const { client, source, port } = input;
  let name = source.name;
  const fail = async (error: unknown): Promise<SourceSyncResult> => {
    const failure = classifyDriveFailure(error, name);
    const items = await port.items().catch(() => [] as SourceItemRecord[]);
    return {
      state: "error",
      errorCode: failure.code,
      error: failure.message,
      name,
      fileCount: items.filter((item) => item.state === "synced").length,
      skippedCount: items.filter((item) => item.state === "skipped").length,
      truncated: false,
      added: 0,
      updated: 0,
      removed: 0,
    };
  };

  let remote: DriveListedFile[];
  let truncated = false;
  try {
    const target = await readDriveTarget(client, source.externalId);
    name = target.name;
    if (target.trashed) throw new SourceSyncError("not_found", sourceErrorMessage("not_found", name));
    if (source.kind === "folder") {
      if (!target.isFolder) throw new SourceSyncError("not_found", sourceErrorMessage("not_found", name));
      const listing = await listDriveFolderTree(client, source.externalId, { includeSubfolders: source.includeSubfolders, limits: input.limits });
      remote = listing.files;
      truncated = listing.truncated;
    } else {
      remote = target.isFolder ? [] : [target.file];
    }
  } catch (error) {
    return fail(error);
  }

  const plan = planSourceSync(await port.items(), remote);
  let added = 0;
  let updated = 0;
  let removed = 0;
  let remaining = input.remainingTokens;
  let stop: SourceSyncError | null = null;
  let capacityHit = false;

  // Removals first: what left the folder frees room for what arrived.
  for (const item of plan.remove) {
    await port.removeItem(item);
    removed += 1;
  }
  for (const { item, file } of plan.relabel) await port.relabelItem(item, file);

  const importOne = async (file: DriveListedFile, previous: SourceItemRecord | null) => {
    if (stop) return;
    if (remaining <= 0) {
      capacityHit = true;
      return;
    }
    try {
      const imported = await port.importFile(file);
      remaining -= estimateKnowledgeTokens({ size: imported.bytes, mimeType: imported.mimeType });
      await port.saveItem(file, { attachmentId: imported.attachmentId, state: "synced", error: null });
      if (previous?.attachmentId) await port.removeAttachment(previous.attachmentId);
      if (previous) updated += 1;
      else added += 1;
    } catch (error) {
      if (isSourceWide(error)) {
        stop = classifyDriveFailure(error, name);
        return;
      }
      if (error instanceof SourceSyncError) {
        stop = error;
        return;
      }
      if (error instanceof CloudFileError && error.code === "LIBRARY_QUOTA_EXCEEDED") {
        stop = new SourceSyncError("library_full", sourceErrorMessage("library_full", name));
        return;
      }
      // One file the project can't take (its type, its size, an export Drive
      // refused) is recorded against its version, so it is not fetched again
      // until it changes, and the rest of the folder carries on. A changed file
      // that fails keeps its previous copy in the project.
      const message = error instanceof CloudFileError ? error.message : `Couldn’t add “${file.name}”.`;
      if (previous?.attachmentId) return;
      await port.saveItem(file, { attachmentId: null, state: "skipped", error: message });
    }
  };

  for (const { item, file } of plan.update) await importOne(file, item);
  for (const file of plan.add) await importOne(file, null);

  const items = await port.items();
  const fileCount = items.filter((item) => item.state === "synced").length;
  const skippedCount = items.filter((item) => item.state === "skipped").length;
  const finalStop = stop as SourceSyncError | null;
  if (finalStop) {
    return { state: "error", errorCode: finalStop.code, error: finalStop.message, name, fileCount, skippedCount, truncated, added, updated, removed };
  }
  if (capacityHit) {
    return { state: "error", errorCode: "capacity", error: sourceErrorMessage("capacity", name), name, fileCount, skippedCount, truncated, added, updated, removed };
  }
  return { state: "ready", errorCode: null, error: null, name, fileCount, skippedCount, truncated, added, updated, removed };
}
