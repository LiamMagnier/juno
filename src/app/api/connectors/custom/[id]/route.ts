import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session";
import { toCustomConnectorView } from "@/lib/custom-connectors";
import { prisma } from "@/lib/prisma";
import { notFound, ownedConnector } from "../shared";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

async function linkOf(userId: string, id: string) {
  return prisma.connection.findUnique({
    where: { userId_provider: { userId, provider: id } },
    select: { createdAt: true },
  });
}

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connector = await ownedConnector(user.id, (await params).id);
  if (!connector) return notFound();
  return NextResponse.json({ connector: toCustomConnectorView(connector, await linkOf(user.id, connector.id)) });
}

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    disabledTools: z.array(z.string().min(1).max(200)).max(500).optional(),
  })
  .refine((b) => b.name !== undefined || b.disabledTools !== undefined, "Nothing to change");

/** Rename, or choose which of its tools Juno may use. */
export async function PATCH(req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connector = await ownedConnector(user.id, (await params).id);
  if (!connector) return notFound();
  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const updated = await prisma.customConnector.update({
    where: { id: connector.id, userId: user.id },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.disabledTools ? { disabledTools: [...new Set(parsed.data.disabledTools)] } : {}),
    },
  });
  return NextResponse.json({ connector: toCustomConnectorView(updated, await linkOf(user.id, updated.id)) });
}

/** Removes the server and signs out of it. Chats that had it on just lose it. */
export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connector = await ownedConnector(user.id, (await params).id);
  if (!connector) return notFound();
  await prisma.$transaction([
    prisma.connection.deleteMany({ where: { userId: user.id, provider: connector.id } }),
    prisma.customConnector.delete({ where: { id: connector.id, userId: user.id } }),
  ]);
  return NextResponse.json({ ok: true });
}
