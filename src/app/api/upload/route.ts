import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isStorageAvailable } from "@/lib/env";
import { buildObjectKey, putObject } from "@/lib/storage";
import { isAcceptedMime, attachmentKind, isTextExtractable, sniffImageMime, sanitizeFileName } from "@/lib/uploads";
import { serializeAttachment } from "@/lib/serializers";
import { isOwnerEmail } from "@/lib/owner";

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
  if (!isAcceptedMime(mime)) {
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
  const fileName = sanitizeFileName(file.name || "file");
  let kind = attachmentKind(mime);

  // Images: verify magic bytes and use the *detected* type. Everything else is
  // stored as a neutral type and forced to download, so uploaded HTML/scripts
  // can never be rendered inline (stored-XSS / phishing prevention).
  let storedType = "application/octet-stream";
  let storedMime = mime;
  let disposition: string | undefined = `attachment; filename="${fileName}"`;
  if (kind === "IMAGE") {
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) {
      return NextResponse.json({ error: "That file isn't a valid image." }, { status: 415 });
    }
    storedType = sniffed;
    storedMime = sniffed;
    kind = "IMAGE";
    disposition = undefined; // inline so thumbnails render
  }

  const key = buildObjectKey(user.id, fileName);
  await putObject(key, bytes, storedType, disposition);

  let extractedText: string | null = null;
  if (isTextExtractable(storedMime) && file.size < 1_000_000) {
    try {
      extractedText = new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 200_000);
    } catch {
      extractedText = null;
    }
  }

  const attachment = await prisma.attachment.create({
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
    },
  });

  return NextResponse.json({ attachment: await serializeAttachment(attachment) }, { status: 201 });
}
