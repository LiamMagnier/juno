import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { deliverLocalToolResult, MAX_LOCAL_TOOL_OUTPUT_CHARS } from "@/lib/chat/local-folder-bridge";

export const runtime = "nodejs";

/**
 * The Mac answering one folder call (src/lib/chat/local-folder.ts).
 *
 * The chat turn that sent the `local_tool` frame is waiting on this id; the
 * body is what the Mac did. A result for a call that is not waiting — already
 * answered, timed out, or another account's — is 404, the same answer for all
 * three. The output is cut rather than refused when it is long: a command's
 * output past the cap is still worth its first sixty thousand characters.
 */
const schema = z.object({
  outcome: z.enum(["succeeded", "failed", "denied"]),
  output: z.string().max(MAX_LOCAL_TOOL_OUTPUT_CHARS * 4),
  generationId: z.string().trim().min(8).max(120).optional(),
});

const CALL_ID = /^lft_[0-9a-f-]{36}$/;

export async function POST(req: Request, { params }: { params: Promise<{ callId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { callId } = await params;
  if (!CALL_ID.test(callId)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const delivered = deliverLocalToolResult({
    callId,
    userId: user.id,
    generationId: parsed.data.generationId,
    result: { outcome: parsed.data.outcome, output: parsed.data.output },
  });
  if (delivered !== "accepted") {
    return NextResponse.json({ error: "This call is no longer waiting for an answer." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
