import { NextResponse } from "next/server";
import { handleCloudFileList } from "@/lib/cloud-files/api";
import { cloudFilesDeps } from "@/lib/cloud-files/server";
import { isCloudAttachEnabled, isGoogleDriveFilesEnabled } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 30;

// The composer's "Add from Google Drive / OneDrive" picker: recent files, or a
// search (?q=), one page at a time (?cursor=). Read with the signed-in user's
// own connection; see src/lib/cloud-files/api.ts.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(id === "google-drive" ? isGoogleDriveFilesEnabled() : isCloudAttachEnabled())) {
    return NextResponse.json({ error: "Attaching from cloud drives is not turned on for this server.", code: "not_enabled" }, { status: 404 });
  }
  const result = await handleCloudFileList(cloudFilesDeps(), id, new URL(req.url), req.signal);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
