import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { revokeSecretGrant } from "@/lib/secrets/store";

export const runtime = "nodejs";

/** Revocation is immediate: the next redemption of this grant is refused. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const revoked = await revokeSecretGrant({ userId: user.id, id });
  if (!revoked) return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  return NextResponse.json({ revoked: true }, { headers: { "Cache-Control": "private, no-store" } });
}
