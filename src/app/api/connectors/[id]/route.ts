import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getConnector } from "@/lib/connectors";
import { isCustomConnectorId } from "@/lib/custom-connectors";

export const runtime = "nodejs";

// Disconnect a linked connector (revokes it from the user's account).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = decodeURIComponent((await params).id);
  // A custom server signs out here and keeps its entry (so it can reconnect);
  // DELETE /api/connectors/custom/[id] removes it altogether.
  if (!getConnector(id) && !isCustomConnectorId(id)) return NextResponse.json({ error: "Unknown connector." }, { status: 404 });

  await prisma.connection.deleteMany({ where: { userId: user.id, provider: id } });
  return NextResponse.json({ ok: true });
}
