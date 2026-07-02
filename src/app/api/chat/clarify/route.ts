import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { maybeRequestClarification, noPreflightClarification } from "@/lib/preflight-clarification";

export const runtime = "nodejs";

const bodySchema = z.object({
  message: z.string().max(50_000),
  conversationId: z.string().cuid().optional().nullable(),
  hasAttachments: z.boolean().optional(),
  privateMode: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat-clarify:${user.id}`, limit: 60, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json(noPreflightClarification("Clarification checks are rate limited."), { status: 200 });
    }
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(noPreflightClarification("Invalid clarification check request."), { status: 200 });

  const result = maybeRequestClarification({
    message: parsed.data.message,
    hasAttachments: parsed.data.hasAttachments,
  });

  return NextResponse.json(result);
}
