import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap liveness for an external uptime monitor.
 *
 * PM2 knows the process exists; it does not know the process can serve. This
 * endpoint checks only the database and never authenticates a user, calls a
 * provider, refreshes a cache, or emits an operator alert. Provider readiness
 * is an explicitly requested, owner-gated diagnostic mode below.
 *
 * Public payload is deliberately thin: `ok`, `db`, `version`, `uptime`.
 *
 * Returns 503 when the database is unreachable so a monitor's default
 * status-code rule catches it without extra configuration.
 *
 * For an authenticated operator diagnostic, use one of the explicit query
 * modes `?readiness=1`, `?diagnostic=1`, or the historical `?probe=1` alias.
 * That mode may perform provider probes and send transition alerts; it is not
 * liveness and must never be used as the ordinary uptime check.
 */

const startedAt = Date.now();
const DATABASE_CHECK_TIMEOUT_MS = 1_500;
const DATABASE_TRANSACTION_MAX_WAIT_MS = 250;

function version(): string {
  return (
    process.env.GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.npm_package_version ??
    "unknown"
  );
}

/**
 * The only supported way to opt into provider diagnostics on this route.
 * Keeping the legacy `probe=1` spelling avoids breaking an operator command
 * that followed the old provider-health comment while making the opt-in
 * explicit and exact.
 */
function isDiagnosticHealthRequest(request: Request): boolean {
  const params = new URL(request.url).searchParams;
  return ["readiness", "diagnostic", "probe"].some((key) => params.get(key) === "1");
}

async function databaseOk(): Promise<boolean> {
  try {
    /*
     * Do not use Promise.race here. It abandons the JavaScript wait but leaves
     * the Prisma/Postgres query running, which can occupy a pool connection
     * after the monitor has already received 503. A short-lived interactive
     * transaction gives Postgres a statement-level cancellation boundary and
     * Prisma a transaction/connection-acquisition deadline.
     *
     * `set_config(..., true)` is transaction-local, so this cannot leak a
     * statement timeout into an application connection after the check ends.
     */
    await prismaUnguarded.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${DATABASE_CHECK_TIMEOUT_MS}ms`}, true)`;
        await tx.$queryRaw`SELECT 1`;
      },
      {
        maxWait: DATABASE_TRANSACTION_MAX_WAIT_MS,
        timeout: DATABASE_CHECK_TIMEOUT_MS,
      },
    );
    return true;
  } catch (err) {
    console.error("[health] database check failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function diagnosticResponse(): Promise<NextResponse> {
  // Authentication stays off the ordinary liveness path. The provider module
  // is loaded only after the owner check so an unauthorized diagnostic request
  // cannot even initialize the paid-probe/alert code.
  const { getOwnerUser } = await import("@/lib/admin");
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { probeAllProviders, providerHealthSnapshot } = await import("@/lib/provider-health");

  const [dbOk] = await Promise.all([
    databaseOk(),
    // The provider module applies a per-request deadline and aborts each
    // provider fetch when this diagnostic window closes.
    probeAllProviders({ timeoutMs: 10_000 }),
  ]);
  const providers = providerHealthSnapshot();
  const providersUnhealthy = providers.filter((p) => !p.healthy).map((p) => p.provider);

  return NextResponse.json(
    {
      ok: dbOk && providersUnhealthy.length === 0,
      db: dbOk ? "ok" : "fail",
      version: version(),
      uptime: Math.round((Date.now() - startedAt) / 1000),
      providers: Object.fromEntries(
        providers.map((p) => [
          p.provider,
          {
            healthy: p.healthy,
            checkedAt: p.checkedAt,
            ...(p.failure ? { failure: p.failure, detail: p.detail } : {}),
          },
        ]),
      ),
      providersUnhealthy,
    },
    {
      status: dbOk && providersUnhealthy.length === 0 ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(request: Request) {
  if (isDiagnosticHealthRequest(request)) return diagnosticResponse();

  // Ordinary health checks must stay side-effect-free: no provider I/O,
  // provider cache refresh, owner lookup, or alert path is reachable here.
  const db = (await databaseOk()) ? "ok" : "fail";

  return NextResponse.json(
    {
      ok: db === "ok",
      db,
      version: version(),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    },
    {
      status: db === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
