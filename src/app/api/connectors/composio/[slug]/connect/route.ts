import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { env, isComposioConfigured } from "@/lib/env";
import {
  isComposioOperationBusyError,
  isComposioSlug,
  startComposioAppConnection,
} from "@/lib/composio";
import { checkComposioRateLimit } from "@/lib/composio-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

function back(params: Record<string, string>) {
  const url = new URL("/connections", env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", env.appUrl));
  if (!isComposioConfigured()) return back({ error: "not_configured" });
  const { slug } = await params;
  if (!isComposioSlug(slug)) return back({ error: "unknown" });
  const limit = await checkComposioRateLimit("connect", user.id);
  if (!limit.success) return back({ error: "rate_limited" });
  try {
    const result = await startComposioAppConnection(user.id, slug);
    if (result.connected) return back({ connected: slug });
    return NextResponse.redirect(result.redirectUrl);
  } catch (err) {
    console.error("[composio] connect failed", slug, err instanceof Error ? err.message : err);
    return back({ error: isComposioOperationBusyError(err) ? "connection_busy" : "exchange_failed" });
  }
}
