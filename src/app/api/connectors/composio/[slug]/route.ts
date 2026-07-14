import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { disconnectComposioApp, isComposioOperationBusyError, isComposioSlug } from "@/lib/composio";
import { checkComposioRateLimit } from "@/lib/composio-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;
  if (!isComposioSlug(slug)) return NextResponse.json({ error: "Unknown app" }, { status: 404 });
  const limit = await checkComposioRateLimit("disconnect", user.id);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many connection changes. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }
  try {
    await disconnectComposioApp(user.id, slug);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[composio] disconnect failed", slug, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: isComposioOperationBusyError(err) ? "Connection operation in progress" : "Could not disconnect app" },
      { status: isComposioOperationBusyError(err) ? 409 : 502 }
    );
  }
}
