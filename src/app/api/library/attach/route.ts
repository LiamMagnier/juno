import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";

export const runtime = "nodejs";

const bodySchema = z.object({
  attachmentIds: z.array(z.string().cuid()).min(1).max(10),
});

// Attach existing Library files to a new message. Each selected attachment is
// cloned into a fresh, unlinked row (messageId/conversationId/projectId = null)
// that reuses the SAME stored object — no re-upload, no byte duplication. The
// clone then flows through the normal send path (which links messageId:null
// attachments), so the original message keeps its own attachment intact.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  // Only the user's own attachments, de-duplicated, order preserved.
  const uniqueIds = [...new Set(parsed.data.attachmentIds)];
  const sources = await prisma.attachment.findMany({
    where: { id: { in: uniqueIds }, userId: user.id },
  });
  if (sources.length === 0) return NextResponse.json({ error: "No matching files." }, { status: 404 });
  const byId = new Map(sources.map((a) => [a.id, a]));

  const clones = await prisma.$transaction(
    uniqueIds
      .filter((id) => byId.has(id))
      .map((id) => {
        const src = byId.get(id)!;
        return prisma.attachment.create({
          data: {
            userId: user.id,
            kind: src.kind,
            fileName: src.fileName,
            mimeType: src.mimeType,
            size: src.size,
            storageKey: src.storageKey,
            extractedText: src.extractedText,
            width: src.width,
            height: src.height,
          },
        });
      })
  );

  const attachments = await Promise.all(clones.map(serializeAttachment));
  return NextResponse.json({ attachments }, { status: 201 });
}
