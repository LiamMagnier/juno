import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { SecretInputError, revokeSecretCredential, rotateSecretCredential } from "@/lib/secrets/store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** Rotate: a new value, a new version, and every older grant stops working. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const rotated = await rotateSecretCredential({ userId: user.id, id, secret: body?.secret });
    if (!rotated) return NextResponse.json({ error: "Credential not found" }, { status: 404 });
    return NextResponse.json({ rotated: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SecretInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

/** Remove: the sealed value is overwritten and every grant revoked at once. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const revoked = await revokeSecretCredential({ userId: user.id, id });
  if (!revoked) return NextResponse.json({ error: "Credential not found" }, { status: 404 });
  return NextResponse.json({ revoked: true }, { headers: NO_STORE });
}
