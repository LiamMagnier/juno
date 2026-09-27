import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { customAccessToken, refreshCustomConnectorTools, toCustomConnectorView } from "@/lib/custom-connectors";
import { prisma } from "@/lib/prisma";
import { notFound, ownedConnector, probeAllowed, tooMany } from "../../shared";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Asks the server for its tools now, and remembers them for the page. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connector = await ownedConnector(user.id, (await params).id);
  if (!connector) return notFound();
  const link = await prisma.connection.findUnique({ where: { userId_provider: { userId: user.id, provider: connector.id } } });
  if (!link) return NextResponse.json({ error: "not_connected", message: "Sign in to this server first." }, { status: 409 });
  if (!(await probeAllowed(user.id))) return tooMany();
  const token = await customAccessToken(connector, link);
  if (!token) {
    return NextResponse.json(
      { error: "signed_out", message: "Juno's sign-in to this server has expired. Reconnect to keep using it." },
      { status: 409 }
    );
  }
  try {
    await refreshCustomConnectorTools(connector, token);
  } catch (err) {
    console.error("[custom-mcp] tools/list failed", connector.id, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "unreachable", message: "The server didn't answer with its tools. Try again in a moment." },
      { status: 502 }
    );
  }
  const fresh = await prisma.customConnector.findFirstOrThrow({ where: { id: connector.id, userId: user.id } });
  return NextResponse.json({ connector: toCustomConnectorView(fresh, { createdAt: link.createdAt }) });
}
