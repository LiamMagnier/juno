import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { offlineReply, parseLinkRequest } from "@/lib/code-v2/device-link";
import { linkHub } from "@/lib/code-v2/env-link-select";
import { requireRemotePair } from "@/lib/code-v2/device-pairing-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 35;

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The hosted web's side of the device link (Alevr Code v2, SPEC §3.1;
 * docs/code-v2/DEVICE-LINK.md). `{kind:"rpc", command}` relays one
 * alevr-code-v2 command to the user's Mac through the hub and answers with its
 * response; `{kind:"poll", cursors, globalCursor}` long-polls the events after
 * the client's cursors. The Mac drains the hub at `./host`.
 *
 * Remote control (docs/code-v2/REMOTE-CONTROL.md): owning the Mac is not
 * enough. The phone (its native sign-in) or browser (its pairing cookie) must
 * hold a live pair with it, checked before the request reaches the hub and
 * again before a long-poll's events go out, so a pair removed on the Mac
 * stops a waiting poll from delivering anything more.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true, name: true } });
  if (!device) return NextResponse.json({ error: "This computer is not paired with your account." }, { status: 404 });
  const unpaired = await requireRemotePair(req, user.id, device.id);
  if (unpaired) return unpaired;

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* parseLinkRequest rejects it */
  }
  const parsed = parseLinkRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const link = linkHub().link(user.id, device.id);
  const request = parsed.request;
  const reply = request.kind === "rpc" ? await link.rpc(request.command) : await link.poll(request.cursors, request.globalCursor, undefined, req.signal);
  if (request.kind === "poll") {
    const revoked = await requireRemotePair(req, user.id, device.id);
    if (revoked) return revoked;
  }
  return NextResponse.json(reply.offline ? { ...reply, ...offlineReply(device.name) } : reply, { headers: { "Cache-Control": "no-store" } });
}
