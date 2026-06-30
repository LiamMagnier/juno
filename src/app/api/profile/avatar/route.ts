import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { buildObjectKey, putObject } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `avatar:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) return NextResponse.json({ error: "Too many uploads — try again later." }, { status: 429 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });
  if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: "Please upload a JPEG, PNG, WebP, or GIF." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image must be under 5 MB." }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const key = buildObjectKey(user.id, `avatar-${file.name || "image"}`);
  await putObject(key, bytes, file.type);

  // Serve through the storage proxy so the URL is stable (works for local + S3).
  const url = `/api/files/${key}`;
  await prisma.user.update({ where: { id: user.id }, data: { image: url } });

  return NextResponse.json({ url });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await prisma.user.update({ where: { id: user.id }, data: { image: null } });
  return NextResponse.json({ ok: true });
}
