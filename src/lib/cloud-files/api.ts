import { z } from "zod";
import { ConnectorApiError, FirstPartyClient } from "@/lib/first-party-connectors/client";
import { planAttachmentUpload, type AttachmentUploadPlan } from "@/lib/attachment-upload";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { ClientAttachment } from "@/types/chat";
import { CloudFileError, fetchCloudFile, listCloudFiles } from "./drives";
import {
  CLOUD_FILE_ID,
  CLOUD_FILE_SOURCE_LABEL,
  CLOUD_IMPORT_CEILING_MB,
  CLOUD_IMPORT_ORIGIN,
  isCloudFileProvider,
  type CloudFileAttachFailure,
  type CloudFileAttachResponse,
  type CloudFileListResponse,
  type CloudFileProvider,
} from "./shared";

/*
 * The two picker routes, as functions of their dependencies.
 *
 * GET  /api/connectors/[id]/files          recent files, or a search
 * POST /api/connectors/[id]/files/attach   fetch the picked files and store them
 *
 * The route files only wire the real dependencies (./server.ts); everything a
 * person can observe — who may ask, which account's token is used, what is
 * refused and in which words — is decided here, where a test can hand it a
 * fake database and a fake drive.
 *
 * Ownership has one source: the signed-in user. The connection, the token,
 * the conversation and the stored attachment are all looked up by that id and
 * nothing in the request can name another account's. A file is fetched by the
 * person's own token, so a picked id can only ever reach what their drive
 * already shows them.
 */

export interface CloudFilesUser {
  id: string;
  email?: string | null;
}

export interface CloudFilesDeps {
  currentUser(): Promise<CloudFilesUser | null>;
  /** The connector's OAuth app is set up on this deployment. */
  connectorConfigured(provider: CloudFileProvider): boolean;
  /** The user has linked this connector (a Connection row of theirs). */
  hasConnection(userId: string, provider: CloudFileProvider): Promise<boolean>;
  /** A fresh access token for the user's own connection, or null when it needs reconnecting. */
  accessToken(userId: string, provider: CloudFileProvider): Promise<string | null>;
  /** The account's app permissions (Settings › Apps): Lockdown and blocked apps refuse reading too. */
  appPolicy(userId: string, provider: CloudFileProvider): Promise<{ lockdown: boolean; blocked: boolean }>;
  /** True when the request is within the limit. */
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
  /** Owner accounts skip the upload limit, as on /api/upload. */
  isOwner(email: string | null | undefined): boolean;
  fetcher: typeof fetch;
  /** The plan's per-file upload ceiling, and the plan the library quota is counted against. */
  uploadLimit(userId: string): Promise<{ plan: string; maxUploadMb: number }>;
  storageAvailable(): boolean;
  conversationOwned(userId: string, conversationId: string): Promise<boolean>;
  /** Stores the bytes and the attachment rows, inside the library quota; the same persistence as an upload. */
  persist(input: {
    userId: string;
    plan: string;
    bytes: Uint8Array;
    planned: AttachmentUploadPlan;
    conversationId: string | null;
    origin: string;
  }): Promise<ClientAttachment>;
  /** Whether an error from `persist` is the library quota (LibraryQuotaExceededError). */
  isQuotaError(error: unknown): boolean;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): ApiResult => ({ status, body });
const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ApiResult =>
  json(status, { error, code, ...extra });

const LIST_LIMIT = 25;
const MIB = 1024 * 1024;
/** Inside each route's maxDuration, so a slow drive ends as an answer rather than a killed request. */
const LIST_BUDGET_MS = 25_000;
const ATTACH_BUDGET_MS = 55_000;

/** The caller's signal (the browser hung up), bounded by the route's own budget. */
function within(ms: number, signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, budget]) : budget;
}

/** The per-file ceiling for an import: the plan's, never over the import ceiling. */
function importLimits(provider: CloudFileProvider, maxUploadMb: number) {
  const ceilingBinds = maxUploadMb > CLOUD_IMPORT_CEILING_MB;
  const mb = ceilingBinds ? CLOUD_IMPORT_CEILING_MB : maxUploadMb;
  return {
    maxBytes: mb * MIB,
    // The plan's sentence is planAttachmentUpload's, word for word, so the two
    // paths into the Library refuse a big file the same way.
    tooLarge: ceilingBinds
      ? `Files from ${CLOUD_FILE_SOURCE_LABEL[provider]} can be up to ${CLOUD_IMPORT_CEILING_MB} MB. Download this one and upload it instead.`
      : `File is too large. Your plan allows up to ${maxUploadMb} MB.`,
  };
}

type Gate =
  | { ok: true; user: CloudFilesUser; provider: CloudFileProvider; token: string }
  | { ok: false; result: ApiResult };

/**
 * Who is asking, for which drive, and with what. In this order: an unknown id
 * says nothing about connections, and a blocked app is refused before its
 * token is refreshed.
 */
async function openDrive(deps: CloudFilesDeps, providerId: string): Promise<Gate> {
  const user = await deps.currentUser();
  if (!user) return { ok: false, result: refuse(401, "unauthorized", "Unauthorized") };
  if (!isCloudFileProvider(providerId) || !deps.connectorConfigured(providerId)) {
    return { ok: false, result: refuse(404, "unknown_app", "Unknown app") };
  }
  const provider = providerId;
  const label = CLOUD_FILE_SOURCE_LABEL[provider];
  if (!(await deps.hasConnection(user.id, provider))) {
    return { ok: false, result: refuse(409, "connector_not_connected", `Connect ${label} in Apps first.`, { provider }) };
  }
  const policy = await deps.appPolicy(user.id, provider);
  if (policy.lockdown) {
    return { ok: false, result: refuse(403, "connector_blocked", `Lockdown is on, so ${PRODUCT_NAME} can’t read ${label}. Turn it off in Settings › Apps.`) };
  }
  if (policy.blocked) {
    return { ok: false, result: refuse(403, "connector_blocked", `${label} is blocked in Settings › Apps.`) };
  }
  const token = await deps.accessToken(user.id, provider);
  if (!token) return { ok: false, result: refuse(409, "connector_reconnect", `Reconnect ${label} in Apps to continue.`, { provider }) };
  return { ok: true, user, provider, token };
}

const listQuery = z.object({
  q: z.string().max(200).default(""),
  cursor: z.string().min(1).max(8192).optional(),
});

export async function handleCloudFileList(deps: CloudFilesDeps, providerId: string, url: URL, signal?: AbortSignal): Promise<ApiResult> {
  const gate = await openDrive(deps, providerId);
  if (!gate.ok) return gate.result;
  const { user, provider, token } = gate;
  const params = listQuery.safeParse({ q: url.searchParams.get("q") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined });
  if (!params.success) return refuse(400, "invalid_request", "Invalid search.");
  // A search box asks once per pause in typing; this is far above that and
  // well below a loop.
  if (!(await deps.rateLimit(`cloud-files:${user.id}`, 120, 60))) {
    return refuse(429, "rate_limited", "Too many searches. Try again in a minute.");
  }
  const { maxUploadMb } = await deps.uploadLimit(user.id);
  const { maxBytes } = importLimits(provider, maxUploadMb);
  const client = new FirstPartyClient(provider, token, deps.fetcher, within(LIST_BUDGET_MS, signal));
  try {
    const page = await listCloudFiles(client, { query: params.data.q, cursor: params.data.cursor ?? null, limit: LIST_LIMIT, maxBytes });
    const body: CloudFileListResponse = { files: page.files, nextCursor: page.nextCursor, maxBytes };
    return json(200, body);
  } catch (error) {
    const failure = listFailure(error, provider);
    return refuse(failure.status, failure.code, failure.message);
  }
}

/** A drive's refusal of a listing. Provider bodies stay out of the answer and the logs. */
function listFailure(error: unknown, provider: CloudFileProvider): CloudFileError {
  if (error instanceof CloudFileError) return error;
  const label = CLOUD_FILE_SOURCE_LABEL[provider];
  if (error instanceof ConnectorApiError && error.status === 401) {
    return new CloudFileError("connector_reconnect", 409, `Reconnect ${label} in Apps to continue.`);
  }
  if (error instanceof ConnectorApiError && error.status === 429) {
    return new CloudFileError("rate_limited", 429, `${label} is busy. Try again in a moment.`);
  }
  return new CloudFileError("provider_error", 502, `Couldn’t reach ${label}. Try again.`);
}

const attachBody = z.strictObject({
  files: z
    .array(z.strictObject({ id: z.string().regex(CLOUD_FILE_ID), driveId: z.string().regex(CLOUD_FILE_ID).nullish() }))
    .min(1)
    .max(MAX_ATTACHMENTS),
  conversationId: z.string().min(1).max(200).nullish(),
});

/** Three at a time: enough to fill the minute for ten files, little enough to hold three in memory. */
const IMPORT_CONCURRENCY = 3;

export async function handleCloudFileAttach(deps: CloudFilesDeps, providerId: string, rawBody: unknown, signal?: AbortSignal): Promise<ApiResult> {
  const gate = await openDrive(deps, providerId);
  if (!gate.ok) return gate.result;
  const { user, provider, token } = gate;
  if (!deps.storageAvailable()) {
    return refuse(503, "storage_unavailable", "File uploads aren't available. Configure a storage bucket.");
  }
  const parsed = attachBody.safeParse(rawBody);
  if (!parsed.success) return refuse(400, "invalid_request", "Invalid request.");
  const conversationId = parsed.data.conversationId ?? null;
  // A missing conversation and another account's are the same 404.
  if (conversationId && !(await deps.conversationOwned(user.id, conversationId))) {
    return refuse(404, "not_found", "Conversation not found.");
  }

  // De-duplicated, order kept: picking a file twice attaches it once.
  const seen = new Set<string>();
  const refs = parsed.data.files.filter((ref) => {
    const key = `${ref.driveId ?? ""}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { plan, maxUploadMb } = await deps.uploadLimit(user.id);
  const limits = importLimits(provider, maxUploadMb);
  const client = new FirstPartyClient(provider, token, deps.fetcher, within(ATTACH_BUDGET_MS, signal));
  const owner = deps.isOwner(user.email);
  let stop: CloudFileError | null = null;

  type Outcome = { attachment: ClientAttachment } | { failure: CloudFileAttachFailure; status: number; code: string };
  const importOne = async (ref: (typeof refs)[number]): Promise<Outcome> => {
    const fail = (error: CloudFileError, name: string | null = null): Outcome => ({
      failure: { id: ref.id, name, error: error.message },
      status: error.status,
      code: error.code,
    });
    // An account-wide refusal (the upload limit, the library quota) stops the
    // files not yet started rather than asking again for each.
    if (stop) return fail(stop);
    // Each file is an upload: it spends from the same hourly allowance.
    if (!owner && !(await deps.rateLimit(`upload:${user.id}`, 60, 3600))) {
      stop = new CloudFileError("rate_limited", 429, "Upload limit reached. Try again later.");
      return fail(stop);
    }
    let fetched;
    try {
      fetched = await fetchCloudFile(client, { id: ref.id, driveId: ref.driveId ?? null }, limits);
    } catch (error) {
      return fail(error instanceof CloudFileError ? error : new CloudFileError("provider_error", 502, `Couldn’t reach ${CLOUD_FILE_SOURCE_LABEL[provider]}. Try again.`));
    }
    // The upload gate, unchanged: HEIC refusal, the accepted types by name and
    // type, the plan's size, magic-byte sniffing, the neutral stored type.
    const planned = planAttachmentUpload({
      declaredMime: fetched.mimeType,
      fileName: fetched.fileName,
      size: fetched.bytes.byteLength,
      bytes: fetched.bytes,
      maxUploadMb,
    });
    if (!planned.ok) return fail(new CloudFileError(planned.error.code, planned.error.status, planned.error.message), fetched.name);
    try {
      const attachment = await deps.persist({
        userId: user.id,
        plan,
        bytes: fetched.bytes,
        planned: planned.plan,
        conversationId,
        origin: CLOUD_IMPORT_ORIGIN,
      });
      return { attachment };
    } catch (error) {
      if (deps.isQuotaError(error)) {
        stop = new CloudFileError("LIBRARY_QUOTA_EXCEEDED", 413, "Library storage limit reached.");
        return fail(stop, fetched.name);
      }
      // One file's storage failure must not lose the others already stored:
      // they are in the Library now, and the answer has to say so. Only the
      // error's kind is logged; its message can carry the file's name.
      console.error("[cloud-files] storing an import failed:", error instanceof Error ? error.name : typeof error);
      return fail(new CloudFileError("storage_error", 500, `Couldn’t save “${fetched.name}”. Try again.`), fetched.name);
    }
  };

  const outcomes: Outcome[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const index = next++;
      outcomes[index] = await importOne(refs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, refs.length) }, worker));

  const attachments: ClientAttachment[] = [];
  const failed: CloudFileAttachFailure[] = [];
  let firstFailure: { status: number; code: string } | null = null;
  for (const outcome of outcomes) {
    if ("attachment" in outcome) attachments.push(outcome.attachment);
    else {
      failed.push(outcome.failure);
      firstFailure ??= { status: outcome.status, code: outcome.code };
    }
  }
  if (attachments.length === 0 && firstFailure) {
    return refuse(firstFailure.status, firstFailure.code, failed[0].error, { failed });
  }
  const body: CloudFileAttachResponse = { attachments, failed };
  return json(201, body);
}
