import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";
import { cloneLibraryAttachments } from "@/lib/library-attach";

export const runtime = "nodejs";

const bodySchema = z.object({
  attachmentIds: z.array(z.string().cuid()).min(1).max(10),
});

// Attach existing Library files to a new message. Each selected attachment is
// cloned into a fresh, unlinked row (messageId/conversationId/projectId = null)
// that reuses the SAME stored object — no re-upload, no byte duplication. The
// clone then flows through the normal send path (which links messageId:null
// attachments), so the original message keeps its own attachment intact.
//
// The clone itself lives in src/lib/library-attach.ts, shared with a file
// token in a chat message, which clones straight onto the message it names.
// Only the user's own attachments still in their Library are cloned,
// de-duplicated, order preserved.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const { clones } = await prisma.$transaction((tx) => cloneLibraryAttachments(tx, user.id, parsed.data.attachmentIds));
  if (clones.length === 0) return NextResponse.json({ error: "No matching files." }, { status: 404 });

  const attachments = await Promise.all(clones.map(serializeAttachment));
  return NextResponse.json({ attachments }, { status: 201 });
}
