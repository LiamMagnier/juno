import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import {
  clearPendingComposioApp,
  completeComposioAppConnection,
  isComposioSlug,
  isComposioOperationBusyError,
  isTerminalComposioConnectionError,
} from "@/lib/composio";
import { env } from "@/lib/env";
import { checkComposioRateLimit } from "@/lib/composio-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

function back(params: Record<string, string>) {
  const url = new URL("/connections", env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", env.appUrl));
  const { slug } = await params;
  if (!isComposioSlug(slug)) return back({ error: "unknown" });
  const query = new URL(req.url).searchParams;
  const flowId = query.get("flow") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(flowId)) return back({ error: "bad_state" });
  const limit = await checkComposioRateLimit("callback", user.id);
  if (!limit.success) return back({ error: "rate_limited" });
  const status = query.get("status");
  if (status && status !== "success") {
    await clearPendingComposioApp(user.id, slug, flowId).catch((cleanupError) => {
      console.error(
        "[composio] denied callback cleanup failed",
        slug,
        cleanupError instanceof Error ? cleanupError.message : cleanupError
      );
    });
    return back({ error: "denied" });
  }
  try {
    await completeComposioAppConnection(user.id, slug, flowId);
    return back({ connected: slug });
  } catch (err) {
    console.error("[composio] callback failed", slug, err instanceof Error ? err.message : err);
    if (isTerminalComposioConnectionError(err)) {
      await clearPendingComposioApp(user.id, slug, flowId).catch((cleanupError) => {
        console.error(
          "[composio] terminal callback cleanup failed",
          slug,
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        );
      });
    }
    return back({ error: isComposioOperationBusyError(err) ? "connection_busy" : "exchange_failed" });
  }
}
