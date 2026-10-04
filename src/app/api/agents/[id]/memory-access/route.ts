import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { prisma } from "@/lib/prisma";
import { AGENT_MEMORY_ACCESS } from "@/lib/memory-scope";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ access: z.enum(AGENT_MEMORY_ACCESS) });

/**
 * How much of the person's memory one agent may read. Its own route, outside
 * the agent PATCH schema, on purpose: that schema is also what the agent's
 * self-configuration tools write through, and an agent must never widen its
 * own access to its owner's memory. Only a signed-in person reaches this.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That change could not be read." }, { status: 400 });
  }
  const { count } = await prisma.agent.updateMany({
    where: { id, userId: user.id, deletedAt: null },
    data: { memoryAccess: parsed.data.access },
  });
  if (count === 0) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  return NextResponse.json({ ok: true, memoryAccess: parsed.data.access });
}
