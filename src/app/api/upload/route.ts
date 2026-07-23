import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isStorageAvailable } from "@/lib/env";
import { buildObjectKey, putObject } from "@/lib/storage";
import { isAcceptedMime } from "@/lib/uploads";
import { planAttachmentUpload } from "@/lib/attachment-upload";
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
  const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } =
    planned.plan;

  const key = buildObjectKey(user.id, fileName);
  await putObject(key, bytes, storedContentType, contentDisposition);

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
