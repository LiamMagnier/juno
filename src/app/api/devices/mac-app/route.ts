import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { loadMacAppPresence } from "@/lib/mac-app-presence";

export const runtime = "nodejs";

/**
 * GET: whether the signed-in account has used the Mac app in the last 30
 * days, `{ installed, lastSeenAt }`. Read by "Open in Mac app" on the web to
 * decide between opening the app and the download page
 * (src/lib/mac-app-presence.ts). Nothing about the Mac itself (its name, its
 * version) leaves the server: only whether there is one, and when.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const presence = await loadMacAppPresence(user.id);
  return NextResponse.json(presence, { headers: { "Cache-Control": "private, no-store" } });
}
