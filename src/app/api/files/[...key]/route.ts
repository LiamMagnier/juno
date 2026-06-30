import { NextResponse } from "next/server";
import { getObjectBytes } from "@/lib/storage";
import { sniffImageMime, sniffVideoMime } from "@/lib/uploads";

export const runtime = "nodejs";

// Serves locally-stored uploads (dev fallback). Object keys contain a random
// UUID so they're effectively unguessable, matching the signed-URL model.
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const k = (key ?? []).join("/");
  if (!k.startsWith("uploads/") || k.includes("..")) {
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
