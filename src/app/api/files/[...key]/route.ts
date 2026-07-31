import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { headObject, openObjectStream } from "@/lib/storage";
import { MIME_SNIFF_BYTES, sniffImageMime, sniffVideoMime } from "@/lib/uploads";
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from "@/lib/http-range";

export const runtime = "nodejs";

/**
 * True when the signed-in user may read the object behind `key`. Three real
 * consumers exist (public share pages snapshot text only and never link here,
 * so there is deliberately no anonymous path):
 *  - chat/project/library attachments — owner only;
 *  - avatars (`User.image` stores `/api/files/<key>`) — any signed-in user,
 *    since profiles render beyond the owner's own session (admin surfaces);
 *  - announcement media (owner-uploaded, broadcast to every signed-in user).
 */
async function canReadObject(userId: string, key: string): Promise<boolean> {
  // storageKey is the lookup key, so the query cannot be userId-scoped —
  // ownership is the explicit check on the row instead.
  const attachment = await prismaUnguarded.attachment.findFirst({
    where: { storageKey: key },
    select: { userId: true },
  });
  if (attachment) return attachment.userId === userId;

  const url = `/api/files/${key}`;
  const avatar = await prismaUnguarded.user.findFirst({ where: { image: url }, select: { id: true } });
  if (avatar) return true;
  const announcement = await prismaUnguarded.announcement.findFirst({
    where: { OR: [{ imageUrl: url }, { videoUrl: url }] },
    select: { id: true },
  });
  return Boolean(announcement);
}

// Serves stored uploads (local-disk dev fallback for attachments; avatars and
// announcement media in every mode). Object keys contain a random UUID, but
// unguessability is not access control: the requester must be signed in and
// the object must resolve to something they may read.
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { key } = await params;
  const k = (key ?? []).join("/");
  if (!k.startsWith("uploads/") || k.includes("..")) {
    return new NextResponse("Not found", { status: 404 });
  }
  // Objects the user cannot read 404 (not 403): no existence oracle.
  if (!(await canReadObject(user.id, k))) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Enough bytes for every signature in sniffImageMime/sniffVideoMime (the
  // longest looks at byte 11). Reading the prefix rather than the object is
  // what keeps memory flat: a 1 GB video used to be pulled entirely into RSS
  // just to decide its content type, and PM2 restarts the backend at ~1400 MB —
  // taking every in-flight SSE stream on the box with it.
  let head;
  try {
    head = await headObject(k, 16);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const { size: total, prefix } = head;
  const img = sniffImageMime(prefix);
  const video = img ? null : sniffVideoMime(prefix);

  const headers = new Headers();
  headers.set("Cache-Control", "private, max-age=3600");
  if (img) {
    headers.set("Content-Type", img);
  } else if (video) {
    // Served inline so <video> can stream it; media bytes can't execute scripts.
    headers.set("Content-Type", video);
  } else {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", "attachment");
  }

  // Media: advertise + honor HTTP Range. Safari won't play <video> without it —
  // it sends `Range: bytes=0-1` and expects a 206 Partial Content response, and
  // it uses a suffix range (`bytes=-N`) to find the moov atom of an mp4 that
  // wasn't written faststart.
  const isMedia = Boolean(img || video);
  if (isMedia) headers.set("Accept-Ranges", "bytes");

  const range = isMedia ? parseRangeHeader(req.headers.get("range"), total) : ({ kind: "none" } as const);
  if (range.kind === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": unsatisfiedRangeHeader(total), "Accept-Ranges": "bytes" },
    });
  }

  const slice = range.kind === "satisfiable" ? { start: range.start, end: range.end } : null;
  const length = slice ? slice.end - slice.start + 1 : total;
  headers.set("Content-Length", String(length));
  if (slice) headers.set("Content-Range", contentRangeHeader(slice.start, slice.end, total));

  // Next serves HEAD by running GET and discarding the body. Answering with a
  // null body keeps that from opening a storage stream nobody will consume.
  if (req.method === "HEAD") {
    return new NextResponse(null, { status: slice ? 206 : 200, headers });
  }

  try {
    const body = await openObjectStream(k, slice ?? undefined);
    return new NextResponse(body, { status: slice ? 206 : 200, headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
