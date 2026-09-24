import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { restoreShare } from "@/lib/share-moderation";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const share = await restoreShare({ shareId: id, by: owner.email! });
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });
  console.log(`[admin] share restore by ${owner.id}: ${id}`);
  return NextResponse.json({ share });
}
