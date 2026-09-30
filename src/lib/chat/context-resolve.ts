import "server-only";
import { prisma } from "@/lib/prisma";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { decryptMessageText } from "@/lib/message-crypto";
import { decryptJsonField } from "@/lib/field-crypto";
import { libraryViewWhere } from "@/lib/library-removal-policy";
import { appConnectorStates } from "@/lib/chat/app-connector-state";
import { parseWorkspaceConfig } from "@/lib/projects/workspace-config";
import { loadBackgroundProviderPolicy, type BackgroundProviderSettings } from "@/lib/memory";
import { retrieveAttachmentKnowledge, retrieveProjectKnowledge } from "@/lib/knowledge/retrieve";
import {
  buildProjectContext,
  buildProjectReferenceFiles,
  type ProjectKnowledge,
} from "@/lib/chat/context-assembly";
import {
  contextReceiptFromActivity,
  contextTokensFromReceipt,
  type ContextToken,
} from "@/lib/chat/context-tokens";
import type {
  ContextAgentRow,
  ContextArtifactRow,
  ContextConversationRow,
  ContextLibraryFile,
  ContextPort,
  ContextProjectRow,
  ContextSection,
  ContextSkillRow,
} from "@/lib/chat/context-resolution";

/**
 * The database side of context-token resolution: every read the pure
 * resolver (src/lib/chat/context-resolution.ts) makes, scoped to one account.
 *
 * The user id is bound once, here, and every query below filters on it — the
 * same construction as the chat route's recovery port, which is what makes a
 * cross-account read something you would have to go out of your way to write.
 * Each lookup is by primary key within the account (`id IN (...) AND userId`),
 * so the cost is a handful of indexed reads per turn.
 */

const EXCERPT_MESSAGES = 12;
const EXCERPT_MESSAGE_CHARS = 800;

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface ContextPortOptions {
  userId: string;
  /** The Settings row the route already holds, for the background-provider policy. */
  settings?: BackgroundProviderSettings | null;
  /** The provider this turn runs on: `same_provider` retrieval matches it. */
  conversationProvider?: string | null;
}

export function prismaContextPort(options: ContextPortOptions): ContextPort {
  const { userId } = options;
  return {
    async libraryFiles(ids): Promise<ContextLibraryFile[]> {
      if (ids.length === 0) return [];
      return prisma.attachment.findMany({
        where: { id: { in: ids }, userId, ...libraryViewWhere("library") },
        select: { id: true, fileName: true, kind: true },
      });
    },

    async skills(ids): Promise<ContextSkillRow[]> {
      if (ids.length === 0) return [];
      // `kind: "skill"`: an assistant shares the table and its slugs, and is
      // not something a message arms — exactly as loadChatSkill reads it.
      return prisma.workSkill.findMany({
        where: { id: { in: ids }, userId, deletedAt: null, kind: "skill" },
        select: { id: true, slug: true, name: true },
      });
    },

    apps: (ids) => appConnectorStates(userId, ids),

    async projects(ids): Promise<ContextProjectRow[]> {
      if (ids.length === 0) return [];
      return prisma.project.findMany({ where: { id: { in: ids }, userId }, select: { id: true, name: true } });
    },

    async projectSection(project, query, maxChars): Promise<ContextSection> {
      const [row, workspace] = await Promise.all([
        prisma.project.findFirst({
          where: { id: project.id, userId },
          select: { name: true, instructions: true, files: { select: { id: true, fileName: true, extractedText: true } } },
        }),
        prisma.projectWorkspace.findFirst({ where: { projectId: project.id, userId }, select: { config: true } }),
      ]);
      if (!row) return { text: "", untrusted: false };
      // The mentioned project's own assistant setup, read the way the route
      // reads the conversation's: its name, its instructions, its knowledge.
      const config = parseWorkspaceConfig(workspace?.config);
      const selected = workspace ? (config.knowledgeFileIds ?? []) : undefined;
      const source = {
        name: config.personaName ?? row.name,
        instructions: config.instructionsOverride ?? row.instructions,
        files: selected === undefined ? row.files : row.files.filter((file) => selected.includes(file.id)),
      };
      let knowledge: ProjectKnowledge | null = null;
      if (query.trim() && (selected === undefined || selected.length > 0)) {
        try {
          const retrievalOptions = {
            userId,
            query,
            policy: await loadBackgroundProviderPolicy(userId, options.settings),
            conversationProvider: options.conversationProvider ?? null,
          };
          // The same split the route makes for the chat's own project: every
          // indexed project file, or only the assistant's chosen knowledge.
          const retrieved =
            selected === undefined
              ? await retrieveProjectKnowledge({ ...retrievalOptions, projectId: project.id })
              : await retrieveAttachmentKnowledge({ ...retrievalOptions, attachmentIds: selected });
          if (retrieved && retrieved.passages.length > 0) {
            knowledge = {
              passages: retrieved.passages,
              indexedFileNames: retrieved.indexedFileNames,
              degraded: retrieved.mode === "lexical",
            };
          }
        } catch (error) {
          console.error("[chat:context] project knowledge retrieval failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const context = buildProjectContext(source, knowledge);
      const files = buildProjectReferenceFiles(source, knowledge);
      const text = bounded([context, files].filter(Boolean).join("\n\n"), maxChars);
      return { text, untrusted: (knowledge?.passages.length ?? 0) > 0 || files !== "" };
    },

    async conversations(ids): Promise<ContextConversationRow[]> {
      if (ids.length === 0) return [];
      // Chats only: a Code session's transcript is a run log, and it has its
      // own surface.
      return prisma.conversation.findMany({
        where: { id: { in: ids }, userId, kind: "chat" },
        select: { id: true, title: true },
      });
    },

    async conversationExcerpt(conversation, maxChars): Promise<string> {
      const [memory, recent] = await Promise.all([
        prisma.conversationMemory.findFirst({
          where: { conversationId: conversation.id, userId },
          select: { digest: true },
        }),
        prisma.message.findMany({
          // The turns a person and Juno wrote. A SYSTEM row is never sent to
          // a provider (every adapter skips it), so it is not quoted either.
          where: { conversationId: conversation.id, conversation: { userId }, role: { in: ["USER", "ASSISTANT"] } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: EXCERPT_MESSAGES,
          select: { role: true, content: true },
        }),
      ]);
      const lines: string[] = [];
      let used = 0;
      const head = [`Title: ${conversation.title}`];
      if (memory?.digest?.trim()) head.push(`Summary: ${memory.digest.trim()}`);
      const header = `${head.join("\n")}\n\nLatest messages, oldest first:`;
      used += header.length;
      // Newest first while budgeting, so the most recent turns survive a cut.
      for (const message of recent) {
        const text = (decryptMessageText(message.content) ?? "").trim();
        if (!text) continue;
        const line = `${message.role === "USER" ? "User" : "Assistant"}: ${bounded(text.replace(/\s+/g, " "), EXCERPT_MESSAGE_CHARS)}`;
        if (used + line.length + 1 > maxChars) break;
        used += line.length + 1;
        lines.unshift(line);
      }
      return lines.length ? `${header}\n${lines.join("\n")}` : `${head.join("\n")}\n\n(No messages yet.)`;
    },

    async artifacts(ids): Promise<ContextArtifactRow[]> {
      if (ids.length === 0) return [];
      // The artifact's own owner (DECISIONS D-013, src/lib/artifact-access.ts):
      // one whose chat was deleted is still the person's to name, and one in
      // Recently deleted is not quoted. The body is the sealed head, never a
      // design's unsealed draft.
      const rows = await prisma.artifact.findMany({
        where: ownedArtifactWhere(userId, { id: { in: ids } }),
        select: { id: true, title: true, type: true, currentVersion: true },
      });
      if (rows.length === 0) return [];
      const versions = await prisma.artifactVersion.findMany({
        where: { OR: rows.map((row) => ({ artifactId: row.id, version: row.currentVersion })) },
        select: { artifactId: true, content: true },
      });
      const content = new Map(versions.map((version) => [version.artifactId, version.content]));
      return rows.map((row) => ({ id: row.id, title: row.title, type: row.type, content: content.get(row.id) ?? "" }));
    },

    async agents(ids): Promise<ContextAgentRow[]> {
      if (ids.length === 0) return [];
      return prisma.agent.findMany({
        where: { id: { in: ids }, userId, deletedAt: null },
        select: { id: true, name: true, role: true, instructions: true, status: true },
      });
    },
  };
}

/**
 * The tokens the answer a regenerate replaces was given.
 *
 * A regenerate carries no message, so a web client that did not keep its
 * tokens would otherwise answer again without the files, apps and people the
 * question named. The receipt on the reply being replaced says what they were;
 * each is re-resolved (ownership included) as if sent again. Only applied
 * tokens come back — see `contextTokensFromReceipt`.
 */
export async function regenerateContextTokens(userId: string, conversationId: string): Promise<ContextToken[]> {
  const last = await prisma.message.findFirst({
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    select: { role: true, activity: true },
  });
  if (!last || last.role !== "ASSISTANT") return [];
  const activity = decryptJsonField(last.activity);
  if (!Array.isArray(activity)) return [];
  return contextTokensFromReceipt(contextReceiptFromActivity(activity as { contextReceipt?: unknown }[]));
}
