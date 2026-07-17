import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { planWorkspaceMirror } from "@/lib/code-workspaces";

export const runtime = "nodejs";

/**
 * The Juno app's Code workspaces (project folders), mirrored server-side so the
 * website's Code tab shows the same Projects as the app's sidebar.
 *
 *   GET → { workspaces: [{ id, key, name, path, lastOpenedAt }] } newest-opened first
 *   PUT { workspaces: [...] } → mirror-sync: the app owns the list, so the
 *     user's server set is replaced. Since W5 each entry may carry a stable
 *     identity `key`; matching is (userId, key) first, then (userId, path) —
 *     see src/lib/code-workspaces.ts for the exact reconciliation contract.
 *     Key-less clients keep today's pure path matching.
 */

const WORKSPACE_SELECT = { id: true, key: true, name: true, path: true, lastOpenedAt: true } as const;

type WorkspaceRow = { id: string; key: string | null; name: string; path: string; lastOpenedAt: Date };

const serializeWorkspace = (w: WorkspaceRow) => ({ ...w, lastOpenedAt: w.lastOpenedAt.toISOString() });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaces = await prisma.codeWorkspace.findMany({
    where: { userId: user.id },
    orderBy: { lastOpenedAt: "desc" },
    select: WORKSPACE_SELECT,
  });
  return NextResponse.json({ workspaces: workspaces.map(serializeWorkspace) });
}

const putSchema = z.object({
  workspaces: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(300),
        path: z.string().trim().min(1).max(1000),
        // Stable identity minted by the client that owns the folder. Optional:
        // pre-key clients omit it and keep exact path-based matching.
        key: z.string().trim().min(1).max(200).optional(),
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
  const existing = await prisma.codeWorkspace.findMany({
    where: { userId: user.id },
    select: { id: true, key: true, name: true, path: true },
  });
  const plan = planWorkspaceMirror(existing, items);

  await prisma.$transaction([
    // Deletes first: they free (userId, path) slots claimed rows move onto.
    ...(plan.deleteIds.length > 0
      ? [prisma.codeWorkspace.deleteMany({ where: { userId: user.id, id: { in: plan.deleteIds } } })]
      : []),
    // Vacate every changing path before applying the real updates, so update
    // order can never trip the (userId, path) unique (e.g. two folders that
    // swapped locations between heartbeats). The placeholder can't collide:
    // real paths are zod-trimmed (never lead with a space) and row ids are
    // unique, so each placeholder is unique per user too.
    ...plan.updates
      .filter((u) => u.pathChanged)
      .map((u) =>
        prisma.codeWorkspace.updateMany({
          where: { id: u.id, userId: user.id },
          data: { path: ` moving:${u.id}` },
        })
      ),
    ...plan.updates.map((u) =>
      prisma.codeWorkspace.updateMany({ where: { id: u.id, userId: user.id }, data: u.data })
    ),
    ...plan.creates.map((c) => prisma.codeWorkspace.create({ data: { ...c, userId: user.id } })),
  ]);

  const workspaces = await prisma.codeWorkspace.findMany({
    where: { userId: user.id },
    orderBy: { lastOpenedAt: "desc" },
    select: WORKSPACE_SELECT,
  });
  return NextResponse.json({ ok: true, count: items.length, workspaces: workspaces.map(serializeWorkspace) });
}
