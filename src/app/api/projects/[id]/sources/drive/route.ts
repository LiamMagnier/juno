import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { CLOUD_IMPORT_CEILING_MB } from "@/lib/cloud-files/shared";
import { browseDrive, classifyDriveFailure, parseDriveBrowseParams, SourceSyncError } from "@/lib/projects/drive-source";
import { openDrive } from "@/lib/projects/drive-source-store";

export const runtime = "nodejs";
export const maxDuration = 30;

/*
 * The "Add from Google Drive" picker on the project page: a folder's contents
 * (My Drive is `parent=root`), what was shared with the person
 * (`view=shared`), or a search (`q=`), one page at a time (`cursor=`). Read
 * with the project owner's own Drive connection; folders are offered whole,
 * files with the same "can't be added" note the composer's Drive picker draws.
 */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const input = parseDriveBrowseParams(new URL(req.url).searchParams);
  if (!input) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (!(await rateLimit({ key: `cloud-files:${user.id}`, limit: 120, windowSec: 60 })).success) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }

  const plan = await getUserPlan(user.id);
  const maxBytes = Math.min(PLANS[plan].maxUploadMb, CLOUD_IMPORT_CEILING_MB) * 1024 * 1024;
  try {
    const client = await openDrive(user.id, AbortSignal.any([req.signal, AbortSignal.timeout(25_000)]));
    const page = await browseDrive(client, input, maxBytes);
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = error instanceof SourceSyncError ? error : classifyDriveFailure(error, "Google Drive");
    const status = failure.code === "not_connected" || failure.code === "reconnect" ? 409 : failure.code === "forbidden" ? 403 : failure.code === "not_found" ? 404 : failure.code === "rate_limited" ? 429 : 502;
    const message =
      failure.code === "not_found"
        ? "That folder is no longer in your Google Drive."
        : failure.code === "provider_error" && !(error instanceof SourceSyncError)
          ? "Couldn’t reach Google Drive. Try again."
          : failure.message;
    return NextResponse.json({ error: message, code: failure.code }, { status });
  }
}
