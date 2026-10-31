import { ConnectorApiError, connectorApiUrl, type FirstPartyClient } from "@/lib/first-party-connectors/client";
import { HEIC_UNSUPPORTED_MESSAGE, isAcceptedUpload, isHeicUpload, sniffDocumentMime } from "@/lib/uploads";
import {
  CLOUD_FILE_ID,
  CLOUD_FILE_SOURCE_LABEL,
  type CloudFileProvider,
  type CloudFileRef,
  type CloudFileSummary,
} from "./shared";

/*
 * The two drives' APIs, read for one thing: which files a person can pick,
 * and the bytes of the ones they picked.
 *
 * Every request goes through `FirstPartyClient`, the same adapter the Drive
 * and Microsoft 365 tools use: the origin and API prefix are pinned per
 * provider, redirects are never followed with the bearer token, and Graph's
 * pre-authenticated download URL is fetched with the SSRF-safe client and no
 * provider headers. Nothing here decides whether a file is SAFE to store —
 * that is `planAttachmentUpload`, the same gate an upload passes — only
 * whether it can be fetched at all and in which format.
 */

export interface CloudExport {
  mimeType: string;
  extension: string;
}

const DOCX: CloudExport = { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" };
const XLSX: CloudExport = { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
const PPTX: CloudExport = { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx" };
const PDF: CloudExport = { mimeType: "application/pdf", extension: "pdf" };
const TXT: CloudExport = { mimeType: "text/plain", extension: "txt" };
const CSV: CloudExport = { mimeType: "text/csv", extension: "csv" };

const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT = "application/vnd.google-apps.shortcut";

/**
 * Google's own formats have no bytes of their own, so each is exported — the
 * Office format first, because that is what the extractors read with its
 * structure (headings, sheets, slides) intact.
 *
 * The later formats are fallbacks, not alternatives. Drive refuses an export
 * over its 10 MB export limit with a 403, and an export can be over this
 * account's own ceiling; a picture-heavy Doc that will not come out as .docx
 * still comes out as a PDF, and failing that as its text. A Sheet falls back
 * to CSV (its first tab), which is still the data.
 */
export const GOOGLE_EXPORTS: Readonly<Record<string, readonly CloudExport[]>> = {
  "application/vnd.google-apps.document": [DOCX, PDF, TXT],
  "application/vnd.google-apps.spreadsheet": [XLSX, CSV],
  "application/vnd.google-apps.presentation": [PPTX, PDF, TXT],
  "application/vnd.google-apps.drawing": [PDF],
};

/** The export formats for a Google-native type, best first, or null for a type with bytes of its own. */
export function googleExportFormats(mimeType: string): readonly CloudExport[] | null {
  return Object.hasOwn(GOOGLE_EXPORTS, mimeType) ? GOOGLE_EXPORTS[mimeType] : null;
}

/**
 * Legacy Office binaries (.doc, .xls, .ppt) are not formats the extractors
 * read, and the upload gate refuses them. Graph converts them on download
 * (`/content?format=pdf`), so from OneDrive they arrive as a PDF instead of
 * as a refusal.
 */
const GRAPH_PDF_CONVERTIBLE = new Set(["doc", "xls", "ppt", "pps"]);

export type CloudUnavailableReason = "folder" | "unsupported" | "not_exportable" | "heic";

/** The short note a picker row wears, and the sentence an attach refusal says. */
const UNAVAILABLE: Record<CloudUnavailableReason, { note: string; sentence: (name: string) => string }> = {
  folder: { note: "Folder", sentence: (name) => `“${name}” is a folder. Pick the files inside it instead.` },
  unsupported: { note: "Can’t attach this type", sentence: (name) => `“${name}” is a type of file that can’t be attached.` },
  not_exportable: { note: "Can’t be exported", sentence: (name) => `“${name}” is a Google file type that can’t be exported.` },
  heic: { note: "HEIC photo", sentence: () => HEIC_UNSUPPORTED_MESSAGE },
};

/** One way of getting a file's bytes: where from, and what they arrive as. */
export interface CloudFileSource {
  path: string;
  fileName: string;
  mimeType: string;
  /** A format the drive converts to on request, so the bytes are checked against it on arrival. */
  converted: boolean;
}

export type CloudFileResolution =
  | { ok: true; name: string; size: number | null; sources: CloudFileSource[] }
  | { ok: false; name: string; reason: CloudUnavailableReason };

export interface GoogleFileMeta {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  modifiedTime?: string;
}

export interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  package?: unknown;
  remoteItem?: GraphItem;
  parentReference?: { driveId?: string };
}

const enc = encodeURIComponent;

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** `name` as the format it arrives in: "Q3 plan" → "Q3 plan.docx"; a name already carrying it is kept. */
export function withExtension(name: string, extension: string): string {
  const base = name.trim() || "Untitled";
  return extensionOf(base) === extension ? base : `${base}.${extension}`;
}

/** A converted file takes the new format's extension in place of the old one: "Budget.xls" → "Budget.pdf". */
function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  return withExtension(dot > 0 ? name.slice(0, dot) : name, extension);
}

/** What the upload gate would say about this name and type, before a byte is fetched. */
function attachable(name: string, mimeType: string): CloudUnavailableReason | null {
  if (isHeicUpload(name, mimeType)) return "heic";
  return isAcceptedUpload(name, mimeType) ? null : "unsupported";
}

function byteCount(value: string | number | undefined): number | null {
  const size = typeof value === "string" ? Number(value) : value;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

export function resolveGoogleFile(meta: GoogleFileMeta): CloudFileResolution {
  const name = meta.name?.trim() || "Untitled";
  const mimeType = meta.mimeType ?? "application/octet-stream";
  if (mimeType === GOOGLE_FOLDER || mimeType === GOOGLE_SHORTCUT) return { ok: false, name, reason: "folder" };
  const formats = googleExportFormats(mimeType);
  if (formats) {
    return {
      ok: true,
      name,
      size: null,
      sources: formats.map((format) => ({
        path: `/drive/v3/files/${enc(meta.id)}/export?mimeType=${enc(format.mimeType)}`,
        fileName: withExtension(name, format.extension),
        mimeType: format.mimeType,
        converted: true,
      })),
    };
  }
  // Forms, Sites, My Maps, Jamboards: Google keeps no bytes and offers no export.
  if (mimeType.startsWith("application/vnd.google-apps.")) return { ok: false, name, reason: "not_exportable" };
  const refused = attachable(name, mimeType);
  if (refused) return { ok: false, name, reason: refused };
  return {
    ok: true,
    name,
    size: byteCount(meta.size),
    sources: [{ path: `/drive/v3/files/${enc(meta.id)}?alt=media&supportsAllDrives=true`, fileName: name, mimeType, converted: false }],
  };
}

/** A Graph item, or the shared item it points at (`remoteItem`: recent and shared files on another drive). */
export function graphTarget(item: GraphItem): { id: string; driveId: string | null; item: GraphItem } | null {
  const remote = item.remoteItem;
  const id = remote?.id ?? item.id;
  if (!id) return null;
  return {
    id,
    driveId: remote?.parentReference?.driveId ?? null,
    // The outer row carries the person's view (name, when it was last touched);
    // the remote facet carries what the file actually is.
    item: { ...remote, ...item, file: item.file ?? remote?.file, folder: item.folder ?? remote?.folder, package: item.package ?? remote?.package, size: item.size ?? remote?.size },
  };
}

function graphItemPath(ref: CloudFileRef): string {
  return `/v1.0/${ref.driveId ? `drives/${enc(ref.driveId)}` : "me/drive"}/items/${enc(ref.id)}`;
}

export function resolveGraphItem(ref: CloudFileRef, item: GraphItem): CloudFileResolution {
  const name = item.name?.trim() || "Untitled";
  if (item.folder) return { ok: false, name, reason: "folder" };
  // A `package` is a OneNote notebook or similar: a folder in disguise.
  if (item.package || !item.file) return { ok: false, name, reason: "unsupported" };
  const base = graphItemPath(ref);
  if (GRAPH_PDF_CONVERTIBLE.has(extensionOf(name))) {
    return {
      ok: true,
      name,
      // The converted PDF's size is not the original's; only the download knows it.
      size: null,
      sources: [{ path: `${base}/content?format=pdf`, fileName: replaceExtension(name, "pdf"), mimeType: PDF.mimeType, converted: true }],
    };
  }
  const mimeType = item.file.mimeType || "application/octet-stream";
  const refused = attachable(name, mimeType);
  if (refused) return { ok: false, name, reason: refused };
  return { ok: true, name, size: byteCount(item.size), sources: [{ path: `${base}/content`, fileName: name, mimeType, converted: false }] };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function summarizeCloudFile(
  ref: { id: string; driveId: string | null },
  resolution: CloudFileResolution,
  extra: { mimeType: string; modifiedAt: string | null; size: number | null },
  maxBytes: number,
): CloudFileSummary {
  const first = resolution.ok ? resolution.sources[0] : null;
  // Only the size of the bytes that will arrive can rule a row out; a
  // converted file shows its original's size as a hint and is judged on arrival.
  const arriving = resolution.ok ? resolution.size : null;
  return {
    id: ref.id,
    driveId: ref.driveId,
    name: resolution.name,
    attachName: first?.fileName ?? resolution.name,
    attachMime: first?.mimeType ?? extra.mimeType,
    size: arriving ?? extra.size,
    modifiedAt: extra.modifiedAt,
    unavailable: !resolution.ok
      ? UNAVAILABLE[resolution.reason].note
      : arriving !== null && arriving > maxBytes
        ? `Over ${megabytes(maxBytes)}`
        : null,
  };
}

/** A request this module refuses or a drive answered with, as the status and sentence the route sends. */
export class CloudFileError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudFileError";
  }
}

export class CloudFileTooLargeError extends Error {
  constructor() {
    super("The file is larger than this import allows");
    this.name = "CloudFileTooLargeError";
  }
}

/**
 * The body, read no further than `maxBytes`. A declared length over the cap is
 * refused before the first chunk; an undeclared one (every Google export) is
 * cut off the moment it passes it, so an oversize file never sits whole in memory.
 */
export async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudFileTooLargeError();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new CloudFileTooLargeError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/**
 * Whether converted bytes are the format that was asked for. Only checked for
 * conversions, where this side chose the format: an Office export is a ZIP and
 * a PDF opens with its header, and anything else (an HTML error page served
 * with a 200) is not the file. A file stored as-is is judged by the upload gate,
 * exactly as an upload would be.
 */
export function matchesExport(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === PDF.mimeType) return sniffDocumentMime(bytes) === PDF.mimeType;
  if (mimeType.startsWith("application/vnd.openxmlformats-officedocument.")) {
    return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
  }
  return true;
}

/** Drive's query language quotes with `'` and escapes with `\`. */
export function driveQueryLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function query(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return `${path}?${search}`;
}

/**
 * A Graph page cursor is the `@odata.nextLink` Graph issued, sent back by the
 * browser. It is held to Graph's origin and to the drive APIs before the
 * token goes anywhere near it: a cursor rewritten to another Graph resource is
 * a request this picker never makes.
 */
export function graphCursor(cursor: string): string {
  let url: URL;
  try {
    url = connectorApiUrl("microsoft-365", cursor);
  } catch {
    throw new CloudFileError("invalid_cursor", 400, "That page of results has expired. Search again.");
  }
  if (!/^\/v1\.0\/(?:me\/drive\/|drives\/)/.test(url.pathname)) {
    throw new CloudFileError("invalid_cursor", 400, "That page of results has expired. Search again.");
  }
  return url.href;
}

export interface CloudFilePage {
  files: CloudFileSummary[];
  nextCursor: string | null;
}

export interface ListCloudFilesInput {
  /** Empty for recent files. */
  query: string;
  cursor: string | null;
  limit: number;
  maxBytes: number;
}

async function listGoogle(client: FirstPartyClient, input: ListCloudFilesInput): Promise<CloudFilePage> {
  const clauses = ["trashed = false", `mimeType != ${driveQueryLiteral(GOOGLE_FOLDER)}`, `mimeType != ${driveQueryLiteral(GOOGLE_SHORTCUT)}`];
  const text = input.query.trim();
  if (text) clauses.push(`(name contains ${driveQueryLiteral(text)} or fullText contains ${driveQueryLiteral(text)})`);
  const data = await client.json<{ files?: GoogleFileMeta[]; nextPageToken?: string }>(
    query("/drive/v3/files", {
      q: clauses.join(" and "),
      pageSize: input.limit,
      pageToken: input.cursor ?? undefined,
      // Drive refuses to sort a fullText query; a search comes back by relevance.
      orderBy: text ? undefined : "recency desc",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    }),
  );
  const files = (data.files ?? [])
    .filter((file) => typeof file.id === "string" && CLOUD_FILE_ID.test(file.id))
    .map((file) =>
      summarizeCloudFile(
        { id: file.id, driveId: null },
        resolveGoogleFile(file),
        { mimeType: file.mimeType ?? "application/octet-stream", modifiedAt: file.modifiedTime ?? null, size: byteCount(file.size) },
        input.maxBytes,
      ),
    );
  return { files, nextCursor: data.nextPageToken ?? null };
}

const GRAPH_RECENT_UNAVAILABLE = new Set([400, 404, 405, 410, 501]);

async function listGraph(client: FirstPartyClient, input: ListCloudFilesInput): Promise<CloudFilePage> {
  type GraphPage = { value?: GraphItem[]; "@odata.nextLink"?: string };
  const text = input.query.trim();
  let data: GraphPage;
  let paged = true;
  if (input.cursor) {
    data = await client.json<GraphPage>(graphCursor(input.cursor));
  } else if (text) {
    // OData quotes with `'` and escapes it by doubling; encodeURIComponent
    // leaves both quotes literal, so the escape survives into the URL.
    data = await client.json<GraphPage>(`/v1.0/me/drive/root/search(q='${enc(text.replace(/'/g, "''"))}')?$top=${input.limit}`);
  } else {
    try {
      // What the person opened lately, across drives (shared files arrive as remoteItem).
      data = await client.json<GraphPage>("/v1.0/me/drive/recent");
      paged = false;
    } catch (error) {
      // `recent` is not served on every account type; the drive's top level is
      // still a useful first screen, newest first.
      if (!(error instanceof ConnectorApiError) || !GRAPH_RECENT_UNAVAILABLE.has(error.status)) throw error;
      data = await client.json<GraphPage>(`/v1.0/me/drive/root/children?$top=${input.limit}`);
      data.value = [...(data.value ?? [])].sort((a, b) => Date.parse(b.lastModifiedDateTime ?? "") - Date.parse(a.lastModifiedDateTime ?? "") || 0);
    }
  }
  const files: CloudFileSummary[] = [];
  for (const row of data.value ?? []) {
    const target = graphTarget(row);
    // Folders are not offered at all: the picker searches files, it does not browse.
    if (!target || target.item.folder || !CLOUD_FILE_ID.test(target.id) || (target.driveId !== null && !CLOUD_FILE_ID.test(target.driveId))) continue;
    files.push(
      summarizeCloudFile(
        { id: target.id, driveId: target.driveId },
        resolveGraphItem(target, target.item),
        {
          mimeType: target.item.file?.mimeType ?? "application/octet-stream",
          modifiedAt: target.item.lastModifiedDateTime ?? null,
          size: byteCount(target.item.size),
        },
        input.maxBytes,
      ),
    );
    if (!paged && files.length >= input.limit) break;
  }
  return { files, nextCursor: paged ? (data["@odata.nextLink"] ?? null) : null };
}

/** One page of the picker: recent files, or a search. */
export function listCloudFiles(client: FirstPartyClient, input: ListCloudFilesInput): Promise<CloudFilePage> {
  return client.provider === "google-drive" ? listGoogle(client, input) : listGraph(client, input);
}

export interface FetchedCloudFile {
  /** The name the drive shows. */
  name: string;
  /** The attachment's name and declared type: the export's, for a converted file. */
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface FetchCloudFileLimits {
  maxBytes: number;
  /** The sentence for a file over `maxBytes` (the plan's words, or the import ceiling's). */
  tooLarge: string;
}

function providerOf(client: FirstPartyClient): CloudFileProvider {
  if (client.provider !== "google-drive" && client.provider !== "microsoft-365") throw new Error("Not a cloud drive");
  return client.provider;
}

/** A drive's refusal, as the sentence the person reads. Provider bodies are never echoed. */
function driveFailure(error: unknown, provider: CloudFileProvider, name: string | null, converting: boolean): CloudFileError {
  const label = CLOUD_FILE_SOURCE_LABEL[provider];
  const subject = name ? `“${name}”` : "that file";
  if (error instanceof CloudFileError) return error;
  if (error instanceof CloudFileTooLargeError) return new CloudFileError("payload_too_large", 413, "File is too large.");
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new CloudFileError("timeout", 504, `${label} took too long to send ${subject}. Try again.`);
  }
  if (error instanceof ConnectorApiError) {
    if (error.status === 401) return new CloudFileError("connector_reconnect", 409, `Reconnect ${label} in Apps to continue.`);
    if (error.status === 403) {
      return converting
        ? new CloudFileError("export_refused", 422, `${label} wouldn’t export ${subject}. It may be too large to export, or its owner turned off downloading.`)
        : new CloudFileError("forbidden", 403, `${label} won’t let you download ${subject}.`);
    }
    if (error.status === 404) return new CloudFileError("not_found", 404, `${subject.charAt(0).toUpperCase()}${subject.slice(1)} is no longer in your ${label}.`);
    if (error.status === 429) return new CloudFileError("rate_limited", 429, `${label} is busy. Try again in a moment.`);
  }
  return new CloudFileError("provider_error", 502, `Couldn’t get ${subject} from ${label}. Try again.`);
}

async function readMetadata(client: FirstPartyClient, provider: CloudFileProvider, ref: CloudFileRef): Promise<CloudFileResolution> {
  if (provider === "google-drive") {
    const meta = await client.json<GoogleFileMeta>(`/drive/v3/files/${enc(ref.id)}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
    return resolveGoogleFile({ ...meta, id: ref.id });
  }
  const item = await client.json<GraphItem>(`${graphItemPath(ref)}?$select=id,name,size,file,folder,package,lastModifiedDateTime`);
  return resolveGraphItem(ref, item);
}

/**
 * The bytes of one picked file, in the first format that arrives whole and
 * within the limit. The type and name are re-read from the drive here, never
 * taken from the browser: the picker's row is a hint, the drive's metadata is
 * the record.
 */
export async function fetchCloudFile(client: FirstPartyClient, ref: CloudFileRef, limits: FetchCloudFileLimits): Promise<FetchedCloudFile> {
  const provider = providerOf(client);
  if (!CLOUD_FILE_ID.test(ref.id) || (ref.driveId != null && (provider !== "microsoft-365" || !CLOUD_FILE_ID.test(ref.driveId)))) {
    throw new CloudFileError("invalid_request", 400, "That file reference isn’t valid.");
  }
  let resolution: CloudFileResolution;
  try {
    resolution = await readMetadata(client, provider, ref);
  } catch (error) {
    throw driveFailure(error, provider, null, false);
  }
  if (!resolution.ok) throw new CloudFileError("unsupported_media_type", 415, UNAVAILABLE[resolution.reason].sentence(resolution.name));
  if (resolution.size !== null && resolution.size > limits.maxBytes) throw new CloudFileError("payload_too_large", 413, limits.tooLarge);

  let last: CloudFileError | null = null;
  for (const [index, source] of resolution.sources.entries()) {
    const fallback = index < resolution.sources.length - 1;
    try {
      const response = await client.request(source.path, undefined, "GET", true);
      const bytes = await readCappedBytes(response, limits.maxBytes);
      if (source.converted && !matchesExport(source.mimeType, bytes)) {
        last = new CloudFileError("provider_error", 502, `${CLOUD_FILE_SOURCE_LABEL[provider]} sent something other than “${resolution.name}”. Try again.`);
        if (fallback) continue;
        throw last;
      }
      return { name: resolution.name, fileName: source.fileName, mimeType: source.mimeType, bytes };
    } catch (error) {
      if (error === last) throw error;
      const failure: CloudFileError =
        error instanceof CloudFileTooLargeError
          ? new CloudFileError("payload_too_large", 413, limits.tooLarge)
          : driveFailure(error, provider, resolution.name, source.converted);
      // Only a conversion has somewhere else to go: the next, smaller format.
      if (source.converted && fallback && (failure.status === 413 || failure.code === "export_refused")) {
        last = failure;
        continue;
      }
      throw failure;
    }
  }
  throw last ?? new CloudFileError("provider_error", 502, `Couldn’t get “${resolution.name}”. Try again.`);
}
