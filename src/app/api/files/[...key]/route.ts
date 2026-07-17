import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getObjectBytes } from "@/lib/storage";
import { sniffImageMime, sniffVideoMime } from "@/lib/uploads";

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

  try {
    const { bytes } = await getObjectBytes(k);
    const img = sniffImageMime(bytes);
    const video = img ? null : sniffVideoMime(bytes);

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
      headers.set("Content-Length", String(bytes.byteLength));
      return new NextResponse(bytes as unknown as BodyInit, { headers });
    }

    // Media: advertise + honor HTTP Range. Safari won't play <video> without it —
    // it sends `Range: bytes=0-1` and expects a 206 Partial Content response.
    const total = bytes.byteLength;
    headers.set("Accept-Ranges", "bytes");
    const rangeHeader = req.headers.get("range");
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          return new NextResponse(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
          });
        }
        const chunk = bytes.subarray(start, end + 1);
        headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
        headers.set("Content-Length", String(chunk.byteLength));
        return new NextResponse(chunk as unknown as BodyInit, { status: 206, headers });
      }
    }

    headers.set("Content-Length", String(total));
    return new NextResponse(bytes as unknown as BodyInit, { headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
