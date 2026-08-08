import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { assertLibraryCapacity, libraryCapacity, lockedLibraryCapacity, LibraryQuotaExceededError } from "@/lib/library";
import { buildObjectKey, deleteObject, getViewUrl, putObject } from "@/lib/storage";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import { scheduleIngest } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 30;

/** List the current file plus immutable prior revisions. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({
    where: { id, userId: user.id },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!attachment) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  const current = {
    version: attachment.version,
    current: true,
    origin: attachment.origin,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    parserState: attachment.parserState,
    createdAt: attachment.createdAt.toISOString(),
    url: await getViewUrl(attachment.storageKey),
  };
  const prior = await Promise.all(
    attachment.versions
      .filter((version) => version.version !== attachment.version)
      .map(async (version) => ({
        version: version.version,
        current: false,
        origin: version.origin,
        fileName: version.fileName,
        mimeType: version.mimeType,
        size: version.size,
        parserState: version.parserState,
        createdAt: version.createdAt.toISOString(),
        url: await getViewUrl(version.storageKey),
      })),
  );
  return NextResponse.json({ versions: [current, ...prior] });
}

/** Replace the current library bytes while preserving the outgoing revision. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id, deletedAt: null } });
  if (!attachment) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No replacement file provided." }, { status: 400 });
  const plan = await getUserPlan(user.id);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const planned = planAttachmentUpload({
    declaredMime: file.type || "application/octet-stream",
    fileName: file.name || attachment.fileName,
    size: file.size,
    bytes,
    maxUploadMb: PLANS[plan].maxUploadMb,
  });
  if (!planned.ok) return NextResponse.json({ error: planned.error.message }, { status: planned.error.status });
  const capacity = await libraryCapacity(user.id, plan, file.size);
  if (!capacity.allowed) return NextResponse.json({ error: "Library storage limit reached.", code: "LIBRARY_QUOTA_EXCEEDED" }, { status: 413 });

  const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } = planned.plan;
  const key = buildObjectKey(user.id, fileName);
  let transactionCommitted = false;
  let updated;
  try {
    await putObject(key, bytes, storedContentType, contentDisposition);

    updated = await prisma.$transaction(async (tx) => {
      const lockedCapacity = await lockedLibraryCapacity(tx, user.id, plan, bytes.byteLength);
      assertLibraryCapacity(lockedCapacity);
      const current = await tx.attachment.findFirst({ where: { id, userId: user.id, deletedAt: null } });
      if (!current) throw new Error("Attachment changed while replacing it.");
      const prior = await tx.attachmentVersion.findFirst({ where: { attachmentId: id, version: current.version } });
      if (!prior) {
        await tx.attachmentVersion.create({
          data: {
            attachmentId: id,
            version: current.version,
            origin: current.origin,
            kind: current.kind,
            fileName: current.fileName,
            mimeType: current.mimeType,
            size: current.size,
            storageKey: current.storageKey,
            extractedText: current.extractedText,
            parserState: current.parserState,
            parserVersion: current.parserVersion,
          },
        });
      }
      return tx.attachment.update({
        where: { id, userId: user.id },
        data: {
          version: { increment: 1 },
          origin: "replacement",
          kind,
          fileName,
          mimeType: storedMime,
          size: file.size,
          storageKey: key,
          extractedText,
          parserState: "queued",
          parserVersion: null,
        },
      });
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

  scheduleIngest({ userId: user.id, attachmentId: updated.id, projectId: updated.projectId, fileName, mimeType: storedMime, bytes });
  return NextResponse.json({ ok: true, version: updated.version, url: await getViewUrl(updated.storageKey) });
}
