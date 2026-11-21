import "server-only";
import { after } from "next/server";
import type { Plan, ProjectSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import { firstPartyAccessToken } from "@/lib/first-party-connectors/tokens";
import { FirstPartyClient } from "@/lib/first-party-connectors/client";
import { resolveActionPolicy } from "@/lib/action-approval-store";
import { CloudFileError, fetchCloudFile } from "@/lib/cloud-files/drives";
import { CLOUD_IMPORT_CEILING_MB, CLOUD_IMPORT_ORIGIN } from "@/lib/cloud-files/shared";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import { buildObjectKey, deleteObject, putObject } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";
import { assertLibraryCapacity, libraryCapacity, lockedLibraryCapacity, LibraryQuotaExceededError } from "@/lib/library";
import { tombstoneAttachment } from "@/lib/library-removal";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isGoogleDriveFilesEnabled } from "@/lib/env";
import {
  readDriveTarget,
  projectDriveFetch,
  runSourceSync,
  sourceErrorMessage,
  classifyDriveFailure,
  SourceSyncError,
  type DriveListedFile,
  type DriveTarget,
  type SourceItemRecord,
  type SourceSyncPort,
  type SourceSyncResult,
} from "./drive-source";
import { estimateKnowledgeTokens, PROJECT_KNOWLEDGE_CAPACITY_TOKENS } from "./knowledge-capacity";
import { SOURCE_STALE_MS, type DriveAvailability, type ProjectSourceView } from "./project-sources-shared";

/*
 * The database half of a project's Google Drive sources (see drive-source.ts
 * for what a sync decides). Everything here is scoped to the project's OWNER:
 * the source row, its items, the Drive connection it reads and the Library its
 * files are stored in all carry the owner's `userId`, and every query below
 * filters on it.
 *
 * WHEN A SOURCE SYNCS. When it is added; when someone presses Sync now; and
 * whenever the project is opened or chatted in and the last sync is older
 * than SOURCE_STALE_MS. Each runs after the response (`after`), one at a time
 * per source (the `syncClaimedAt` lease), so a page view never waits on Drive
 * and two tabs never import one folder twice.
 */

const PROVIDER = "google-drive";
/** A sync that has held its lease this long is presumed dead and may be taken over. */
const SYNC_LEASE_MS = 5 * 60_000;
/** Inside the request's own budget, so a slow Drive ends as a recorded error rather than a killed function. */
const SYNC_BUDGET_MS = 240_000;
const MIB = 1024 * 1024;

/** Whether Drive sources can be offered to this person, and what is missing if not. */
export async function driveAvailability(userId: string): Promise<DriveAvailability> {
  const def = getConnector(PROVIDER);
  const configured = Boolean(def && isConnectorConfigured(def));
  const enabled = isGoogleDriveFilesEnabled() && configured;
  const connection = configured
    ? await prisma.connection.findFirst({ where: { userId, provider: PROVIDER }, select: { accountLabel: true } })
    : null;
  return { enabled, configured, connected: Boolean(connection), accountLabel: connection?.accountLabel ?? null };
}

/** The account's app permissions (Settings › Apps) refuse reading a blocked app, as the Drive picker does. */
async function driveBlocked(userId: string): Promise<boolean> {
  const policy = await resolveActionPolicy({ userId, connectorId: PROVIDER });
  return policy.lockdown || policy.connectorBlocked;
}

/** A Drive client on the owner's own token, or the reason there is none. */
export async function openDrive(userId: string, signal?: AbortSignal): Promise<FirstPartyClient> {
  const availability = await driveAvailability(userId);
  if (!availability.enabled) throw new SourceSyncError("provider_error", "Google Drive isn’t turned on for this server.");
  if (!availability.connected) throw new SourceSyncError("not_connected", "Connect Google Drive first.");
  if (await driveBlocked(userId)) throw new SourceSyncError("forbidden", "Google Drive is blocked in Settings › Apps.");
  const token = await firstPartyAccessToken(userId, PROVIDER);
  if (!token) throw new SourceSyncError("reconnect", "Reconnect Google Drive to continue.");
  return new FirstPartyClient(PROVIDER, token, projectDriveFetch(fetch), signal);
}

export async function listProjectSources(userId: string, projectId: string): Promise<ProjectSourceView[]> {
  const rows = await prisma.projectSource.findMany({
    where: { userId, projectId },
    orderBy: { createdAt: "asc" },
    include: {
      items: {
        where: { userId, state: "skipped" },
        select: { name: true, path: true, error: true },
        orderBy: { name: "asc" },
        take: 5,
      },
    },
  });
  const leaseCutoff = Date.now() - SYNC_LEASE_MS;
  return rows.map((row) => {
    const syncing = row.syncClaimedAt !== null && row.syncClaimedAt.getTime() > leaseCutoff;
    const interrupted = row.state === "syncing" && !syncing;
    return {
      id: row.id,
      provider: "google-drive",
      kind: row.kind === "file" ? "file" : "folder",
      externalId: row.externalId,
      name: row.name,
      includeSubfolders: row.includeSubfolders,
      state: interrupted ? "error" : row.state as ProjectSourceView["state"],
      syncing,
      errorCode: interrupted ? "provider_error" : row.errorCode as ProjectSourceView["errorCode"],
      error: interrupted ? sourceErrorMessage("provider_error", row.name) : row.error,
      fileCount: row.fileCount,
      skippedCount: row.skippedCount,
      truncated: row.truncated,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      skipped: row.items.map((item) => ({ name: item.path ? `${item.path}/${item.name}` : item.name, error: item.error ?? "" })),
    };
  });
}

export interface DrivePick {
  id: string;
  kind: "file" | "folder";
}

/**
 * Files the picked Drive items into the project as sources and starts their
 * first sync. Each pick is re-read from Drive with the owner's token before a
 * row is written, so its kind and name are Drive's, never the browser's, and
 * an id the person's Drive does not show them is refused.
 */
export async function addDriveSources(
  userId: string,
  projectId: string,
  picks: readonly DrivePick[],
  includeSubfolders: boolean,
): Promise<{ sourceIds: string[] }> {
  const client = await openDrive(userId, AbortSignal.timeout(30_000));
  const targets: DriveTarget[] = [];
  for (const pick of picks) {
    let target;
    try {
      target = await readDriveTarget(client, pick.id);
    } catch (error) {
      throw classifyDriveFailure(error, "that item");
    }
    if (target.trashed) throw new SourceSyncError("not_found", sourceErrorMessage("not_found", target.name));
    targets.push(target);
  }

  const sourceIds = await prisma.$transaction(async (tx) => {
    // Serialize batches for this project so overlapping picks can upsert in
    // either order without taking source row locks in opposite orders.
    const projects = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
    if (!projects.length) throw new SourceSyncError("not_found", "Not found.");
    const ids: string[] = [];
    for (const target of targets) {
      const kind = target.isFolder ? "folder" : "file";
      const row = await tx.projectSource.upsert({
        where: { projectId_provider_externalId: { projectId, provider: PROVIDER, externalId: target.id }, userId },
        create: { userId, projectId, provider: PROVIDER, kind, externalId: target.id, name: target.name, includeSubfolders },
        update: { name: target.name, kind, includeSubfolders },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return ids;
  });
  scheduleSourceSync(userId, sourceIds);
  return { sourceIds };
}

/**
 * Takes the source and every file it mirrored out of the project. The files
 * are tombstoned exactly as removing a project file is (their index redacted
 * in the same transaction), and the rows go with the source.
 */
export async function removeProjectSource(userId: string, projectId: string, sourceId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ProjectSource"
      WHERE "id" = ${sourceId} AND "userId" = ${userId} AND "projectId" = ${projectId}
      FOR UPDATE`;
    if (!rows.length) return false;
    const items = await tx.projectSourceItem.findMany({ where: { userId, sourceId }, select: { attachmentId: true } });
    for (const item of items) {
      if (!item.attachmentId) continue;
      await tombstoneById(tx, userId, projectId, item.attachmentId);
    }
    await tx.projectSource.deleteMany({ where: { id: sourceId, userId } });
    return true;
  }, { timeout: 30_000, maxWait: 10_000 });
}

type SourceTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Only live knowledge counts, excluding the attachment being atomically replaced. */
async function projectKnowledgeTokens(
  tx: SourceTransaction, userId: string, projectId: string, replacingId?: string,
): Promise<number> {
  const files = await tx.attachment.findMany({
    where: { userId, projectId, deletedAt: null, fileName: { not: "__cover__" }, ...(replacingId ? { id: { not: replacingId } } : {}) },
    select: { id: true, size: true, mimeType: true },
  });
  if (!files.length) return 0;
  const documents = await tx.knowledgeDocument.findMany({
    where: { userId, projectId, attachmentId: { in: files.map((file) => file.id) }, deletedAt: null, supersededById: null },
    select: { attachmentId: true, tokenCount: true },
  });
  const tokens = new Map(documents.map((document) => [document.attachmentId, document.tokenCount]));
  return files.reduce((sum, file) => sum + estimateKnowledgeTokens({ size: file.size, mimeType: file.mimeType, tokenCount: tokens.get(file.id) }), 0);
}

function itemRecord(row: { id: string; externalId: string; version: string; attachmentId: string | null; state: string; name: string; path: string }): SourceItemRecord {
  return { id: row.id, externalId: row.externalId, version: row.version, attachmentId: row.attachmentId, state: row.state === "skipped" ? "skipped" : "synced", name: row.name, path: row.path };
}

async function tombstoneById(tx: SourceTransaction, userId: string, projectId: string, attachmentId: string) {
  const attachment = await tx.attachment.findFirst({ where: { id: attachmentId, userId, projectId, deletedAt: null }, select: { id: true } });
  if (attachment) await tombstoneAttachment(tx, userId, attachment);
}

/** The port drive-source.ts runs a sync through, on Prisma and the upload pipeline. */
function prismaPort(source: ProjectSource, claimedAt: Date, client: FirstPartyClient, plan: Plan, signal: AbortSignal): SourceSyncPort {
  const { id: sourceId, userId, projectId } = source;
  // A stale worker can finish a download, but only the current lease holder may
  // mutate the mirror. The source row also serializes commits against removal.
  function withCurrentSource<T>(mutate: (tx: SourceTransaction) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ProjectSource"
        WHERE "id" = ${sourceId} AND "userId" = ${userId} AND "syncClaimedAt" = ${claimedAt}
        FOR UPDATE`;
      signal.throwIfAborted();
      if (!rows.length) throw new SourceSyncError("provider_error", "The sync no longer holds this source.");
      return mutate(tx);
    });
  }
  function saveItem(tx: SourceTransaction, file: DriveListedFile, attachmentId: string | null, error: string | null) {
    const data = {
      name: file.name,
      mimeType: file.mimeType,
      path: file.path,
      version: file.version,
      attachmentId,
      state: attachmentId ? "synced" : "skipped",
      error,
    };
    return tx.projectSourceItem.upsert({
      where: { sourceId_externalId: { sourceId, externalId: file.id }, userId },
      create: { userId, sourceId, externalId: file.id, ...data },
      update: data,
    });
  }

  const maxUploadMb = PLANS[plan].maxUploadMb;
  const ceilingBinds = maxUploadMb > CLOUD_IMPORT_CEILING_MB;
  const limits = {
    maxBytes: (ceilingBinds ? CLOUD_IMPORT_CEILING_MB : maxUploadMb) * MIB,
    tooLarge: ceilingBinds
      ? `Files from Google Drive can be up to ${CLOUD_IMPORT_CEILING_MB} MB.`
      : `Larger than the ${maxUploadMb} MB your plan allows.`,
  };
  return {
    async items() {
      const rows = await prisma.projectSourceItem.findMany({ where: { userId, sourceId } });
      return rows.map(itemRecord);
    },
    async importFile(file, previous) {
      signal.throwIfAborted();
      const fetched = await fetchCloudFile(client, { id: file.id }, limits);
      const size = fetched.bytes.byteLength;
      const planned = planAttachmentUpload({
        declaredMime: fetched.mimeType,
        fileName: fetched.fileName,
        size,
        bytes: fetched.bytes,
        maxUploadMb,
      });
      if (!planned.ok) throw new CloudFileError(planned.error.code, planned.error.status, planned.error.message);

      const { fileName, kind, storedMime: mimeType, storedContentType, contentDisposition, extractedText } = planned.plan;
      const replacingId = previous?.attachmentId ?? undefined;
      const storageKey = buildObjectKey(userId, fileName);
      const fileData = { fileName, kind, mimeType, size, storageKey, extractedText, origin: CLOUD_IMPORT_ORIGIN, parserState: "queued" };
      const addedTokens = estimateKnowledgeTokens({ size, mimeType });
      let attachmentId: string;
      let uploadStarted = false;
      try {
        assertLibraryCapacity(await libraryCapacity(userId, plan, size, replacingId));
        signal.throwIfAborted();
        uploadStarted = true;
        await putObject(storageKey, fetched.bytes, storedContentType, contentDisposition);
        attachmentId = await withCurrentSource(async (tx) => {
          // The Library quota lock also serializes capacity reads across
          // different Drive sources for the same project owner.
          assertLibraryCapacity(await lockedLibraryCapacity(tx, userId, plan, size, replacingId));
          const used = await projectKnowledgeTokens(tx, userId, projectId, replacingId);
          if (used + addedTokens > PROJECT_KNOWLEDGE_CAPACITY_TOKENS) {
            throw new SourceSyncError("capacity", sourceErrorMessage("capacity", source.name));
          }
          signal.throwIfAborted();
          const created = await tx.attachment.create({ data: { userId, projectId, ...fileData } });
          await tx.attachmentVersion.create({ data: { attachmentId: created.id, version: created.version, ...fileData } });
          await saveItem(tx, file, created.id, null);
          if (replacingId) await tombstoneById(tx, userId, projectId, replacingId);
          return created.id;
        });
      } catch (error) {
        if (uploadStarted) await deleteObject(storageKey).catch(() => undefined);
        if (error instanceof LibraryQuotaExceededError) throw new CloudFileError("LIBRARY_QUOTA_EXCEEDED", 413, "Library storage limit reached.");
        throw error;
      }

      scheduleIngest({ userId, projectId, attachmentId, fileName, mimeType, bytes: fetched.bytes });
    },
    async skipItem(file, error) {
      await withCurrentSource((tx) => saveItem(tx, file, null, error));
    },
    async removeItem(item) {
      await withCurrentSource(async (tx) => {
        if (item.attachmentId) await tombstoneById(tx, userId, projectId, item.attachmentId);
        await tx.projectSourceItem.deleteMany({ where: { id: item.id, userId, sourceId } });
      });
    },
    async relabelItem(item, file) {
      await withCurrentSource((tx) => tx.projectSourceItem.updateMany({
        where: { id: item.id, userId, sourceId }, data: { name: file.name, path: file.path },
      }));
    },
  };
}

/**
 * One sync of one source, now. Returns null when another sync holds the
 * source (or it is gone). The lease is taken in the WHERE of a single update,
 * so of two callers exactly one wins, and it is always released.
 */
export async function syncProjectSource(userId: string, sourceId: string): Promise<SourceSyncResult | null> {
  const now = new Date();
  const claimed = await prisma.projectSource.updateMany({
    where: {
      id: sourceId,
      userId,
      OR: [{ syncClaimedAt: null }, { syncClaimedAt: { lte: new Date(now.getTime() - SYNC_LEASE_MS) } }],
    },
    data: { syncClaimedAt: now, lastAttemptAt: now, state: "syncing" },
  });
  if (claimed.count !== 1) return null;

  let result: SourceSyncResult | null = null;
  let source: ProjectSource | null = null;
  try {
    source = await prisma.projectSource.findFirst({ where: { id: sourceId, userId, syncClaimedAt: now } });
    if (!source) return null;
    const signal = AbortSignal.timeout(SYNC_BUDGET_MS);
    let client: FirstPartyClient;
    try {
      client = await openDrive(userId, signal);
    } catch (error) {
      const failure = classifyDriveFailure(error, source.name);
      result = {
        state: "error",
        errorCode: failure.code,
        error: error instanceof SourceSyncError && error.code !== "not_connected" && error.code !== "reconnect" ? error.message : failure.message,
        name: source.name,
        fileCount: source.fileCount,
        skippedCount: source.skippedCount,
        truncated: source.truncated,
        added: 0,
        updated: 0,
        removed: 0,
      };
      return result;
    }
    const plan = await getUserPlan(userId);
    result = await runSourceSync({
      client,
      source: { kind: source.kind === "file" ? "file" : "folder", externalId: source.externalId, name: source.name, includeSubfolders: source.includeSubfolders },
      port: prismaPort(source, now, client, plan, signal),
    });
    return result;
  } catch (error) {
    console.error("[project-sources] sync crashed", { sourceId, error: error instanceof Error ? error.name : typeof error });
    result = {
      state: "error",
      errorCode: "provider_error",
      error: sourceErrorMessage("provider_error", source?.name ?? "this source"),
      name: source?.name ?? "",
      fileCount: source?.fileCount ?? 0,
      skippedCount: source?.skippedCount ?? 0,
      truncated: source?.truncated ?? false,
      added: 0,
      updated: 0,
      removed: 0,
    };
    return result;
  } finally {
    // The listing reached Drive (whatever the files then did) → it counts as a
    // sync. A source Drive refused keeps the time of its last good one.
    const listed = result !== null && (result.state === "ready" || result.errorCode === "capacity" || result.errorCode === "library_full");
    const settled = await prisma.projectSource
      .updateMany({
        where: { id: sourceId, userId, syncClaimedAt: now },
        data: {
          syncClaimedAt: null,
          ...(result
            ? {
                state: result.state,
                errorCode: result.errorCode,
                error: result.error,
                name: result.name || undefined,
                fileCount: result.fileCount,
                skippedCount: result.skippedCount,
                truncated: result.truncated,
                ...(listed ? { lastSyncedAt: new Date() } : {}),
              }
            : { state: "error" }),
        },
      })
      .catch(() => undefined);
    if (settled?.count && result && (result.added || result.updated || result.removed)) {
      // The project's own `updatedAt` is its "last activity" on the list.
      await prisma.project.updateMany({ where: { id: source?.projectId ?? "", userId }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }
  }
}

/**
 * Syncs these sources after the response. Never throws: outside a request
 * (a script, a test) there is no `after` to run them in, and a page view or a
 * chat turn must not fail because a background sync could not be queued.
 */
export function scheduleSourceSync(userId: string, sourceIds: readonly string[]): boolean {
  if (!sourceIds.length) return false;
  try {
    after(async () => {
      for (const sourceId of sourceIds) {
        await syncProjectSource(userId, sourceId).catch((error) => {
          console.error("[project-sources] background sync failed", { sourceId, error: error instanceof Error ? error.name : typeof error });
        });
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Queues a sync for each of the project's sources whose last attempt is older
 * than SOURCE_STALE_MS. Called when the project page loads its sources and
 * when a chat turn in the project starts, so a folder is fresh wherever it is
 * being used, without a timer running for projects nobody opens.
 */
export async function scheduleStaleSourceSyncs(userId: string, projectId: string): Promise<string[]> {
  try {
    if (!isGoogleDriveFilesEnabled()) return [];
    const ids = await dueSourceIds(userId, projectId);
    return scheduleSourceSync(userId, ids) ? ids : [];
  } catch {
    return [];
  }
}

/** The project's sources a page view or a chat turn should sync now (see scheduleStaleSourceSyncs). */
export async function dueSourceIds(userId: string, projectId: string, now: number = Date.now()): Promise<string[]> {
  const staleBefore = new Date(now - SOURCE_STALE_MS);
  const due = await prisma.projectSource.findMany({
    where: {
      userId,
      projectId,
      OR: [
        { syncClaimedAt: { lte: new Date(now - SYNC_LEASE_MS) } },
        {
          syncClaimedAt: null,
          AND: [
            { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: staleBefore } }] },
            // An idle source waiting on the person is retried by Sync now.
            { OR: [{ errorCode: null }, { errorCode: { notIn: ["not_connected", "reconnect"] } }] },
          ],
        },
      ],
    },
    select: { id: true },
    take: 10,
  });
  return due.map((row) => row.id);
}

/** Which of the project's attachments a source mirrors, so the page can draw them under it. */
export async function sourceIdsByAttachment(userId: string, attachmentIds: readonly string[]): Promise<Map<string, string>> {
  if (!attachmentIds.length) return new Map();
  const items = await prisma.projectSourceItem.findMany({
    where: { userId, attachmentId: { in: [...attachmentIds] } },
    select: { attachmentId: true, sourceId: true },
  });
  return new Map(items.filter((item) => item.attachmentId).map((item) => [item.attachmentId as string, item.sourceId]));
}
