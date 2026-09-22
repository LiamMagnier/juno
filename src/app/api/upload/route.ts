import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isStorageAvailable } from "@/lib/env";
import { buildObjectKey, deleteObject, putObject } from "@/lib/storage";
import { isAcceptedUpload } from "@/lib/uploads";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import { scheduleIngest } from "@/lib/knowledge";
import { serializeAttachment } from "@/lib/serializers";
import { isOwnerEmail } from "@/lib/owner";
import { assertLibraryCapacity, libraryCapacity, lockedLibraryCapacity, LibraryQuotaExceededError } from "@/lib/library";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isStorageAvailable()) {
    return NextResponse.json({ error: "File uploads are not available — configure a storage bucket." }, { status: 503 });
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `upload:${user.id}`, limit: 60, windowSec: 3600 });
    if (!limit.success) return NextResponse.json({ error: "Upload limit reached. Try again later." }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const conversationId = (form?.get("conversationId") as string) || undefined;
  const projectId = (form?.get("projectId") as string) || undefined;

  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });

  const mime = file.type || "application/octet-stream";
  if (!isAcceptedUpload(file.name || "file", mime)) {
    return NextResponse.json({ error: `Unsupported file type: ${mime || "unknown"}.` }, { status: 415 });
  }

  const plan = await getUserPlan(user.id);
  const maxBytes = PLANS[plan].maxUploadMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `File is too large. Your plan allows up to ${PLANS[plan].maxUploadMb} MB.` },
      { status: 413 }
    );
  }

  // Verify the conversation belongs to the user if provided.
  if (conversationId) {
    const convo = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id } });
    if (!convo) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  if (projectId) {
    const proj = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!proj) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Shared with /api/v1/attachments. These are security rules — magic-byte
  // sniffing, the neutral stored type, the attachment disposition — and having
  // one copy is the point: two copies means only one of them gets fixed.
  const planned = planAttachmentUpload({
    declaredMime: mime,
    fileName: file.name || "file",
    size: file.size,
    bytes,
    maxUploadMb: PLANS[plan].maxUploadMb,
  });
  if (!planned.ok) {
    return NextResponse.json({ error: planned.error.message }, { status: planned.error.status });
  }
  const capacity = await libraryCapacity(user.id, plan, file.size);
  if (!capacity.allowed) {
    return NextResponse.json(
      {
        error: "Library storage limit reached.",
        code: "LIBRARY_QUOTA_EXCEEDED",
        usedBytes: capacity.usedBytes,
        quotaBytes: capacity.quotaBytes,
        remainingBytes: capacity.remainingBytes,
      },
      { status: 413 },
    );
  }
  const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } =
    planned.plan;

  const key = buildObjectKey(user.id, fileName);
  let transactionCommitted = false;
  let attachment;
  try {
    await putObject(key, bytes, storedContentType, contentDisposition);

    attachment = await prisma.$transaction(async (tx) => {
      const lockedCapacity = await lockedLibraryCapacity(tx, user.id, plan, bytes.byteLength);
      assertLibraryCapacity(lockedCapacity);
      const created = await tx.attachment.create({
        data: {
          userId: user.id,
          conversationId: conversationId ?? null,
          projectId: projectId ?? null,
          kind,
          fileName,
          mimeType: storedMime,
          size: file.size,
          storageKey: key,
          extractedText,
          origin: "upload",
          parserState: "queued",
        },
      });
      await tx.attachmentVersion.create({
        data: {
          attachmentId: created.id,
          version: created.version,
          origin: "upload",
          kind,
          fileName,
          mimeType: storedMime,
          size: file.size,
          storageKey: key,
          extractedText,
          parserState: "queued",
        },
      });
      return created;
    });
    transactionCommitted = true;
  } catch (error) {
    if (!transactionCommitted) await deleteObject(key).catch(() => undefined);
    if (error instanceof LibraryQuotaExceededError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "LIBRARY_QUOTA_EXCEEDED",
          usedBytes: error.capacity.usedBytes,
          quotaBytes: error.capacity.quotaBytes,
          remainingBytes: error.capacity.remainingBytes,
        },
        { status: 413 },
      );
    }
    throw error;
  }


  /*
   * NOTHING IS READ HERE. THE UPLOAD STORES BYTES.
   *
   * This used to schedule structured extraction the moment a file landed, and
   * that eagerness was the source of the whole class of bug this route kept
   * producing. A parser ran minutes before anybody asked a question, decided
   * there and then what the file contained, and its verdict became permanent:
   * a PDF it misjudged was "COULDN'T READ THIS FILE" for good, a format it had
   * no reader for was refused outright, and a single NUL byte in one block
   * failed the insert for the entire document. The person was told their file
   * was unreadable before they had asked anything about it.
   *
   * Reading now happens when the question does — see `ensureAttachmentText` in
   * the chat route, which extracts on the first turn that actually needs text
   * and caches the result. And the model can go further on its own: it has
   * `read_document` to page through a file, `inspect_image` to crop and
   * magnify, and `code_interpreter` to write Python against the bytes where a
   * sandbox is configured. That is what the other assistants do, and it is
   * strictly better than guessing at upload time, because by then there is a
   * question to read the file *for*.
   *
   * A PROJECT FILE IS THE EXCEPTION, and it is a different feature wearing the
   * same route. A project knowledge base exists to be searched across many
   * documents at once, which is what an index is actually good at, and the
   * person opted into that by filing the document there. `scheduleIngest`
   * enforces the distinction itself so no upload path can get it wrong.
   */
  scheduleIngest({
    userId: user.id,
    attachmentId: attachment.id,
    projectId: projectId ?? null,
    fileName,
    mimeType: storedMime,
    bytes,
  });

  return NextResponse.json({ attachment: await serializeAttachment(attachment) }, { status: 201 });
}
