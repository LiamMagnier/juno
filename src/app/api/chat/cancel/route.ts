import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelGeneration } from "@/lib/generation-cancel";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const schema = z.object({
  generationId: z.string().trim().min(8).max(120),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const cancelled = cancelGeneration(parsed.data.generationId, user.id);
  return NextResponse.json({ ok: true, cancelled });
}
