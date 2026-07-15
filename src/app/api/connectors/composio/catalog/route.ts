import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { isComposioConfigured } from "@/lib/env";
import { isComposioCategory, listComposioApps, listComposioCategories } from "@/lib/composio";
import { checkComposioRateLimit } from "@/lib/composio-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isComposioConfigured()) return NextResponse.json({ error: "Composio is not configured" }, { status: 503 });
  const limit = await checkComposioRateLimit("catalog", user.id);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many catalog requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, 100);
  const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 300) || undefined;
  const connectedOnly = url.searchParams.get("connected") === "1";
  // An unknown category is dropped rather than rejected: it would reach the API
  // as a filter matching nothing, which reads to the user as a broken directory.
  const requested = url.searchParams.get("category") ?? "";
  const category = isComposioCategory(requested) ? requested : undefined;
  try {
    // The category chips and the items they filter render on the same screen at
    // the same moment, so they ship together: a separate route would add a
    // round-trip, a second auth + rate-limit path and a second failure mode to
    // render, all for a static ~18-entry payload that is already cached
    // server-side and cannot drift from the items beside it.
    const [result, categories] = await Promise.all([
      listComposioApps(user.id, { query, cursor, connectedOnly, limit: 30, category }),
      listComposioCategories(),
    ]);
    return NextResponse.json({ ...result, categories });
  } catch (err) {
    console.error("[composio] catalog failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the Composio catalog" }, { status: 502 });
  }
}
