import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { isStorageAvailable } from "@/lib/env";
import { getObjectBytes } from "@/lib/storage";

export const runtime = "nodejs";

/** Hard cap on exported message rows — keeps the response to a few MB at most. */
const MAX_MESSAGE_ROWS = 50_000;

/**
 * RFC 4180 quoting, plus CSV-injection neutralization: a leading =, +, -, @,
 * tab or CR is prefixed with a single quote so spreadsheet apps do not evaluate
 * attacker-influenceable message text as a formula (CWE-1236).
 */
function csvField(value: string | null | undefined): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * GDPR data export. `GET` returns the full account snapshot as JSON;
 * `?format=csv` returns the message history as a CSV instead. `?format=juno`
 * stamps the JSON as the open, versioned Juno interchange format so it can be
 * uploaded back through /api/import.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `export:${user.id}`, limit: 5, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many exports — try again later." }, { status: 429 });
  }

  const requestedFormat = new URL(req.url).searchParams.get("format");
  const format = requestedFormat === "csv" ? "csv" : requestedFormat === "juno" ? "juno" : "json";
  const isJuno = format === "juno";
  const date = new Date().toISOString().slice(0, 10);

  const [account, plan, settings, conversations, rawMessages, memories, memorySummary, projects, attachments, spendTotals, spendByKind] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, createdAt: true } }),
      getUserPlan(user.id),
      prisma.settings.findUnique({
        where: { userId: user.id },
        select: {
          theme: true,
          accent: true,
          defaultModel: true,
          customInstructions: true,
          responseLanguage: true,
          uiLocale: true,
          personality: true,
          memoryEnabled: true,
          voiceId: true,
          favoriteModels: true,
          backgroundProviderMode: true,
          backgroundProviderSelected: true,
          emailBudgetAlerts: true,
          emailWeeklyDigest: true,
          actionApprovalPolicy: true,
          lockdownMode: true,
          blockedConnectors: true,
          monthlySpendCapEur: true,
          spendCapDisabled: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.conversation.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          titleSource: true,
          clientRequestId: true,
          model: true,
          kind: true,
          origin: true,
          projectId: true,
          forkedFromId: true,
          codeWorkspaceName: true,
          codeWorkspacePath: true,
          codeWorkspaceKey: true,
          pinned: true,
          archivedAt: true,
          activeConnectors: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.message.findMany({
        where: { conversation: { userId: user.id } },
        orderBy: { createdAt: "asc" },
        take: MAX_MESSAGE_ROWS + 1,
        select: {
          id: true,
          conversationId: true,
          clientId: true,
          role: true,
          content: true,
          reasoning: true,
          reasoningParts: true,
          model: true,
          feedback: true,
          promptTokens: true,
          completionTokens: true,
          costMicroUsd: true,
          sources: true,
          activity: true,
          createdAt: true,
          attachments: { select: { id: true } },
        },
      }),
      prisma.memoryEntry.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          content: true,
          source: true,
          kind: true,
          category: true,
          projectId: true,
          sourceRef: true,
          sourceMessageId: true,
          confidence: true,
          status: true,
          reason: true,
          expiresAt: true,
          lastUsedAt: true,
          lastVerifiedAt: true,
          supersededById: true,
          normalized: true,
          importSourceId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.memorySummary.findUnique({
        where: { userId: user.id },
        select: { content: true, entryCount: true, createdAt: true, updatedAt: true },
      }),
      prisma.project.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          nameSource: true,
          instructions: true,
          starred: true,
          workDefaults: true,
          workDefaultsVersion: true,
          importSourceId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.attachment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          conversationId: true,
          messageId: true,
          projectId: true,
          fileName: true,
          mimeType: true,
          kind: true,
          size: true,
          width: true,
          height: true,
          storageKey: true,
          extractedText: true,
          idempotencyKey: true,
          version: true,
          origin: true,
          parserState: true,
          parserVersion: true,
          deletedAt: true,
          createdAt: true,
          versions: {
            orderBy: { version: "asc" },
            select: {
              version: true,
              origin: true,
              kind: true,
              fileName: true,
              mimeType: true,
              size: true,
              storageKey: true,
              parserState: true,
              parserVersion: true,
              extractedText: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.apiSpend.aggregate({
        where: { userId: user.id },
        _count: true,
        _sum: { promptTokens: true, completionTokens: true, costMicroUsd: true },
      }),
      prisma.apiSpend.groupBy({
        by: ["kind"],
        where: { userId: user.id },
        _count: true,
        _sum: { costMicroUsd: true },
      }),
    ]);

  const truncated = rawMessages.length > MAX_MESSAGE_ROWS;
  const messages = (truncated ? rawMessages.slice(0, MAX_MESSAGE_ROWS) : rawMessages).map((m) => ({
    ...m,
    content: decryptMessageTextSafe(m.content),
    reasoning: decryptMessageTextSafe(m.reasoning),
    reasoningParts: Array.isArray(m.reasoningParts)
      ? m.reasoningParts.filter((part): part is string => typeof part === "string").map((part) => decryptMessageTextSafe(part))
      : null,
  }));

  if (format === "csv") {
    const titleById = new Map(conversations.map((c) => [c.id, c.title]));
    const lines = ["conversation,role,model,content,createdAt"];
    for (const m of messages) {
      lines.push(
        [
          csvField(titleById.get(m.conversationId)),
          csvField(m.role),
          csvField(m.model),
          csvField(m.content),
          csvField(m.createdAt.toISOString()),
        ].join(",")
      );
    }
    return new NextResponse(lines.join("\r\n") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="juno-export-${date}.csv"`,
      },
    });
  }

  const byConversation = new Map<string, object[]>();
  const stableConversationId = new Map(
    conversations.map((conversation) => [
      conversation.id,
      conversation.clientRequestId?.startsWith("juno:") ? conversation.clientRequestId.slice("juno:".length) : conversation.id,
    ]),
  );
  const stableProjectId = new Map(
    projects.map((project) => [
      project.id,
      project.importSourceId?.startsWith("juno:") ? project.importSourceId.slice("juno:".length) : project.id,
    ]),
  );
  const stableAttachmentId = new Map(
    attachments.map((attachment) => [
      attachment.id,
      attachment.idempotencyKey?.startsWith("juno:") ? attachment.idempotencyKey.slice("juno:".length) : attachment.id,
    ]),
  );
  const stableMessageId = new Map(
    rawMessages.map((message) => [
      message.id,
      message.clientId?.startsWith("juno:") ? message.clientId.slice("juno:".length) : message.id,
    ]),
  );
  const stableMemoryId = new Map(
    memories.map((memory) => [
      memory.id,
      memory.importSourceId?.startsWith("juno:memory:") ? memory.importSourceId.slice("juno:memory:".length) : memory.id,
    ]),
  );
  for (const m of messages) {
    const row = {
      id: m.id,
      sourceId: m.clientId?.startsWith("juno:") ? m.clientId.slice("juno:".length) : m.id,
      clientId: m.clientId,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      reasoningParts: m.reasoningParts,
      model: m.model,
      feedback: m.feedback,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      costMicroUsd: m.costMicroUsd,
      sources: m.sources,
      activity: m.activity,
      attachmentIds: m.attachments.map((attachment) => stableAttachmentId.get(attachment.id) ?? attachment.id),
      attachmentSourceIds: m.attachments.map((attachment) => stableAttachmentId.get(attachment.id) ?? attachment.id),
      createdAt: m.createdAt,
    };
    const list = byConversation.get(m.conversationId);
    if (list) list.push(row);
    else byConversation.set(m.conversationId, [row]);
  }

  // A Juno package is still open JSON, but it may also carry the actual
  // Library bytes. The cap keeps a forgotten export from becoming an
  // unbounded server-side download; omitted objects remain explicit in the
  // manifest and can be downloaded separately from the source account.
  const MAX_JUNO_ARCHIVE_BYTES = 100 * 1024 * 1024;
  const junoZip = isJuno && isStorageAvailable() ? new JSZip() : null;
  const archivePathByStorageKey = new Map<string, string>();
  let archivedBytes = 0;
  const safeArchiveName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "file";
  const addAttachmentBytes = async (storageKey: string, path: string, declaredSize: number) => {
    if (!junoZip) return null;
    const existing = archivePathByStorageKey.get(storageKey);
    if (existing) return existing;
    if (archivedBytes >= MAX_JUNO_ARCHIVE_BYTES || declaredSize > MAX_JUNO_ARCHIVE_BYTES - archivedBytes) return null;
    try {
      const object = await getObjectBytes(storageKey);
      if (object.bytes.length > MAX_JUNO_ARCHIVE_BYTES - archivedBytes) return null;
      junoZip.file(path, object.bytes);
      archivedBytes += object.bytes.length;
      archivePathByStorageKey.set(storageKey, path);
      return path;
    } catch {
      return null;
    }
  };

  const attachmentItems = [];
  for (const attachment of attachments) {
    const currentPath = `attachments/${attachment.id}/v${attachment.version}-${safeArchiveName(attachment.fileName)}`;
    const currentArchivePath = await addAttachmentBytes(attachment.storageKey, currentPath, attachment.size);
    const priorVersions = [];
    for (const version of attachment.versions) {
      const path = `attachments/${attachment.id}/v${version.version}-${safeArchiveName(version.fileName)}`;
      priorVersions.push({
        version: version.version,
        origin: version.origin,
        kind: version.kind,
        fileName: version.fileName,
        mimeType: version.mimeType,
        size: version.size,
        parserState: version.parserState,
        parserVersion: version.parserVersion,
        extractedText: version.extractedText,
        createdAt: version.createdAt,
        archivePath: await addAttachmentBytes(version.storageKey, path, version.size),
      });
    }
    attachmentItems.push({
      id: stableAttachmentId.get(attachment.id) ?? attachment.id,
      conversationId: attachment.conversationId ? stableConversationId.get(attachment.conversationId) ?? attachment.conversationId : null,
      messageId: attachment.messageId ? stableMessageId.get(attachment.messageId) ?? attachment.messageId : null,
      projectId: attachment.projectId ? stableProjectId.get(attachment.projectId) ?? attachment.projectId : null,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      extractedText: attachment.extractedText,
      idempotencyKey: attachment.idempotencyKey,
      version: attachment.version,
      origin: attachment.origin,
      parserState: attachment.parserState,
      parserVersion: attachment.parserVersion,
      deletedAt: attachment.deletedAt,
      createdAt: attachment.createdAt,
      archivePath: currentArchivePath,
      versions: priorVersions,
    });
  }

  const payload = {
    schemaVersion: isJuno ? "juno.export.v2" : undefined,
    format: isJuno ? "juno" : undefined,
    exportedAt: new Date().toISOString(),
    profile: {
      name: account?.name ?? null,
      email: account?.email ?? user.email ?? null,
      createdAt: account?.createdAt ?? null,
      plan,
    },
    settings,
    memories: memories.map((memory) => ({
      ...memory,
      id: stableMemoryId.get(memory.id) ?? memory.id,
      projectId: memory.projectId ? stableProjectId.get(memory.projectId) ?? memory.projectId : null,
      sourceMessageId: memory.sourceMessageId ? stableMessageId.get(memory.sourceMessageId) ?? memory.sourceMessageId : null,
      supersededById: memory.supersededById ? stableMemoryId.get(memory.supersededById) ?? memory.supersededById : null,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    })),
    memorySummary,
    projects: projects.map((project) => ({
      ...project,
      id: stableProjectId.get(project.id) ?? project.id,
    })),
    attachments: {
      note: isJuno
        ? "Juno packages include file bytes until the 100 MB archive cap; each omitted archivePath is an explicit unavailable object."
        : "This JSON preserves file metadata and revision history. File bytes remain in the source Library and are not embedded in this JSON export.",
      items: attachmentItems,
    },
    apiSpend: {
      requestCount: spendTotals._count,
      promptTokens: spendTotals._sum.promptTokens ?? 0,
      completionTokens: spendTotals._sum.completionTokens ?? 0,
      totalCostUsd: (spendTotals._sum.costMicroUsd ?? 0) / 1_000_000,
      byKind: spendByKind.map((k) => ({
        kind: k.kind,
        requestCount: k._count,
        costUsd: (k._sum.costMicroUsd ?? 0) / 1_000_000,
      })),
    },
    messagesTruncated: truncated,
    ...(truncated
      ? { truncationNote: `Message export is capped at ${MAX_MESSAGE_ROWS.toLocaleString("en-US")} rows; older messages are included first.` }
      : {}),
    conversations: conversations.map((c) => ({
      id: c.id,
      sourceId: stableConversationId.get(c.id) ?? c.id,
      title: c.title,
      titleSource: c.titleSource,
      clientRequestId: c.clientRequestId,
      model: c.model,
      kind: c.kind,
      origin: c.origin,
      projectId: c.projectId ? stableProjectId.get(c.projectId) ?? c.projectId : null,
      forkedFromId: c.forkedFromId ? stableConversationId.get(c.forkedFromId) ?? c.forkedFromId : null,
      codeWorkspaceName: c.codeWorkspaceName,
      codeWorkspacePath: c.codeWorkspacePath,
      codeWorkspaceKey: c.codeWorkspaceKey,
      pinned: c.pinned,
      archivedAt: c.archivedAt,
      activeConnectors: c.activeConnectors,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: byConversation.get(c.id) ?? [],
    })),
  };

  if (isJuno && junoZip) {
    junoZip.file("juno-export.json", JSON.stringify(payload, null, 2));
    const archive = await junoZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return new NextResponse(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="juno-export-${date}.zip"`,
      },
    });
  }

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="juno-export-${date}.json"`,
    },
  });
}
