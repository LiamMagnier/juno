import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnerUser } from "@/lib/admin";
import { dismissShareReport } from "@/lib/share-moderation";

export const runtime = "nodejs";

const bodySchema = z.object({ status: z.literal("dismissed") });

/** Close a report without touching the link. Taking the link down resolves its reports itself. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { id } = await params;
  const found = await dismissShareReport({ reportId: id, by: owner.email! });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
