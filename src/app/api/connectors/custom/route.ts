import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session";
import {
  MAX_CUSTOM_CONNECTORS,
  canonicalMcpUrl,
  newCustomConnectorId,
  probeCustomMcpServer,
  suggestedName,
  toCustomConnectorView,
} from "@/lib/custom-connectors";
import { prisma } from "@/lib/prisma";
import { probeAllowed, tooMany } from "./shared";

export const runtime = "nodejs";
export const maxDuration = 30;

const createBody = z.object({
  url: z.string().trim().min(1).max(2_000),
  name: z.string().trim().max(60).optional(),
});

/** The caller's custom MCP servers, linked or not. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const connectors = await prisma.customConnector.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  const links = await prisma.connection.findMany({
    where: { userId: user.id, provider: { in: connectors.map((c) => c.id) } },
    select: { provider: true, createdAt: true },
  });
  const linked = new Map(links.map((l) => [l.provider, l]));
  return NextResponse.json({
    connectors: connectors.map((c) => toCustomConnectorView(c, linked.get(c.id))),
    limit: MAX_CUSTOM_CONNECTORS,
  });
}

/**
 * Saves a server (re-checked here, never trusted from the probe) and hands
 * back where to send the browser to sign in. Adding the same URL twice
 * returns the existing connector rather than a duplicate.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = createBody.safeParse(await req.json().catch(() => null));
  const url = parsed.success ? canonicalMcpUrl(parsed.data.url) : null;
  if (!parsed.success || !url) {
    return NextResponse.json({ error: "invalid_url", message: "That isn't a valid server address." }, { status: 400 });
  }

  const existing = await prisma.customConnector.findFirst({ where: { userId: user.id, url } });
  if (existing) {
    return NextResponse.json({
      connector: toCustomConnectorView(existing),
      connectUrl: `/api/connectors/custom/${encodeURIComponent(existing.id)}/connect`,
      existing: true,
    });
  }
  const count = await prisma.customConnector.count({ where: { userId: user.id } });
  if (count >= MAX_CUSTOM_CONNECTORS) {
    return NextResponse.json(
      { error: "limit", message: `You can add up to ${MAX_CUSTOM_CONNECTORS} servers. Remove one to add another.` },
      { status: 409 }
    );
  }
  if (!(await probeAllowed(user.id))) return tooMany();
  const probe = await probeCustomMcpServer(url);
  if (!probe.ok) return NextResponse.json({ error: probe.reason, message: probe.message }, { status: 422 });

  const connector = await prisma.customConnector.create({
    data: {
      id: newCustomConnectorId(),
      userId: user.id,
      url,
      name: parsed.data.name?.trim() || suggestedName(url),
    },
  });
  return NextResponse.json(
    {
      connector: toCustomConnectorView(connector),
      connectUrl: `/api/connectors/custom/${encodeURIComponent(connector.id)}/connect`,
    },
    { status: 201 }
  );
}
