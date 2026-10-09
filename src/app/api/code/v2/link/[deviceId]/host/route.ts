import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { envLinkHub, parseHostRequest } from "@/lib/code-v2/env-link-hub";
import { CODE_V2_PROTOCOL } from "@/lib/code-v2/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The Mac's side of the device link (docs/code-v2/DEVICE-LINK.md):
 * `{kind:"pull"}` long-polls the commands the web relayed (and doubles as the
 * heartbeat that makes the Mac "online" for the link); `{kind:"push",
 * responses, events}` hands back what its env server answered and emitted.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true } });
  if (!device) return NextResponse.json({ error: "This computer is no longer paired with your account." }, { status: 404 });

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  const request = parseHostRequest(body);
  if (!request) return NextResponse.json({ error: "Invalid input." }, { status: 400 });

  const link = envLinkHub().link(user.id, device.id);
  if (request.kind === "pull") {
    if (request.protocol && request.protocol !== CODE_V2_PROTOCOL.name) {
      return NextResponse.json({ error: `This relay speaks ${CODE_V2_PROTOCOL.name}.` }, { status: 409 });
    }
    const reply = await link.pull(request.waitMs, req.signal, request.appVersion);
    return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(link.push(request));
}
