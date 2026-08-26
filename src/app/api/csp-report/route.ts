import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Where the enforcing CSP sends its violation reports (see src/middleware.ts).
 *
 * The point of the report-only phase is to find out what a real policy would
 * break before it breaks it. Without somewhere to send them the reports go
 * nowhere and the policy can never be promoted to enforcing.
 *
 * Unauthenticated by necessity — the browser posts these itself, with no
 * session — so it is rate limited and logs a bounded, fixed set of fields. It
 * never echoes anything back. CSP reporting is diagnostic only: it must never
 * compete with user traffic for a database connection or turn a pool outage
 * into an application error. The limiter below is deliberately process-local
 * and bounded; losing a report is safe, exhausting the primary database pool
 * is not.
 */

interface CspReport {
  "document-uri"?: string;
  "violated-directive"?: string;
  "effective-directive"?: string;
  "blocked-uri"?: string;
  "script-sample"?: string;
  "line-number"?: number;
}

const REPORT_WINDOW_MS = 60 * 60 * 1000;
const MAX_REPORTS_PER_PROCESS_WINDOW = 100;
const MAX_REPORTS_IN_FLIGHT = 4;

let reportWindowStartedAt = Date.now();
let acceptedReports = 0;
let reportsInFlight = 0;

function claimReportSlot(now = Date.now()): boolean {
  if (now - reportWindowStartedAt >= REPORT_WINDOW_MS) {
    reportWindowStartedAt = now;
    acceptedReports = 0;
  }
  if (
    acceptedReports >= MAX_REPORTS_PER_PROCESS_WINDOW ||
    reportsInFlight >= MAX_REPORTS_IN_FLIGHT
  ) {
    return false;
  }
  acceptedReports += 1;
  reportsInFlight += 1;
  return true;
}

export async function POST(req: Request) {
  // A browser will happily retry these; a hostile client can post them in bulk.
  // Claim synchronously before parsing or touching any shared resource. The
  // in-flight bound is the important part: even a burst of thousands of
  // reports cannot open thousands of database sessions at once.
  if (!claimReportSlot()) return new NextResponse(null, { status: 204 });

  try {
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
  } finally {
    reportsInFlight = Math.max(0, reportsInFlight - 1);
  }
}
