import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUsageBreakdown } from "@/lib/usage-breakdown";

export const runtime = "nodejs";

/**
 * The account's own `ApiSpend` ledger, aggregated — what was spent, on which
 * surface (Chat, Code, tasks, media), through which model, from which client,
 * and on which days.
 *
 * The sibling `/api/profile/usage` route answers "am I near my limit"; this one
 * answers "where did it go". They are separate because the meters are read on
 * every settings open and must stay cheap, while this scans a year of ledger
 * rows and is only read when someone actually opens a usage dashboard.
 *
 * Auth is the shared session, which `getCurrentUser()` also resolves from a
 * native bearer token — so the desktop and phone apps read this without a
 * second contract.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Clamped inside `getUsageBreakdown`; parsed leniently here so a malformed
  // `?days=` falls back to the year rather than failing the whole dashboard.
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(requested) && requested > 0 ? requested : 365;

  const breakdown = await getUsageBreakdown(user.id, { days });
  return NextResponse.json(breakdown, {
    // Private and short-lived: the numbers move as the user works, but a
    // dashboard that re-aggregates a year of rows on every focus change is a
    // self-inflicted load problem.
    headers: { "cache-control": "private, max-age=30" },
  });
}
