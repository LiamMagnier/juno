import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isFirstPartyId } from "@/lib/first-party-connectors/providers";
import { syncFirstParty } from "@/lib/first-party-connectors/sync-store";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isFirstPartyId(id)) return NextResponse.json({ error: "Unknown app" }, { status: 404 });
  const body = z.strictObject({ stream: z.string().min(1).max(256).default("primary") }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid sync request" }, { status: 400 });
  const limit = await rateLimit({ key: `connector-sync:${user.id}:${id}`, limit: 30, windowSec: 60 });
  if (!limit.success) return NextResponse.json({ error: "Try again in a minute" }, { status: 429 });
  try { return NextResponse.json(await syncFirstParty(user.id, id, body.data.stream), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Could not sync this app. Reconnect it and try again." }, { status: 502 }); }
}
