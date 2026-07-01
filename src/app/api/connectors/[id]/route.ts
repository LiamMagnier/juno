import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConnector } from "@/lib/connectors";

export const runtime = "nodejs";

// Disconnect a linked connector (revokes it from the user's account).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!getConnector(id)) return NextResponse.json({ error: "Unknown connector." }, { status: 404 });

  await prisma.connection.deleteMany({ where: { userId: user.id, provider: id } });
  return NextResponse.json({ ok: true });
}
