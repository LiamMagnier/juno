import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { coerceChatOrigin } from "@/lib/chat-origin";
import { getViewUrl } from "@/lib/storage";

/*
 * Entity hydration for the native sync contract (GET /api/v1/entities): given
 * a change-feed entityType and a batch of ids, return the current owner-scoped
 * state of each entity. The type strings here must match the change feed
 * exactly — they are the TG_ARGV[0] names the change-capture triggers write
 * (prisma/migrations/20260716200000_account_change_log + later trigger
 * migrations), which is what a client reads back from /api/v1/changes.
 */

export const MAX_ENTITY_IDS = 100;

type EntityData = Record<string, unknown>;

/** Loads owned rows for one entity type, keyed by entity id. Every loader
 *  enforces ownership in the query itself — an id belonging to another
 *  account simply does not resolve. */
type EntityLoader = (accountId: string, ids: string[]) => Promise<Map<string, EntityData>>;

const loaders: Record<string, EntityLoader> = {
  // The profile entity id is the account id itself (trigger arg 'user').
  profile: async (accountId, ids) => {
    if (!ids.includes(accountId)) return new Map();
    const row = await prisma.user.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, email: true, image: true },
    });
    return row ? new Map([[row.id, { ...row }]]) : new Map();
  },
  settings: async (accountId, ids) => {
    const rows = await prisma.settings.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          theme: row.theme,
          accent: row.accent,
          defaultModel: row.defaultModel,
          customInstructions: row.customInstructions,
          responseLanguage: row.responseLanguage,
          uiLocale: row.uiLocale,
          personality: row.personality,
          memoryEnabled: row.memoryEnabled,
          voiceId: row.voiceId,
          favoriteModels: row.favoriteModels,
          emailBudgetAlerts: row.emailBudgetAlerts,
          emailWeeklyDigest: row.emailWeeklyDigest,
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  subscription: async (accountId, ids) => {
    const rows = await prisma.subscription.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          plan: row.plan.toLowerCase(),
          status: row.status.toLowerCase(),
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        },
      ]),
    );
  },
  folder: async (accountId, ids) => {
    const rows = await prisma.folder.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() }]));
  },
  conversation: async (accountId, ids) => {
    const rows = await prisma.conversation.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          titleSource: row.titleSource,
          model: row.model,
          origin: coerceChatOrigin(row.origin),
          kind: row.kind,
          codeWorkspaceName: row.codeWorkspaceName,
          codeWorkspacePath: row.codeWorkspacePath,
          codeWorkspaceKey: row.codeWorkspaceKey,
          pinned: row.pinned,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          folderId: row.folderId,
          projectId: row.projectId,
          forkedFromId: row.forkedFromId,
          activeConnectors: row.activeConnectors,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          lastMessageAt: row.lastMessageAt.toISOString(),
        },
      ]),
    );
  },
  message: async (accountId, ids) => {
    const rows = await prisma.message.findMany({
      where: { id: { in: ids }, conversation: { userId: accountId } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          conversationId: row.conversationId,
          clientId: row.clientId,
          role: row.role,
          content: decryptMessageTextSafe(row.content),
          reasoning: row.reasoning != null ? decryptMessageTextSafe(row.reasoning) : null,
          model: row.model,
          feedback: row.feedback,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  message_version: async (accountId, ids) => {
    const rows = await prisma.messageVersion.findMany({
      where: { id: { in: ids }, message: { conversation: { userId: accountId } } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          messageId: row.messageId,
          content: decryptMessageTextSafe(row.content),
          reasoning: row.reasoning != null ? decryptMessageTextSafe(row.reasoning) : null,
          model: row.model,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  attachment: async (accountId, ids) => {
    const rows = await prisma.attachment.findMany({ where: { id: { in: ids }, userId: accountId } });
    const entries = await Promise.all(
      rows.map(async (row): Promise<[string, EntityData]> => [
        row.id,
        {
          id: row.id,
          conversationId: row.conversationId,
          messageId: row.messageId,
          projectId: row.projectId,
          kind: row.kind,
          fileName: row.fileName,
          mimeType: row.mimeType,
          size: row.size,
          width: row.width,
          height: row.height,
          url: await getViewUrl(row.storageKey),
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
    return new Map(entries);
  },
  artifact: async (accountId, ids) => {
    const rows = await prisma.artifact.findMany({
      where: { id: { in: ids }, conversation: { userId: accountId } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          conversationId: row.conversationId,
          messageId: row.messageId,
          identifier: row.identifier,
          title: row.title,
          type: row.type,
          language: row.language,
          currentVersion: row.currentVersion,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  artifact_version: async (accountId, ids) => {
    const rows = await prisma.artifactVersion.findMany({
      where: { id: { in: ids }, artifact: { conversation: { userId: accountId } } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          artifactId: row.artifactId,
          version: row.version,
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  project: async (accountId, ids) => {
    const rows = await prisma.project.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          nameSource: row.nameSource,
          instructions: row.instructions,
          starred: row.starred,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  memory: async (accountId, ids) => {
    const rows = await prisma.memoryEntry.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          content: row.content,
          source: row.source,
          kind: row.kind,
          sourceRef: row.sourceRef,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  saved_prompt: async (accountId, ids) => {
    const rows = await prisma.savedPrompt.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          body: row.body,
          useCount: row.useCount,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  // Deliberately excludes every credential column (tokens are encrypted at
  // rest and never leave the server).
  connection: async (accountId, ids) => {
    const rows = await prisma.connection.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          provider: row.provider,
          accountLabel: row.accountLabel,
          scope: row.scope,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  usage: async (accountId, ids) => {
    const rows = await prisma.usage.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          period: row.period,
          messageCount: row.messageCount,
          promptTokens: row.promptTokens.toString(),
          completionTokens: row.completionTokens.toString(),
        },
      ]),
    );
  },
  share: async (accountId, ids) => {
    const rows = await prisma.share.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          token: row.token,
          kind: row.kind,
          conversationId: row.conversationId,
          artifactId: row.artifactId,
          title: row.title,
          snapshotAt: row.snapshotAt.toISOString(),
          views: row.views,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  announcement_dismissal: async (accountId, ids) => {
    const rows = await prisma.announcementDismissal.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, announcementId: row.announcementId, dismissedAt: row.dismissedAt.toISOString() },
      ]),
    );
  },
  scheduled_task: async (accountId, ids) => {
    const rows = await prisma.scheduledTask.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          prompt: row.prompt,
          model: row.model,
          cadence: row.cadence,
          hour: row.hour,
          minute: row.minute,
          weekday: row.weekday,
          monthday: row.monthday,
          timezone: row.timezone,
          webSearch: row.webSearch,
          enabled: row.enabled,
          lastRunAt: row.lastRunAt?.toISOString() ?? null,
          nextRunAt: row.nextRunAt.toISOString(),
          conversationId: row.conversationId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  code_device: async (accountId, ids) => {
    const rows = await prisma.codeDevice.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          platform: row.platform,
          workspaces: row.workspaces,
          lastSeenAt: row.lastSeenAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  code_task: async (accountId, ids) => {
    const rows = await prisma.codeTask.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          deviceId: row.deviceId,
          workspacePath: row.workspacePath,
          workspaceName: row.workspaceName,
          workspaceKey: row.workspaceKey,
          title: row.title,
          prompt: row.prompt,
          status: row.status,
          lastSeq: row.lastSeq,
          conversationId: row.conversationId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
  code_task_event: async (accountId, ids) => {
    const rows = await prisma.codeTaskEvent.findMany({
      where: { id: { in: ids }, task: { userId: accountId } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          taskId: row.taskId,
          seq: row.seq,
          kind: row.kind,
          payload: row.payload,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  code_workspace: async (accountId, ids) => {
    const rows = await prisma.codeWorkspace.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          path: row.path,
          key: row.key,
          lastOpenedAt: row.lastOpenedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      ]),
    );
  },
};

export const SYNC_ENTITY_TYPES = Object.keys(loaders);

export function isSyncEntityType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(loaders, type);
}

export type EntityEnvelope = {
  type: string;
  id: string;
  revision: number;
  deletedAt: string | null;
  data: EntityData | null;
};

/**
 * Hydrate a batch of entities of one type. Ids resolve in request order;
 * revisions come from EntityRevision (0 for rows that predate change capture).
 * Tombstoned entities return revision + deletedAt with `data: null`; ids that
 * never existed under this account (or belong to someone else) are omitted.
 */
export async function loadEntities(accountId: string, type: string, ids: string[]): Promise<EntityEnvelope[]> {
  const loader = loaders[type];
  if (!loader) throw new Error(`unknown entity type: ${type}`);
  const [data, revisions] = await Promise.all([
    loader(accountId, ids),
    prisma.entityRevision.findMany({
      where: { accountId, entityType: type, entityId: { in: ids } },
      select: { entityId: true, revision: true, deletedAt: true },
    }),
  ]);
  const revisionById = new Map(revisions.map((row) => [row.entityId, row]));
  const entities: EntityEnvelope[] = [];
  for (const id of ids) {
    const row = data.get(id) ?? null;
    const revision = revisionById.get(id);
    if (!row && !revision) continue; // unknown or foreign id — nothing to report
    entities.push({
      type,
      id,
      revision: revision?.revision ?? 0,
      deletedAt: row ? null : (revision?.deletedAt?.toISOString() ?? null),
      data: row,
    });
  }
  return entities;
}
