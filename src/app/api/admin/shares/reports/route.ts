import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { listShareReports } from "@/lib/share-moderation";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const status = url.searchParams.get("status") === "all" ? "all" : "open";
  return NextResponse.json(await listShareReports({ status, page }));
}
