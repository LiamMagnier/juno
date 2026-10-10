import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { buildHandoffPayload, sendPushToDevices } from "@/lib/code-v2/remote-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  target: z.enum(["ios", "macos"]),
  kind: z.enum(["chat", "code"]),
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  deviceId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  title: z.string().max(300).optional(),
});

/**
 * "Continue on iPhone / Mac" (docs/code-v2/REMOTE-CONTROL.md §Hand-off): sends
 * the open thread to the account's other app as a notification that opens it.
 * Apple Handoff covers devices side by side; this reaches one in a pocket.
 * Never to the device that asked.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  if (parsed.data.kind === "code" && !parsed.data.deviceId) return NextResponse.json({ error: "A Code thread needs its Mac." }, { status: 400 });
  const limit = await rateLimit({ key: `handoff:${user.id}`, limit: 30, windowSec: 60 }).catch(() => ({ success: true }));
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const results = await sendPushToDevices(
    user.id,
    { platform: parsed.data.target, excludeDeviceSessionId: await getCurrentDeviceSessionId() },
    buildHandoffPayload(parsed.data),
    { collapseId: `handoff-${parsed.data.kind}` },
  );
  const sent = results.filter((r) => r.success).length;
  if (sent === 0) {
    const place = parsed.data.target === "ios" ? "iPhone" : "Mac";
    return NextResponse.json({ sent: 0, error: `No ${place} signed in to Alevr can receive it. Open Alevr on your ${place} first.` }, { status: 404 });
  }
  return NextResponse.json({ sent });
}
