import "server-only";
/**
 * Deep Research's own sources, bound to the real stores (the rules are in
 * `private-retrieval-core.ts`).
 *
 * - What is OFFERED is computed from what the person actually has: files in
 *   this conversation, the conversation's project, an indexed library, saved
 *   memories (only while memory is on), and linked calendar and mail
 *   connectors that are configured and not blocked in their settings.
 * - Every read is owner-scoped: Prisma calls carry `userId` (the ownership
 *   guard's rule), the knowledge index's raw SQL scopes chunks and documents
 *   by `userId`, and connectors resolve through `getActiveConnectors` with the
 *   person's own linked credentials.
 * - Connector calls go through the same toolset chat uses, `unattended`, so
 *   the approval policy, the blocked-connector list, lockdown and the audit
 *   trail all apply unchanged; only tools the toolset classifies as reads are
 *   ever called.
 */
import { prisma } from "@/lib/prisma";
import { retrieveAttachmentKnowledge, retrieveKnowledge, retrieveProjectKnowledge } from "@/lib/knowledge/retrieve";
import { getMemoryProfile, loadBackgroundProviderPolicy } from "@/lib/memory";
import { getActiveConnectors, openMcpToolset } from "@/lib/mcp";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import {
  type PrivateRetrievalPorts,
  type PrivatePassage,
  searchPrivateSourcesWith,
} from "@/lib/research/private-retrieval-core";
import { DEFAULT_ON_KINDS, type PrivateSourceKind, type PrivateSourceOption } from "@/lib/research/private-sources";
import type { ResearchDeps } from "@/lib/research/stages/types";

/** The connectors a run knows how to search read-only, and as what. */
const SEARCHABLE_CONNECTORS: Record<string, { kind: Extract<PrivateSourceKind, "calendar" | "mail">; label: string }> = {
  "apple-calendar": { kind: "calendar", label: "Apple Calendar" },
  "apple-mail": { kind: "mail", label: "Apple Mail" },
};

const RETRIEVABLE = ["ready", "degraded"];

function option(kind: PrivateSourceKind, extra: Partial<PrivateSourceOption> = {}): PrivateSourceOption {
  return { key: extra.connectorId ? `${kind}:${extra.connectorId}` : kind, kind, defaultOn: DEFAULT_ON_KINDS.has(kind), ...extra };
}

/** What this person could let the run read, from where they are asking. */
export const privateSourceOptionsFor: NonNullable<ResearchDeps["privateSourceOptions"]> = async ({ userId, conversationId }) => {
  const conversation = conversationId
    ? await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true, projectId: true } })
    : null;
  const [chatFiles, project, projectFiles, libraryDocs, settings, memories, connections] = await Promise.all([
    conversation
      ? prisma.attachment.count({ where: { userId, conversationId: conversation.id, deletedAt: null } })
      : Promise.resolve(0),
    conversation?.projectId
      ? prisma.project.findFirst({ where: { id: conversation.projectId, userId }, select: { id: true, name: true } })
      : Promise.resolve(null),
    conversation?.projectId
      ? prisma.knowledgeDocument.count({
          where: { userId, projectId: conversation.projectId, state: { in: RETRIEVABLE }, deletedAt: null, supersededById: null },
        })
      : Promise.resolve(0),
    prisma.knowledgeDocument.count({ where: { userId, state: { in: RETRIEVABLE }, deletedAt: null, supersededById: null } }),
    prisma.settings.findUnique({ where: { userId }, select: { memoryEnabled: true, blockedConnectors: true } }),
    prisma.memoryEntry.count({ where: { userId, kind: "FACT" } }),
    prisma.connection.findMany({
      where: { userId, provider: { in: Object.keys(SEARCHABLE_CONNECTORS) } },
      select: { provider: true },
    }),
  ]);
  const options: PrivateSourceOption[] = [];
  if (chatFiles > 0) options.push(option("file", { count: chatFiles }));
  if (project && projectFiles > 0) options.push(option("project", { label: project.name, count: projectFiles }));
  if (libraryDocs > 0) options.push(option("library", { count: libraryDocs }));
  if ((settings?.memoryEnabled ?? true) && memories > 0) options.push(option("memory"));
  const blocked = new Set(settings?.blockedConnectors ?? []);
  for (const { provider } of connections) {
    const known = SEARCHABLE_CONNECTORS[provider];
    const def = getConnector(provider);
    if (!known || !def || !isConnectorConfigured(def) || blocked.has(provider)) continue;
    options.push(option(known.kind, { connectorId: provider, label: known.label }));
  }
  return options;
};

function toPassages(passages: ReadonlyArray<{ documentId: string; fileName: string; ordinal: number; text: string; locator: string; documentAt: Date }>): PrivatePassage[] {
  return passages.map((p) => ({
    documentId: p.documentId,
    fileName: p.fileName,
    ordinal: p.ordinal,
    text: p.text,
    locator: p.locator,
    documentAt: p.documentAt,
  }));
}

/** The production ports: the knowledge index, memory and the connector toolset. */
export function productionPrivatePorts(): PrivateRetrievalPorts {
  return {
    async chatFiles({ userId, conversationId, query, signal }) {
      const files = await prisma.attachment.findMany({
        where: { userId, conversationId, deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      if (files.length === 0) return [];
      const found = await retrieveAttachmentKnowledge({
        userId,
        attachmentIds: files.map((file) => file.id),
        query,
        policy: await loadBackgroundProviderPolicy(userId),
        signal,
      });
      return found ? toPassages(found.passages) : [];
    },
    async project({ userId, conversationId, query, signal }) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { projectId: true } });
      if (!conversation?.projectId) return [];
      const found = await retrieveProjectKnowledge({
        userId,
        projectId: conversation.projectId,
        query,
        policy: await loadBackgroundProviderPolicy(userId),
        signal,
      });
      return found ? toPassages(found.passages) : [];
    },
    async library({ userId, query, signal }) {
      const found = await retrieveKnowledge({ userId, query, policy: await loadBackgroundProviderPolicy(userId), signal, limit: 8 });
      return toPassages(found.passages);
    },
    async memory({ userId, query }) {
      const settings = await prisma.settings.findUnique({ where: { userId }, select: { memoryEnabled: true } });
      if (settings && !settings.memoryEnabled) return [];
      const profile = await getMemoryProfile(userId, { query, budgetTokens: 1_200 });
      return profile.recent;
    },
    async openConnector({ userId, runId, conversationId, connectorId, timeZone }) {
      if (!SEARCHABLE_CONNECTORS[connectorId]) return null;
      const active = await getActiveConnectors(userId, [connectorId], { timeZone });
      if (active.length === 0) return null;
      const toolset = await openMcpToolset(active, {
        userId,
        conversationId,
        surface: "research",
        sessionId: `research-${runId}`,
        // Nobody is watching a research run: an action that would need a
        // person's approval is refused at once rather than left waiting.
        unattended: true,
      });
      let ordinal = 0;
      return {
        isRead: (tool) => toolset.tools.some((t) => t.function.name === tool) && toolset.accessFor(tool) === "read",
        async call(tool, args, signal) {
          if (toolset.accessFor(tool) !== "read") return { ok: false, body: "" };
          ordinal += 1;
          const result = await toolset.execute(tool, args, signal, `research-${runId}-${tool}-${ordinal}`);
          return { ok: result.ok, body: result.body };
        },
        close: () => toolset.close(),
      };
    },
  };
}

/** `ResearchDeps.searchPrivate` for the app. */
export const searchPrivateSources: NonNullable<ResearchDeps["searchPrivate"]> = async (input) =>
  searchPrivateSourcesWith(productionPrivatePorts(), {
    userId: input.userId,
    runId: input.runId,
    conversationId: input.conversationId,
    options: input.options,
    enabled: input.selection.enabled,
    questions: input.questions,
    timeZone: input.timeZone,
    signal: input.signal,
  });
