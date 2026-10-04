import { NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import {
  SecretInputError,
  createSecretCredential,
  listSecretAccessEvents,
  listSecretCredentials,
  listSecretGrants,
} from "@/lib/secrets/store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** Saved credentials (never their values), task grants and the access log. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [credentials, grants, events] = await Promise.all([
    listSecretCredentials(user.id),
    listSecretGrants(user.id, { includeInactive: true }),
    listSecretAccessEvents(user.id, 100),
  ]);
  return NextResponse.json({ credentials, grants, events }, { headers: NO_STORE });
}

/** Save a credential. The value is sealed before the response; it is never echoed. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = await rateLimit({ key: `secrets:create:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) return NextResponse.json({ error: "Too many credentials saved in an hour." }, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const credential = await createSecretCredential({
      userId: user.id,
      label: body.label,
      hosts: body.hosts,
      username: body.username,
      secret: body.secret,
    });
    return NextResponse.json({ credential }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof SecretInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
