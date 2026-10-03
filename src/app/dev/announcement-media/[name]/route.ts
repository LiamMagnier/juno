import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The announcement gallery's sample media (/dev/announcement), served only in
 * development. They used to sit in public/, which would have shipped them to
 * production with every build.
 */
const FILES: Record<string, string> = {
  "orbit.mp4": "video/mp4",
  "orbit-poster.jpg": "image/jpeg",
};

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const type = FILES[name];
  if (process.env.NODE_ENV === "production" || !type) return new Response("Not found", { status: 404 });
  const bytes = await readFile(path.join(process.cwd(), "src/app/dev/announcement/_media", name));
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
}
