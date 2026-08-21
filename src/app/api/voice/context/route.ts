import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { evaluateVoiceAccess } from "@/lib/voice-access-policy";
import { loadBackgroundProviderPolicy } from "@/lib/memory";
import { retrieveAttachmentKnowledge } from "@/lib/knowledge/retrieve";
import { buildAttachmentContext } from "@/lib/chat/context-assembly";
import {
  boundVoiceAttachmentContext,
  normalizeVoiceAttachmentIDs,
  normalizeVoiceAttachmentQuery,
  VOICE_ATTACHMENT_LIMIT,
  VOICE_QUERY_MAX_CHARS,
} from "@/lib/voice-attachment-context";

export const runtime = "nodejs";
export const maxDuration = 30;

const inputSchema = z.object({
  attachmentIds: z.array(z.string().cuid()).min(1).max(VOICE_ATTACHMENT_LIMIT),
  query: z.string().max(VOICE_QUERY_MAX_CHARS),
  /** Provider id from the negotiated voice session, used only for policy. */
  provider: z.string().trim().min(1).max(80).optional(),
});

/**
 * Resolves document context for one live voice turn.
 *
 * The attachment query is owner-scoped before knowledge retrieval. A caller
 * cannot use this route as a document oracle: missing, deleted, already
 * claimed, or foreign ids produce one generic conflict response rather than
 * revealing which condition failed.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await evaluateVoiceAccess(user, "context");
  if (!access.allowed && access.denial) {
    return NextResponse.json({ error: access.denial.error }, { status: access.denial.status });
  }

  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid voice attachment context" }, { status: 400 });
  const input = parsed.data;
  const attachmentIds = normalizeVoiceAttachmentIDs(input.attachmentIds);
  const query = normalizeVoiceAttachmentQuery(input.query);
  if (attachmentIds.length === 0 || query.length === 0) {
    return NextResponse.json({ error: "Voice attachment context needs a question." }, { status: 400 });
  }

  const attachments = await prisma.attachment.findMany({
    where: {
      id: { in: attachmentIds },
      userId: user.id,
      messageId: null,
      deletedAt: null,
    },
    select: { id: true, fileName: true, kind: true, parserState: true },
  });
  if (attachments.length !== attachmentIds.length) {
    return NextResponse.json({ error: "One or more voice attachments are unavailable." }, { status: 409 });
  }

  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      userId: user.id,
      attachmentId: { in: attachmentIds },
      deletedAt: null,
      supersededById: null,
    },
    select: { attachmentId: true, fileName: true, state: true },
    orderBy: { version: "desc" },
  });
  const documentByAttachment = new Map<string, (typeof documents)[number]>();
  for (const document of documents) {
    if (document.attachmentId && !documentByAttachment.has(document.attachmentId)) {
      documentByAttachment.set(document.attachmentId, document);
    }
  }

  const pendingFiles: { fileName: string; state: string }[] = [];
  const unavailableFiles: { fileName: string; state: string }[] = [];
  const items = attachments.map((attachment) => {
    // Images travel as JPEG video frames. They still appear in the exact id
    // response and are persisted with the user turn, but do not need document
    // indexing to be useful to the provider.
    if (attachment.kind === "IMAGE") {
      return {
        id: attachment.id,
        fileName: attachment.fileName,
        kind: attachment.kind,
        availability: "ready" as const,
        parserState: attachment.parserState,
      };
    }

    const document = documentByAttachment.get(attachment.id);
    const parserState = document?.state ?? attachment.parserState;
    const availability = document && (document.state === "ready" || document.state === "degraded")
      ? "ready" as const
      : ["queued", "indexing", "extracting", "ocr"].includes(parserState)
        ? "pending" as const
        : "unavailable" as const;
    if (availability === "pending") pendingFiles.push({ fileName: attachment.fileName, state: parserState });
    if (availability === "unavailable") unavailableFiles.push({ fileName: attachment.fileName, state: parserState });
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      kind: attachment.kind,
      availability,
      parserState,
    };
  });

  let retrieved: Awaited<ReturnType<typeof retrieveAttachmentKnowledge>> = null;
  try {
    retrieved = await retrieveAttachmentKnowledge({
      userId: user.id,
      attachmentIds,
      query,
      policy: await loadBackgroundProviderPolicy(user.id),
      conversationProvider: input.provider ?? null,
    });
  } catch (error) {
    // The file state remains truthful even when retrieval's optional semantic
    // leg is unavailable. The caller gets pending/unavailable context instead
    // of a fake successful read.
    console.error("[voice/context] retrieval failed", {
      userId: user.id,
      attachmentCount: attachmentIds.length,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const context = buildAttachmentContext({
    passages: retrieved?.passages ?? [],
    indexedFileNames: retrieved?.indexedFileNames ?? [],
    degraded: retrieved?.mode === "lexical",
    pendingFiles,
    unavailableFiles,
  });
  const bounded = boundVoiceAttachmentContext(context);
  if (!bounded.value) {
    // This is possible for a set containing images only. The image frames are
    // still real context; returning an empty document string is intentional.
    return NextResponse.json({ context: "", attachments: items, truncated: false });
  }
  return NextResponse.json({
    context: bounded.value,
    attachments: items,
    truncated: bounded.truncated,
  });
}
