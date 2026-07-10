import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { createShare, listShares, serializeShare } from "@/lib/share";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shares = await listShares(user.id);
  return NextResponse.json({ shares: shares.map(serializeShare) });
}

const createSchema = z
  .object({
    kind: z.enum(["CHAT", "ARTIFACT"]),
    conversationId: z.string().cuid().optional(),
    artifactId: z.string().cuid().optional(),
  })
  .refine((d) => (d.kind === "CHAT" ? !!d.conversationId : !!d.artifactId), {
    message: "Target id is required",
  });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { kind, conversationId, artifactId } = parsed.data;
  const targetId = kind === "CHAT" ? conversationId! : artifactId!;

  // createShare owner-checks the target and reuses the newest active link.
  const share = await createShare(user.id, kind, targetId);
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ share: serializeShare(share) });
}
