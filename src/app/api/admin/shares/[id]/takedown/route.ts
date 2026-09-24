import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { isOwnerEmail } from "@/lib/owner";
import { takeDownShare } from "@/lib/share-moderation";
import { shareTakedownSchema } from "@/lib/share-schemas";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = shareTakedownSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A reason of 3–500 characters is required." }, { status: 400 });
  }

  const { id } = await params;
  const result = await takeDownShare({
    shareId: id,
    reason: parsed.data.reason,
    banOwner: parsed.data.banOwner,
    by: owner.email!,
    isProtectedOwner: (u) => u.id === owner.id || isOwnerEmail(u.email),
  });
  if (!result.ok) {
    return result.error === "not_found"
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ error: "This link belongs to an owner account, which can’t be banned." }, { status: 400 });
  }
  // Ids, not emails — see the note in the unban route.
  console.log(`[admin] share takedown by ${owner.id}: ${id}${parsed.data.banOwner ? " (owner banned)" : ""}`);
  return NextResponse.json({ share: result.share });
}
