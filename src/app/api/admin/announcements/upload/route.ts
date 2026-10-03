import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { isStorageAvailable } from "@/lib/env";
import { putObject, getViewUrl } from "@/lib/storage";
import { isHeifImage, sniffAvifMime, sniffImageMime, sniffVideoMime, sanitizeFileName } from "@/lib/uploads";
import { ANNOUNCEMENT_MAX_BYTES, announcementMediaKey, type AnnouncementMediaKind } from "@/lib/announcement-media";

export const runtime = "nodejs";
export const maxDuration = 60;

// Owner-only media upload for announcement popups. Accepts images and short
// videos, verifies them by magic bytes, and stores them inline so the popup's
// <img>/<video> can render the returned URL directly.
//
// Bodies over 10 MB only reach this handler because next.config.mjs raises
// `experimental.middlewareClientMaxBodySize` — without it Next truncates the
// body the middleware clones and `formData()` fails on every real video.
export async function POST(req: Request) {
  const owner = await getOwnerUser();
  // 404, not 403: the rest of the admin surface refuses to confirm it exists.
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isStorageAvailable()) {
    return NextResponse.json({ error: "Uploads are not available — configure a storage bucket." }, { status: 503 });
  }

  // Refuse an oversized body before buffering it, when the client says how big
  // it is (multipart overhead is a few hundred bytes).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > ANNOUNCEMENT_MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "File is too large (max 100 MB)." }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    // A body that does not parse is almost always one cut short on the way in
    // (a proxy or middleware ceiling), not a missing field — say so.
    return NextResponse.json(
      { error: "The upload arrived incomplete. Try again, or use a smaller file." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });
  const expected = form.get("kind");
  const expectedKind: AnnouncementMediaKind | null = expected === "image" || expected === "video" ? expected : null;

  if (file.size === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (file.size > ANNOUNCEMENT_MAX_BYTES) {
    return NextResponse.json({ error: "File is too large (max 100 MB)." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isHeifImage(bytes)) {
    return NextResponse.json(
      { error: "HEIC images only display in Safari. Export it as JPEG, PNG or WebP." },
      { status: 415 },
    );
  }
  const image = sniffImageMime(bytes) ?? sniffAvifMime(bytes);
  const video = image ? null : sniffVideoMime(bytes);
  const contentType = image ?? video;
  if (!contentType) {
    return NextResponse.json({ error: "Only image or video files are supported." }, { status: 415 });
  }
  const kind: AnnouncementMediaKind = video ? "video" : "image";
  if (expectedKind && expectedKind !== kind) {
    return NextResponse.json(
      { error: kind === "video" ? "That file is a video. Add it under Video." : "That file is an image. Add it under Image." },
      { status: 415 },
    );
  }

  const fileName = sanitizeFileName(file.name || kind);
  // Under the owner's `announcements/` prefix: /api/files lets the uploader
  // read it before any announcement row names it, so the form can preview it.
  const key = announcementMediaKey(owner.id, fileName);
  // No content-disposition → served inline.
  await putObject(key, bytes, contentType);

  return NextResponse.json({ url: await getViewUrl(key), kind, contentType, size: file.size }, { status: 201 });
}
