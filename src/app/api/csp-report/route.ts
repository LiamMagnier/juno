import { NextResponse } from "next/server";
import { ipFromHeaders, rateLimit } from "@/lib/rate-limit";
import { headers } from "next/headers";

export const runtime = "nodejs";

/**
 * Where the Report-Only CSP sends its violations (see src/middleware.ts).
 *
 * The point of the report-only phase is to find out what a real policy would
 * break before it breaks it. Without somewhere to send them the reports go
 * nowhere and the policy can never be promoted to enforcing.
 *
 * Unauthenticated by necessity — the browser posts these itself, with no
 * session — so it is rate limited and logs a bounded, fixed set of fields. It
 * never echoes anything back.
 */

interface CspReport {
  "document-uri"?: string;
  "violated-directive"?: string;
  "effective-directive"?: string;
  "blocked-uri"?: string;
  "script-sample"?: string;
  "line-number"?: number;
}

export async function POST(req: Request) {
  // A browser will happily retry these; a hostile client can post them in bulk.
  // Bounded globally rather than per-IP: the interesting signal is aggregate,
  // and one busy page can legitimately emit many.
  const ip = ipFromHeaders(await headers());
  const limits = await Promise.all([
    rateLimit({ key: "csp-report:global", limit: 500, windowSec: 60 * 60 }),
    ...(ip !== "unknown" ? [rateLimit({ key: `csp-report:ip:${ip}`, limit: 50, windowSec: 60 * 60 })] : []),
  ]);
  // 204 either way: telling a reporter it was throttled achieves nothing.
  if (limits.some((l) => !l.success)) return new NextResponse(null, { status: 204 });

  const body = (await req.json().catch(() => null)) as { "csp-report"?: CspReport } | null;
  const report = body?.["csp-report"];
  if (!report) return new NextResponse(null, { status: 204 });

  // A fixed field set, each truncated: `blocked-uri` and `script-sample` are
  // attacker-influenced, and this lands in a plaintext log.
  const clamp = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : undefined);
  console.warn("[csp]", {
    documentUri: clamp(report["document-uri"]),
    directive: clamp(report["effective-directive"] ?? report["violated-directive"], 80),
    blockedUri: clamp(report["blocked-uri"]),
    sample: clamp(report["script-sample"], 120),
    line: typeof report["line-number"] === "number" ? report["line-number"] : undefined,
  });

  return new NextResponse(null, { status: 204 });
}
