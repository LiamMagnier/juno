import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { isByokProvider } from "@/lib/code-v2/byok";
import { removeProviderKey } from "@/lib/code-v2/byok-store";

export const runtime = "nodejs";

/** Remove the user's key for one lab. Idempotent: removing nothing is a 404. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { provider } = await ctx.params;
  if (!isByokProvider(provider)) return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  const removed = await removeProviderKey(user.id, provider);
  if (!removed) return NextResponse.json({ error: "No key stored for this provider." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
