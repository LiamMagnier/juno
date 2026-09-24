import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { findSharesForAdmin } from "@/lib/share-moderation";

export const runtime = "nodejs";

/** Look links up by share URL or token, account email, or account id. */
export async function GET(req: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length > 512) return NextResponse.json({ error: "Query too long" }, { status: 400 });
  return NextResponse.json({ shares: await findSharesForAdmin(q) });
}
