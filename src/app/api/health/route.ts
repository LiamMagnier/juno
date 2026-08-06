import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { providerHealthSnapshot, ensureProviderHealthFresh } from "@/lib/provider-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness, for an external uptime monitor.
 *
 * PM2 knows the process exists; it does not know the process can serve. This is
 * the endpoint that tells the difference, and the thing every other alert hangs
 * off — nothing else in the deployment currently reports that the app is
 * unhealthy until a user complains.
 *
 * Public payload is deliberately thin: `ok`, `db`, `version`, `uptime`. The
 * per-provider map is reconnaissance (it enumerates which LLM vendors this
 * deployment holds keys for), so it is owner-only, matching the rest of the
 * admin surface. An uptime monitor does not need it.
 *
 * Returns 503 when the database is unreachable so a monitor's default
 * status-code rule catches it without extra configuration.
 */

const startedAt = Date.now();

function version(): string {
  return (
    process.env.GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.npm_package_version ??
    "unknown"
  );
}

async function databaseOk(): Promise<boolean> {
  try {
    // Cheapest possible round trip that proves the pooler and Postgres are both
    // answering. Bounded so a hung database cannot hold the health check open.
    await Promise.race([
      prismaUnguarded.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    return true;
  } catch (err) {
    console.error("[health] database check failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function GET() {
  // Opportunistically refresh stale provider verdicts. Fire-and-forget: a
  // health check must stay fast and must never depend on provider latency.
  ensureProviderHealthFresh();

  const db = (await databaseOk()) ? "ok" : "fail";
  const owner = await getOwnerUser();

  const body: Record<string, unknown> = {
    ok: db === "ok",
    db,
    version: version(),
    uptime: Math.round((Date.now() - startedAt) / 1000),
  };

  if (owner) {
    const providers = providerHealthSnapshot();
    body.providers = Object.fromEntries(
      providers.map((p) => [
        p.provider,
        {
          healthy: p.healthy,
          checkedAt: p.checkedAt,
          ...(p.failure ? { failure: p.failure, detail: p.detail } : {}),
        },
      ])
    );
    body.providersUnhealthy = providers.filter((p) => !p.healthy).map((p) => p.provider);
  }

  return NextResponse.json(body, {
    status: db === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
