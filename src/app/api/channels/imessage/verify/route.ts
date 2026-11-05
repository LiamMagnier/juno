import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { channelProvider } from "@/lib/channels/config";
import { verifyLink } from "@/lib/channels/link";
import { linkDeps } from "@/lib/channels/store";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().min(1).max(20) });

/** Finishes linking: the six digits from the text, checked in constant time against their HMAC. */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const provider = channelProvider();
  if (!provider) return NextResponse.json({ error: "not_configured", message: "iMessage is not set up on this server." }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_code", message: "Enter the six digits from the text." }, { status: 400 });
  }
  try {
    const outcome = await verifyLink(user.id, { code: parsed.data.code }, linkDeps(provider));
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    console.error("[channels] link verify failed");
    return NextResponse.json({ error: "verify_failed", message: "The code could not be checked. Try again." }, { status: 500 });
  }
}
