import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { libraryViewWhere } from "@/lib/library-removal-policy";
import { listConnectors, isConnectorConfigured } from "@/lib/connectors";
import { COMPOSIO_APP_PREFIX } from "@/lib/composio";
import { isComposioConfigured } from "@/lib/env";
import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import { actionPolicyFromSetting } from "@/lib/chat/app-approval-preview";
import { connectHrefFor, connectorsWithStandingGrants } from "@/lib/chat/app-connector-state";
import { contextTokenLabel, type ContextTokenKind } from "@/lib/chat/context-tokens";
import { appMentionCandidates } from "@/lib/mentions/apps";
import { rankMentions, type MentionCandidate } from "@/lib/mentions/rank";
import {
  fileIconKey,
  fileSubtitle,
  type MentionSearchResult,
} from "@/lib/mentions/types";

/**
 * The mention palette's reads: one owner-scoped, indexed query per kind, in
 * parallel, each capped, then ranked together (src/lib/mentions/rank.ts).
 *
 * Why not unified search (src/lib/search): that is full-text over content,
 * with snippets and coverage reports, for ⌘K. The palette matches NAMES of
 * seven kinds, two of which (crew, apps) unified search does not cover, and
 * it runs on every keystroke. So each kind is a name filter on the account's
 * own rows — `userId` first in every where, on the indexes each table already
 * has — fetching a few times the limit so ranking has something to choose
 * between, and nothing else.
 *
 * Every where clause below names the account directly (an artifact through
 * its own owner, src/lib/artifact-access.ts, so one whose chat was deleted is
 * still offered and one in Recently deleted is not): the ownership guard in
 * src/lib/db.ts would refuse a query that did not, and
 * tests/mentions-route.test.ts reads them back.
 */

export interface MentionSearchInput {
  userId: string;
  query: string;
  kinds: readonly ContextTokenKind[];
  limitPerKind: number;
  /** Exact lookups instead of a name filter (`ids=`). */
  ids?: ReadonlyArray<{ kind: ContextTokenKind; id: string }>;
  /** Leave this chat out of the chat rows (a chat cannot usefully name itself). */
  excludeConversationId?: string | null;
}

/** Rows fetched per kind for ranking: enough for a prefix match to beat a recent substring. */
function fetchSize(limit: number): number {
  return Math.min(40, Math.max(limit * 4, limit));
}

function contains(query: string): Prisma.StringFilter | undefined {
  return query ? { contains: query, mode: "insensitive" } : undefined;
}

export async function searchMentions(input: MentionSearchInput): Promise<MentionSearchResult> {
  const { userId, limitPerKind } = input;
  const query = input.query.trim();
  const take = fetchSize(limitPerKind);
  const byIds = input.ids && input.ids.length > 0;
  const idsOf = (kind: ContextTokenKind) => (input.ids ?? []).filter((ref) => ref.kind === kind).map((ref) => ref.id);
  const wants = (kind: ContextTokenKind) => input.kinds.includes(kind) && (!byIds || idsOf(kind).length > 0);
  const name = contains(query);

  const [crew, files, projects, apps, skills, chats, artifacts] = await Promise.all([
    wants("crew")
      ? prisma.agent.findMany({
          where: {
            userId,
            deletedAt: null,
            ...(byIds ? { id: { in: idsOf("crew") } } : name ? { OR: [{ name }, { role: name }] } : {}),
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          take,
          select: { id: true, name: true, role: true, avatar: true, status: true, updatedAt: true },
        })
      : [],
    wants("file")
      ? prisma.attachment.findMany({
          where: {
            userId,
            ...libraryViewWhere("library"),
            ...(byIds ? { id: { in: idsOf("file") } } : name ? { fileName: name } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true },
        })
      : [],
    wants("project")
      ? prisma.project.findMany({
          where: { userId, ...(byIds ? { id: { in: idsOf("project") } } : name ? { name } : {}) },
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, name: true, updatedAt: true },
        })
      : [],
    wants("app") ? appRows(userId, byIds ? new Set(idsOf("app")) : undefined) : [],
    wants("skill")
      ? prisma.workSkill.findMany({
          where: {
            userId,
            deletedAt: null,
            kind: "skill",
            enabled: true,
            ...(byIds ? { id: { in: idsOf("skill") } } : name ? { OR: [{ name }, { slug: name }] } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, slug: true, name: true, description: true, updatedAt: true },
        })
      : [],
    wants("chat")
      ? prisma.conversation.findMany({
          where: {
            userId,
            kind: "chat",
            ...(byIds ? { id: { in: idsOf("chat") } } : name ? { title: name } : {}),
            ...(input.excludeConversationId && !byIds ? { NOT: { id: input.excludeConversationId } } : {}),
          },
          orderBy: { lastMessageAt: "desc" },
          take,
          select: { id: true, title: true, lastMessageAt: true, archivedAt: true, projectId: true },
        })
      : [],
    wants("artifact")
      ? prisma.artifact.findMany({
          where: ownedArtifactWhere(userId, byIds ? { id: { in: idsOf("artifact") } } : name ? { title: name } : {}),
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, title: true, type: true, updatedAt: true, conversation: { select: { title: true } } },
        })
      : [],
  ]);

  const candidates: MentionCandidate[] = [
    ...crew.map((agent): MentionCandidate => ({
      item: {
        kind: "crew",
        id: agent.id,
        label: tokenLabel(agent.name, "Agent"),
        ...(agent.role.trim() ? { subtitle: agent.role.trim() } : {}),
        icon: "crew",
        avatar: normalizeAgentAvatar(agent.avatar, agent.id),
        ...(agent.status !== "active" ? { paused: true } : {}),
        updatedAt: agent.updatedAt.toISOString(),
      },
      alternates: agent.role ? [agent.role] : [],
      boost: agent.status === "active" ? 3 : 0,
    })),
    ...files.map((file): MentionCandidate => {
      const icon = fileIconKey(file.mimeType, file.fileName);
      const subtitle = fileSubtitle(icon);
      return {
        item: {
          kind: "file",
          id: file.id,
          label: tokenLabel(file.fileName, "Untitled file"),
          ...(subtitle ? { subtitle } : {}),
          icon,
          mimeType: file.mimeType,
          size: file.size,
          updatedAt: file.createdAt.toISOString(),
        },
      };
    }),
    ...projects.map((project): MentionCandidate => ({
      item: {
        kind: "project",
        id: project.id,
        label: tokenLabel(project.name, "Untitled project"),
        icon: "project",
        updatedAt: project.updatedAt.toISOString(),
      },
    })),
    ...apps,
    ...skills.map((skill): MentionCandidate => ({
      item: {
        kind: "skill",
        id: skill.id,
        label: tokenLabel(skill.name, skill.slug),
        ...(skill.description.trim() ? { subtitle: clip(skill.description.trim(), 120) } : {}),
        icon: "skill",
        slug: skill.slug,
        updatedAt: skill.updatedAt.toISOString(),
      },
      alternates: [skill.slug],
    })),
    ...chats.map((chat): MentionCandidate => ({
      item: {
        kind: "chat",
        id: chat.id,
        label: tokenLabel(chat.title, "Untitled chat"),
        icon: "chat",
        projectId: chat.projectId,
        updatedAt: chat.lastMessageAt.toISOString(),
      },
      // An archived chat is still nameable, just behind a live one.
      boost: chat.archivedAt ? -5 : 0,
    })),
    ...artifacts.map((artifact): MentionCandidate => ({
      item: {
        kind: "artifact",
        id: artifact.id,
        label: tokenLabel(artifact.title, "Untitled artifact"),
        // The chat it was made in; a detached artifact (its chat deleted, or a
        // New design) has none.
        ...(artifact.conversation?.title ? { subtitle: artifact.conversation.title } : {}),
        icon: `artifact:${artifact.type.toLowerCase()}`,
        updatedAt: artifact.updatedAt.toISOString(),
      },
    })),
  ];

  // Exact lookups are answers, not matches: every one found comes back.
  const ranked = rankMentions(candidates, byIds ? "" : query, byIds ? Number.MAX_SAFE_INTEGER : limitPerKind);
  return { query, kinds: [...input.kinds], items: ranked };
}

async function appRows(userId: string, only?: ReadonlySet<string>): Promise<MentionCandidate[]> {
  const [settings, connections, servers, granted] = await Promise.all([
    prisma.settings.findUnique({
      where: { userId },
      select: { actionApprovalPolicy: true, lockdownMode: true, blockedConnectors: true },
    }),
    prisma.connection.findMany({
      where: { userId },
      select: { provider: true, accountLabel: true, scope: true, createdAt: true },
    }),
    prisma.userMcpServer.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, enabled: true, url: true, createdAt: true },
    }),
    connectorsWithStandingGrants(userId, only ? [...only] : undefined),
  ]);
  return appMentionCandidates({
    registry: listConnectors().map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description,
      configured: isConnectorConfigured(def),
      connectHref: connectHrefFor(def.id),
    })),
    connections,
    servers,
    composio: { configured: isComposioConfigured(), prefix: COMPOSIO_APP_PREFIX, activeScope: "composio:active" },
    approvals: {
      policy: actionPolicyFromSetting(settings?.actionApprovalPolicy),
      lockdown: !!settings?.lockdownMode,
      blockedConnectors: settings?.blockedConnectors ?? [],
      grantedConnectors: granted,
    },
    only,
  });
}

/**
 * A row's label is the words its token will write into the sentence, so it is
 * the token label (one line, bounded) the request schema accepts; a name that
 * cleans to nothing gets a plain noun rather than a chip with no words.
 */
function tokenLabel(name: string, fallback: string): string {
  return contextTokenLabel(name) || contextTokenLabel(fallback) || "Untitled";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
