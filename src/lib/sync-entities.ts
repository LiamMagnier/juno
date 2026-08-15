import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { coerceChatOrigin } from "@/lib/chat-origin";
import { parseWorkspaceConfig } from "@/lib/projects/workspace-config";
import { getViewUrl } from "@/lib/storage";
import type { EntityIndexCursor } from "@/lib/sync-entity-index";

/*
 * Entity hydration for the native sync contract (GET /api/v1/entities): given
 * a change-feed entityType and a batch of ids, return the current owner-scoped
 * state of each entity. The type strings here must match the change feed
 * exactly — they are the TG_ARGV[0] names the change-capture triggers write
 * (prisma/migrations/20260716200000_account_change_log + later trigger
 * migrations), which is what a client reads back from /api/v1/changes.
 */

export const MAX_ENTITY_IDS = 100;

import {
  buildEntityEnvelopes,
  type EntityData,
  type EntityEnvelope,
} from "@/lib/sync-entity-envelope";
import {
  serializeApproval,
  serializeArtifact,
  serializeGrantForRemote,
  serializeHost,
  serializeRun,
  serializeSession,
} from "@/lib/work/serializers";
import { serializeSchedule } from "@/lib/work/schedule";
import { serializeSkill, serializeSkillVersion } from "@/lib/work/skills";

/**
 * Adapts a serializer's return value to `EntityData`.
 *
 * TypeScript will not assign an `interface` to `Record<string, unknown>` even
 * when every one of its properties satisfies it, and the Work wire shapes are
 * declared as interfaces. The alternative is copying their field lists into
 * this file, which would mean two places that decide what leaves the server —
 * and one of them, `serializeGrantForRemote`, exists precisely so there is only
 * one. The cast is the cheaper of the two mistakes.
 */
function entityData(value: object): EntityData {
  return { ...value } as EntityData;
}

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
          // The prompt-cache split of `promptTokens`. Carried here for the same
          // reason as `costMicroUsd`: the native clients cannot derive it — it
          // is a provider-reported measurement, not a calculation — and without
          // it a synced transcript can only show the cache ratio for turns
          // generated in the current session on that device.
          //
          // null means UNKNOWN (row predates the columns, or the provider
          // reports no cache buckets). Passed through as null rather than 0 so
          // the client can keep telling the two apart.
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          // The exact cost written at generation time, in micro-USD. The native
          // clients cannot derive this: their model manifest carries a price
          // *tier* ("premium"/"economy"), not per-token rates, and recomputing
          // from token counts alone drops cache writes and web-search fees — the
          // same under-reporting `serializeMessage` avoids by preferring this
          // column. Without it the phone can show a model name and nothing else
          // where the browser shows a price.
          costMicroUsd: row.costMicroUsd,
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
    const rows = await prisma.attachment.findMany({ where: { id: { in: ids }, userId: accountId, deletedAt: null } });
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
  // The custom-assistant half of a project: persona name, tool whitelist,
  // knowledge-file selection, preferred model. A separate entity from `project`
  // so a config edit on one device and a rename on another get independent
  // revisions and cannot conflict — see the model comment in schema.prisma.
  //
  // `config` is passed through as the stored object, NOT flattened into named
  // fields. Flattening is where "inherits the account's tools" and "allowed no
  // tools" become the same payload: the first has no `allowedTools` key, the
  // second has an empty array, and any shape that materialises a default for a
  // missing key erases that difference on the way to the client.
  project_workspace: async (accountId, ids) => {
    const rows = await prisma.projectWorkspace.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          projectId: row.projectId,
          config: parseWorkspaceConfig(row.config),
          // Rides alongside so a client reading a payload written by a newer
          // build can tell "a shape I only half understand" from "corrupt".
          configVersion: row.configVersion,
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

  // -------------------------------------------------------------------------
  // Juno Work
  //
  // Work was the one product on a different contract. Chat and Code sync
  // through cursors, revisions and tombstones; Work was reachable only by
  // polling `/api/work/*`, so a task started on the Mac reached the phone when
  // the phone next asked, a task deleted on the phone stayed on the Mac until
  // something refetched, and nothing about a Work row could survive an offline
  // period. Sixteen `Work*` models had neither a loader here nor a
  // change-capture trigger, which is why none of them could ever appear in
  // `/api/v1/changes`.
  //
  // Every payload is built by the same serializer the REST routes use, not by
  // a second copy of the field list. That matters most for `work_file_grant`:
  // `serializeGrantForRemote` is the single place in the codebase where a
  // stored path is *not* added to a response, and a hand-written loader here
  // would be a second disclosure rule to keep in step with it — which is the
  // shape of mistake that puts /Users/<name>/Downloads on a phone.
  //
  // Four models are deliberately NOT here. `WorkEvent` has its own SSE
  // transport with a per-run `seq` cursor, and a row per token-step in the
  // account change feed would swamp every other entity a client is waiting on;
  // `WorkCommand` is relay control plane, leased and host-addressed, and a
  // replayed command is a command executed twice; `WorkRunIO` is provenance
  // only meaningful beside the artifact version it points at, and no client
  // reads it; `WorkAuditEvent` is the security log, deliberately outliving the
  // session it describes and deliberately not a user-facing surface.
  work_session: async (accountId, ids) => {
    const rows = await prisma.workSession.findMany({
      where: { id: { in: ids }, userId: accountId, deletedAt: null },
    });
    return new Map(rows.map((row) => [row.id, entityData(serializeSession(row))]));
  },
  work_run: async (accountId, ids) => {
    const rows = await prisma.workRun.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(rows.map((row) => [row.id, entityData(serializeRun(row))]));
  },
  work_approval: async (accountId, ids) => {
    const rows = await prisma.workApproval.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(rows.map((row) => [row.id, entityData(serializeApproval(row))]));
  },
  work_artifact: async (accountId, ids) => {
    const rows = await prisma.workArtifact.findMany({
      where: { id: { in: ids }, userId: accountId, deletedAt: null },
    });
    return new Map(rows.map((row) => [row.id, entityData(serializeArtifact(row))]));
  },
  // No owner column of its own; ownership is the head row's, enforced in the
  // query rather than checked afterwards. `storageKey` is dropped: it is an
  // object-storage address, and the only sanctioned way to the bytes is the
  // download route, which re-checks `contentHash` before serving them.
  work_artifact_version: async (accountId, ids) => {
    const rows = await prisma.workArtifactVersion.findMany({
      where: { id: { in: ids }, artifact: { userId: accountId } },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          artifactId: row.artifactId,
          version: row.version,
          byteSize: row.byteSize,
          contentHash: row.contentHash,
          origin: row.origin,
          provenance: row.provenance,
          provenanceVersion: row.provenanceVersion,
          validation: row.validation,
          runId: row.runId,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  work_host: async (accountId, ids) => {
    const rows = await prisma.workHost.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(rows.map((row) => [row.id, entityData(serializeHost(row))]));
  },
  // `serializeGrantForRemote`, never `serializeGrantForHost`. A synced entity is
  // by definition on every signed-in device, including the phone, so this is the
  // one loader where reaching for the unqualified serializer would be wrong even
  // though it compiles.
  work_file_grant: async (accountId, ids) => {
    const rows = await prisma.workFileGrant.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        entityData({ ...serializeGrantForRemote(row), sessionId: row.sessionId, createdAt: row.createdAt.toISOString() }),
      ]),
    );
  },
  // One row per app a single task may reach. Its own entity rather than an
  // array on `work_session` for the reason the join table exists at all: a
  // grant has to be individually revocable, and an array column cannot carry
  // when it was made. Absence of rows still does not mean "chose none" — that
  // distinction lives in `WorkSession.connectorsChosen`, which is why the
  // session payload carries it too.
  work_session_connector: async (accountId, ids) => {
    const rows = await prisma.workSessionConnector.findMany({
      where: { id: { in: ids }, userId: accountId },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          sessionId: row.sessionId,
          connectorId: row.connectorId,
          createdAt: row.createdAt.toISOString(),
        },
      ]),
    );
  },
  work_skill: async (accountId, ids) => {
    const rows = await prisma.workSkill.findMany({
      where: { id: { in: ids }, userId: accountId, deletedAt: null },
    });
    return new Map(rows.map((row) => [row.id, entityData(serializeSkill(row))]));
  },
  work_skill_version: async (accountId, ids) => {
    const rows = await prisma.workSkillVersion.findMany({
      where: { id: { in: ids }, skill: { userId: accountId } },
    });
    return new Map(rows.map((row) => [row.id, entityData(serializeSkillVersion(row))]));
  },
  // Triggers are NOT embedded here, unlike the REST shape a client gets from
  // `/api/work/schedules`. A synced entity has one revision, and an embedded
  // trigger edit would either have to bump the schedule's revision from a
  // different table's trigger — which resurrects a schedule tombstoned in the
  // same cascade — or change nothing and never reach the client. The same
  // normalisation `artifact`/`artifact_version` already uses.
  work_schedule: async (accountId, ids) => {
    const rows = await prisma.workSchedule.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => {
        const { triggers: _normalisedIntoOwnEntity, ...schedule } = serializeSchedule(row, []);
        return [row.id, entityData(schedule)];
      }),
    );
  },
  work_trigger: async (accountId, ids) => {
    const rows = await prisma.workTrigger.findMany({ where: { id: { in: ids }, userId: accountId } });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          scheduleId: row.scheduleId,
          kind: row.kind,
          config: row.config,
          configVersion: row.configVersion,
          enabled: row.enabled,
          lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
          dedupeWindowSec: row.dedupeWindowSec,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          // `lastEventKey`, `cursor` and `lastPollError` are absent for the
          // reason `serializeSchedule` omits them: the first two are a
          // producer's handle on somebody's specific email or calendar entry,
          // and shipping either tells every device which message a trigger last
          // matched.
        },
      ]),
    );
  },
};

export const SYNC_ENTITY_TYPES = Object.keys(loaders);

export function isSyncEntityType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(loaders, type);
}

export type { EntityEnvelope, EntityRevisionRow, EntityData } from "@/lib/sync-entity-envelope";
export { buildEntityEnvelopes } from "@/lib/sync-entity-envelope";

export type EntityIndexItem = {
  type: string;
  id: string;
  revision: number;
};

/**
 * Enumerates the complete live, owner-scoped entity set using a stable keyset.
 * Payloads remain in loadEntities(); this inventory exists only so a fresh or
 * compacted client can discover the ids it must hydrate.
 */
export async function listEntityIndex(
  accountId: string,
  after: EntityIndexCursor | null,
  limit: number,
): Promise<{ items: EntityIndexItem[]; hasMore: boolean }> {
  const rows = await prisma.entityRevision.findMany({
    where: {
      accountId,
      deletedAt: null,
      entityType: { in: SYNC_ENTITY_TYPES },
      ...(after ? {
        OR: [
          { entityType: { gt: after.type } },
          { entityType: after.type, entityId: { gt: after.id } },
        ],
      } : {}),
    },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }],
    take: limit + 1,
    select: { entityType: true, entityId: true, revision: true },
  });
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((row) => ({
      type: row.entityType,
      id: row.entityId,
      revision: row.revision,
    })),
    hasMore,
  };
}

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
      select: { entityId: true, revision: true, deletedAt: true, updatedAt: true },
    }),
  ]);
  return buildEntityEnvelopes(type, ids, data, revisions);
}
