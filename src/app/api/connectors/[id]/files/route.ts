import { NextResponse } from "next/server";
import { handleCloudFileList } from "@/lib/cloud-files/api";
import { cloudFilesDeps } from "@/lib/cloud-files/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// The composer's "Add from Google Drive / OneDrive" picker: recent files, or a
// search (?q=), one page at a time (?cursor=). Read with the signed-in user's
// own connection; see src/lib/cloud-files/api.ts.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await handleCloudFileList(cloudFilesDeps(), id, new URL(req.url), req.signal);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
