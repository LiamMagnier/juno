import { NextResponse } from "next/server";
import { handleCloudFileAttach } from "@/lib/cloud-files/api";
import { cloudFilesDeps } from "@/lib/cloud-files/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Fetch the files picked in the composer's cloud picker, server-side, and store
// each one through the upload pipeline (planAttachmentUpload, the library
// quota, scheduleIngest). Answers with ready-to-send attachments, the same
// shape as POST /api/library/attach, plus the files that could not be added.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await handleCloudFileAttach(cloudFilesDeps(), id, body, req.signal);
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
