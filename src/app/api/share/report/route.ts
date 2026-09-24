import { NextResponse } from "next/server";
import { ipFromHeaders, rateLimit } from "@/lib/rate-limit";
import { createShareReport } from "@/lib/share-moderation";
import { shareReportSchema } from "@/lib/share-schemas";

export const runtime = "nodejs";

/*
 * The Report link on a public share page. Anyone can send one — the reporter
 * is usually a visitor with no account — so it is keyed on the share token (the
 * same capability that shows the page) and rate-limited per address. Reports
 * queue for an admin (/admin/links); nothing is removed automatically.
 */
export async function POST(req: Request) {
  const limit = await rateLimit({ key: `share-report:${ipFromHeaders(req.headers)}`, limit: 10, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many reports from this address. Try again later." }, { status: 429 });
  }

  const parsed = shareReportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a reason, and check the email address if you gave one." }, { status: 400 });
  }

  const result = await createShareReport(parsed.data);
  if (!result.ok) return NextResponse.json({ error: "This link no longer exists." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
