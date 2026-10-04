import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { workTaskKey } from "@/lib/secrets/policy";
import { SecretInputError, createSecretGrant } from "@/lib/secrets/store";

export const runtime = "nodejs";

/**
 * A person lets one task use one credential. This route — a signed-in request
 * — is the only way a grant is minted; a run has no tool that reaches it.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.credentialId !== "string" || typeof body.workSessionId !== "string") {
    return NextResponse.json({ error: "Choose a credential and a task." }, { status: 400 });
  }
  const session = await prisma.workSession.findFirst({
    where: { id: body.workSessionId, userId: user.id },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  try {
    const { grant } = await createSecretGrant({
      userId: user.id,
      credentialId: body.credentialId,
      taskKey: workTaskKey(session.id),
      hosts: body.hosts,
      scopes: body.scopes,
      ttlMs: typeof body.ttlMinutes === "number" ? body.ttlMinutes * 60_000 : undefined,
      maxUses: body.maxUses,
      grantedVia: body.via === "native" ? "native" : "web",
    });
    // The reference is deliberately not returned: the run reads it from the
    // trusted side when it starts, and a person never needs to handle it.
    return NextResponse.json({ grant }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SecretInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
