import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getObjectBytes } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";

export const runtime = "nodejs";

/** Restore a prior immutable revision as a new current revision. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, version: rawVersion } = await params;
  const version = Number.parseInt(rawVersion, 10);
  if (!Number.isInteger(version) || version < 1) return NextResponse.json({ error: "Invalid version." }, { status: 400 });

  const attachment = await prisma.attachment.findFirst({ where: { id, userId: user.id } });
  if (!attachment) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  const prior = await prisma.attachmentVersion.findFirst({ where: { attachmentId: id, version } });
  if (!prior) return NextResponse.json({ error: "Version not found." }, { status: 404 });

  let bytes: Uint8Array | null = null;
  if (prior.mimeType !== "image/jpeg" && prior.mimeType !== "image/png" && prior.size <= 64 * 1024 * 1024) {
    try {
      bytes = (await getObjectBytes(prior.storageKey)).bytes;
    } catch {
      return NextResponse.json({ error: "The stored version is unavailable." }, { status: 410 });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.attachment.findFirst({ where: { id, userId: user.id } });
    if (!current) throw new Error("Attachment changed while restoring it.");
    const currentSnapshot = await tx.attachmentVersion.findFirst({ where: { attachmentId: id, version: current.version } });
    if (!currentSnapshot) {
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
        origin: "restore",
        kind: prior.kind,
        fileName: prior.fileName,
        mimeType: prior.mimeType,
        size: prior.size,
        storageKey: prior.storageKey,
        extractedText: prior.extractedText,
        parserState: bytes ? "queued" : "skipped",
        parserVersion: prior.parserVersion,
        deletedAt: null,
      },
    });
  });

  if (bytes) scheduleIngest({ userId: user.id, attachmentId: updated.id, projectId: updated.projectId, fileName: updated.fileName, mimeType: updated.mimeType, bytes });
  return NextResponse.json({ ok: true, version: updated.version, parserState: updated.parserState });
}
