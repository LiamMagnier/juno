import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getViewUrl } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      files: {
        where: { fileName: "__cover__" },
        select: { storageKey: true },
        take: 1,
      },
      _count: { select: { conversations: true, files: true } },
    },
  });

  return NextResponse.json({
    projects: await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        name: p.name,
        instructions: p.instructions,
        updatedAt: p.updatedAt.toISOString(),
        conversationCount: p._count.conversations,
        fileCount: p._count.files,
        coverUrl: p.files[0] ? await getViewUrl(p.files[0].storageKey) : null,
      }))
    ),
  });
}

const createSchema = z.object({
  // Optional: an unnamed project is created as "Untitled project" and gets an
  // auto-generated name from its first chat.
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(20_000).optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const project = await prisma.project.create({
    data: { userId: user.id, name: parsed.data.name ?? "Untitled project", instructions: parsed.data.instructions ?? "" },
    select: { id: true },
  });
  return NextResponse.json({ id: project.id }, { status: 201 });
}
