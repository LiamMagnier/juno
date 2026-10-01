import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { canonicalMcpUrl, probeCustomMcpServer, suggestedName } from "@/lib/custom-connectors";
import { prisma } from "@/lib/prisma";
import { probeAllowed, tooMany, urlBody } from "../shared";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Checks a pasted address before anything is saved: is there an MCP server
 * there, does it sign in with OAuth, and can Juno register with it? The add
 * dialog shows the answer (and a suggested name) before asking to continue.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = urlBody.safeParse(await req.json().catch(() => null));
  const url = parsed.success ? canonicalMcpUrl(parsed.data.url) : null;
  if (!url) return NextResponse.json({ ok: false, reason: "invalid_url", message: "That isn't a valid server address." });
  if (!(await probeAllowed(user.id))) return tooMany();

  const existing = await prisma.customConnector.findFirst({ where: { userId: user.id, url }, select: { id: true, name: true } });
  const result = await probeCustomMcpServer(url);
  if (!result.ok) return NextResponse.json({ ok: false, url, reason: result.reason, message: result.message });
  return NextResponse.json({
    ok: true,
    url,
    host: new URL(url).host,
    authHost: result.authHost,
    suggestedName: suggestedName(url),
    existing,
  });
}
