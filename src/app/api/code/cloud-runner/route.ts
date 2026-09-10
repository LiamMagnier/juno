import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { getCloudRunnerReadiness } from "@/lib/cloud-code";

export const runtime = "nodejs";

/**
 * Whether a cloud run could start right now.
 *
 * `/code/new` asks this when the Cloud target is chosen, so a server whose
 * runner workflow is missing or disabled says so under the composer BEFORE
 * the reader writes a prompt and presses Start — rather than after, as a 503
 * on the submit. Same probe the create route gates on, same cache, so the
 * two can never disagree about the same minute.
 *
 * Session-only: it names no secret, but a public "is this deployment's cloud
 * runner configured" endpoint is a fact nobody outside needs.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  const readiness = await getCloudRunnerReadiness();
  return NextResponse.json(readiness, { headers: { "Cache-Control": "no-store" } });
}
