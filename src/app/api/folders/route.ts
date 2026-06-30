import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const folders = await prisma.folder.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, createdAt: true },
  });
  return NextResponse.json({ folders });
}

const schema = z.object({ name: z.string().trim().min(1).max(60) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const folder = await prisma.folder.create({ data: { userId: user.id, name: parsed.data.name } });
  return NextResponse.json({ folder: { id: folder.id, name: folder.name, createdAt: folder.createdAt } }, { status: 201 });
}
