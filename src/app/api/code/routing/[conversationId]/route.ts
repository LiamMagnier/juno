import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { catalogModel } from "@/lib/code-v2/code-models";
import { activeByokProviders } from "@/lib/code-v2/byok-store";
import { validateRoleRouting } from "@/lib/code-v2/role-routing";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * A Code thread's role routing (Alevr Code v2 SPEC §3.4): which model leads,
 * which work, which reviews. Stored on the kind:"code" Conversation; every new
 * task in the thread snapshots it (POST /api/code/tasks), and devices and the
 * cloud runner read the snapshot from the task.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { conversationId } = await ctx.params;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: user.id, kind: "code" },
    select: { codeRouting: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ routing: conversation.codeRouting ?? null }, { headers: NO_STORE });
}

/**
 * Replace the routing: `{routing: RoleRouting | null}`. Null clears it (the
 * thread goes back to its single model). Validated against the catalogue and
 * the user's stored keys; the normalized routing is what is saved and returned.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { conversationId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { routing?: unknown } | null;
  if (!body || !("routing" in body)) return NextResponse.json({ error: "Send {routing}." }, { status: 400 });

  let value: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  let routing: unknown = null;
  let warnings: string[] = [];
  if (body.routing !== null) {
    const checked = validateRoleRouting(body.routing, {
      resolve: catalogModel,
      byokProviders: await activeByokProviders(user.id),
    });
    if (!checked.ok) {
      return NextResponse.json({ error: "This routing can't run.", code: "ROUTING_INVALID", errors: checked.errors }, { status: 400 });
    }
    routing = checked.routing;
    warnings = checked.warnings;
    value = checked.routing as unknown as Prisma.InputJsonValue;
  }
  const res = await prisma.conversation.updateMany({
    where: { id: conversationId, userId: user.id, kind: "code" },
    data: { codeRouting: value },
  });
  if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ routing, warnings }, { headers: NO_STORE });
}
