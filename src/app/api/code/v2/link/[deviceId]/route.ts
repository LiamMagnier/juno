import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { envLinkHub, parseClientRequest } from "@/lib/code-v2/env-link-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The hosted web's side of the device link (docs/code-v2/DEVICE-LINK.md):
 * `{kind:"rpc", command}` relays one alevr-code-v2 command to the user's Mac
 * and answers with its response; `{kind:"poll", cursors, globalCursor}`
 * long-polls the events after the client's cursors.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true } });
  if (!device) return NextResponse.json({ message: "This computer is not paired with your account." }, { status: 404 });

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ message: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  const request = parseClientRequest(body);
  if (!request) return NextResponse.json({ message: "Invalid input." }, { status: 400 });

  const link = envLinkHub().link(user.id, device.id);
  const reply = request.kind === "rpc" ? await link.rpc(request.command) : await link.poll(request.cursors, request.globalCursor, undefined, req.signal);
  return NextResponse.json(reply, { headers: { "Cache-Control": "no-store" } });
}
