import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { isStorageAvailable } from "@/lib/env";
import { buildObjectKey, putObject, getViewUrl } from "@/lib/storage";
import { sniffImageMime, sniffVideoMime, sanitizeFileName } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 60;

// Owner-only media upload for announcement popups. Accepts images and short
// videos, verifies them by magic bytes, and stores them inline so the popup's
// <img>/<video> can render the returned URL directly.
export async function POST(req: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!isStorageAvailable()) {
    return NextResponse.json({ error: "Uploads are not available — configure a storage bucket." }, { status: 503 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });

  // Owner-only; a generous ceiling for short release clips.
  const maxBytes = 100 * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json({ error: "File is too large (max 100 MB)." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniffImageMime(bytes);
  const video = image ? null : sniffVideoMime(bytes);
  const contentType = image ?? video;
  if (!contentType) {
    return NextResponse.json({ error: "Only image or video files are supported." }, { status: 415 });
  }

  const fileName = sanitizeFileName(file.name || (video ? "video" : "image"));
  const key = buildObjectKey(owner.id, fileName);
  // No content-disposition → served inline.
  await putObject(key, bytes, contentType);

  return NextResponse.json({ url: await getViewUrl(key), kind: video ? "video" : "image" }, { status: 201 });
}
