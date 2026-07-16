import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * The Juno app's Code workspaces (project folders), mirrored server-side so the
 * website's Code tab shows the same Projects as the app's sidebar.
 *
 *   GET → { workspaces: [{ id, name, path, lastOpenedAt }] } newest-opened first
 *   PUT { workspaces: [...] } → mirror-sync: the app owns the list, so the
 *     user's server set is replaced (upsert by path, prune the rest).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaces = await prisma.codeWorkspace.findMany({
    where: { userId: user.id },
    orderBy: { lastOpenedAt: "desc" },
    select: { id: true, name: true, path: true, lastOpenedAt: true },
  });
  return NextResponse.json({
    workspaces: workspaces.map((w) => ({ ...w, lastOpenedAt: w.lastOpenedAt.toISOString() })),
  });
}

const putSchema = z.object({
  workspaces: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(300),
        path: z.string().trim().min(1).max(1000),
        lastOpenedAt: z.string().datetime().optional(),
      })
    )
    .max(200),
});

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const items = parsed.data.workspaces;
  const keepPaths = items.map((w) => w.path);
  await prisma.$transaction([
    prisma.codeWorkspace.deleteMany({ where: { userId: user.id, path: { notIn: keepPaths } } }),
    ...items.map((w) =>
      prisma.codeWorkspace.upsert({
        where: { userId_path: { userId: user.id, path: w.path } },
        create: {
          id: w.id,
          userId: user.id,
          name: w.name,
          path: w.path,
          lastOpenedAt: w.lastOpenedAt ? new Date(w.lastOpenedAt) : new Date(),
        },
        update: {
          name: w.name,
          lastOpenedAt: w.lastOpenedAt ? new Date(w.lastOpenedAt) : new Date(),
        },
      })
    ),
  ]);
  return NextResponse.json({ ok: true, count: items.length });
}
